-- Tempo Scan Lakeflow pipeline — bronze -> silver (DQ expectations) -> gold.
-- Demonstrates the "data cleansing + pipeline monitoring" story: ~8% of raw sell-through
-- events violate a quality rule and are dropped (and captured in a quarantine table), with
-- per-expectation pass/fail metrics visible in the pipeline event log.

-- ============================ SILVER (typed + expectations) ============================
CREATE OR REFRESH STREAMING TABLE sales_silver
(
  CONSTRAINT valid_product   EXPECT (product_id IS NOT NULL)                                          ON VIOLATION DROP ROW,
  CONSTRAINT valid_region    EXPECT (region IS NOT NULL)                                              ON VIOLATION DROP ROW,
  CONSTRAINT valid_units     EXPECT (units_ordered >= 0)                                              ON VIOLATION DROP ROW,
  CONSTRAINT valid_status    EXPECT (status IN ('fulfilled','partial','backorder','cancelled'))       ON VIOLATION DROP ROW,
  CONSTRAINT valid_price     EXPECT (unit_price_idr > 0)                                              ON VIOLATION DROP ROW,
  CONSTRAINT valid_order_ts  EXPECT (order_ts IS NOT NULL)                                            ON VIOLATION DROP ROW
)
COMMENT 'Cleansed, typed sell-through orders. Rows violating any DQ rule are dropped (see sales_quarantine).'
AS SELECT
  sale_id, product_id, outlet_id, dc_id, account_id,
  region, province, city, division, brand, category,
  to_timestamp(order_ts)                   AS order_ts,
  to_timestamp(ship_ts)                    AS ship_ts,
  try_cast(units_ordered    AS BIGINT)     AS units_ordered,
  try_cast(units_fulfilled  AS BIGINT)     AS units_fulfilled,
  try_cast(unit_price_idr   AS BIGINT)     AS unit_price_idr,
  try_cast(gross_idr        AS BIGINT)     AS gross_idr,
  try_cast(discount_idr     AS BIGINT)     AS discount_idr,
  try_cast(net_idr          AS BIGINT)     AS net_idr,
  channel,
  try_cast(promo_flag       AS INT)        AS promo_flag,
  status
FROM STREAM(bronze_sales_raw);

-- ============================ QUARANTINE (rejected rows + reason) ============================
CREATE OR REFRESH STREAMING TABLE sales_quarantine
COMMENT 'Rows rejected by data-quality rules, labelled with the failure reason.'
AS SELECT
  *,
  CASE
    WHEN product_id IS NULL                                                            THEN 'null_product'
    WHEN region IS NULL                                                                THEN 'null_region'
    WHEN to_timestamp(order_ts) IS NULL                                                THEN 'malformed_timestamp'
    WHEN try_cast(units_ordered AS BIGINT) < 0                                          THEN 'negative_units'
    WHEN status NOT IN ('fulfilled','partial','backorder','cancelled')                  THEN 'invalid_status'
    WHEN try_cast(unit_price_idr AS BIGINT) <= 0                                        THEN 'out_of_range_price'
    ELSE 'other'
  END AS reject_reason,
  current_timestamp() AS quarantined_at
FROM STREAM(bronze_sales_raw)
WHERE product_id IS NULL
   OR region IS NULL
   OR to_timestamp(order_ts) IS NULL
   OR try_cast(units_ordered AS BIGINT) < 0
   OR status NOT IN ('fulfilled','partial','backorder','cancelled')
   OR try_cast(unit_price_idr AS BIGINT) <= 0;

-- ============================ GOLD: curated (dedup + derived) ============================
CREATE OR REFRESH MATERIALIZED VIEW sales_curated_gold
COMMENT 'Clean, de-duplicated sell-through with derived revenue-at-risk and stockout flags.'
AS SELECT * EXCEPT (rn) FROM (
  SELECT
    *,
    to_date(order_ts)                                                              AS sales_date,
    (order_ts >= date_sub(current_timestamp(), 30))                                AS is_recent_30d,
    (status IN ('backorder','partial'))                                            AS is_stockout,
    CASE WHEN status IN ('backorder','partial')
         THEN GREATEST(units_ordered - units_fulfilled, 0) * unit_price_idr
         ELSE 0 END                                                                AS revenue_at_risk_idr,
    row_number() OVER (PARTITION BY sale_id ORDER BY order_ts) AS rn
  FROM sales_silver
) WHERE rn = 1;

-- ============================ GOLD: daily region x division KPI summary ============================
CREATE OR REFRESH MATERIALIZED VIEW sales_daily_gold
COMMENT 'Daily region x division KPI summary from curated sell-through (for monitoring / dashboard).'
AS SELECT
  sales_date,
  region,
  division,
  count(*)                                                                  AS orders,
  sum(units_ordered)                                                        AS units_ordered,
  sum(units_fulfilled)                                                      AS units_fulfilled,
  round(sum(units_fulfilled) / NULLIF(sum(units_ordered), 0), 4)            AS fill_rate,
  round(avg(CASE WHEN is_stockout THEN 1.0 ELSE 0 END), 4)                  AS stockout_rate,
  sum(net_idr)                                                              AS net_idr,
  sum(revenue_at_risk_idr)                                                  AS revenue_at_risk_idr
FROM sales_curated_gold
GROUP BY 1, 2, 3;
