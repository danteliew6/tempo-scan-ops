-- ============================================================================
-- Tempo Scan operational-serving gold tables (fed into Lakebase Postgres)
-- ----------------------------------------------------------------------------
-- The Command Center / Overview poll live ops state continuously. Rather than
-- re-aggregate 120k sell-through rows on the SQL warehouse on every poll, we
-- pre-materialize the hot-path operational state into small gold tables and
-- sync them into Lakebase Postgres for low-latency operational reads.
--
-- The 5 serving tables (tempo_config.SERVING_TABLES) split as in the reference build:
--   gold_region_daily      <- built here (per-region daily demand / fill-rate)
--   gold_national_daily    <- built here (national KPI roll-up by day)
--   gold_sales_serving     <- built here (recent sell-through rows, NO PII)
--   gold_product_risk      <- produced by ml/train_expiry_risk.py (expiry + stockout risk)
--   gold_demand_forecast   <- produced by ml/train_demand_forecast.py (regional forecast)
-- The last two are loaded into Lakebase as-is. NONE of the serving tables carry PII
-- (no contact_name/nik/email/phone) — the governance boundary does not cross into Lakebase.
-- ============================================================================

-- Per-region daily demand + fill-rate + revenue-at-risk (all-time; small).
CREATE OR REPLACE TABLE dante_classic_stable_catalog.tempo_scan_supply_chain.gold_region_daily AS
SELECT
  region,
  sales_date,
  COUNT(*)                                                              AS orders,
  COUNT(*)                                                              AS order_count,
  SUM(units_ordered)                                                    AS units_ordered,
  SUM(units_ordered)                                                    AS demand_units,
  SUM(units_fulfilled)                                                  AS units_fulfilled,
  SUM(CASE WHEN status = 'backorder' THEN 1 ELSE 0 END)                 AS backorder_count,
  ROUND(SUM(units_fulfilled) / NULLIF(SUM(units_ordered), 0), 4)        AS fill_rate,
  ROUND(AVG(CASE WHEN is_stockout THEN 1.0 ELSE 0 END), 4)              AS stockout_rate,
  SUM(net_idr)                                                          AS net_idr,
  SUM(revenue_at_risk_idr)                                              AS revenue_at_risk_idr
FROM dante_classic_stable_catalog.tempo_scan_supply_chain.sales_curated_gold
GROUP BY 1, 2;

-- National KPI roll-up by day.
CREATE OR REPLACE TABLE dante_classic_stable_catalog.tempo_scan_supply_chain.gold_national_daily AS
SELECT
  sales_date,
  COUNT(*)                                                              AS orders,
  COUNT(*)                                                              AS order_count,
  SUM(units_ordered)                                                    AS units_ordered,
  SUM(units_ordered)                                                    AS demand_units,
  SUM(units_fulfilled)                                                  AS units_fulfilled,
  SUM(CASE WHEN status = 'backorder' THEN 1 ELSE 0 END)                 AS backorder_count,
  ROUND(SUM(units_fulfilled) / NULLIF(SUM(units_ordered), 0), 4)        AS fill_rate,
  ROUND(AVG(CASE WHEN is_stockout THEN 1.0 ELSE 0 END), 4)              AS stockout_rate,
  SUM(net_idr)                                                          AS net_idr,
  SUM(revenue_at_risk_idr)                                              AS revenue_at_risk_idr
FROM dante_classic_stable_catalog.tempo_scan_supply_chain.sales_curated_gold
GROUP BY 1;

-- Recent sell-through rows (last 45 days) for the app's tables — NO PII columns.
-- product_name is joined from dim_product (non-PII) for the app's readable tables.
CREATE OR REPLACE TABLE dante_classic_stable_catalog.tempo_scan_supply_chain.gold_sales_serving AS
SELECT
  s.sale_id, s.order_ts, s.sales_date, s.region, s.province, s.city, s.dc_id,
  s.division, s.brand, s.category, s.product_id, p.product_name, s.outlet_id,
  s.units_ordered, s.units_fulfilled, s.unit_price_idr,
  s.gross_idr, s.discount_idr, s.net_idr, s.revenue_at_risk_idr, s.channel, s.promo_flag, s.status
FROM dante_classic_stable_catalog.tempo_scan_supply_chain.sales_curated_gold s
LEFT JOIN dante_classic_stable_catalog.tempo_scan_supply_chain.dim_product p
  ON s.product_id = p.product_id
WHERE s.order_ts >= date_sub(current_date(), 45);
