-- @param persona STRING
-- Sell-through by region for the selected identity — demonstrates the ABAC row
-- filter (ts_region_filter) applied to fact_sales on `region`.
WITH me AS (
  SELECT COALESCE(MAX(is_admin), false) AS is_admin,
         COALESCE(MAX(allowed_region), 'NONE') AS allowed_region
  FROM dante_classic_stable_catalog.tempo_scan_supply_chain.access_allowlist
  WHERE email = :persona
)
SELECT t.region,
       COUNT(*) AS orders,
       ROUND(SUM(t.net_idr)/1e9, 2) AS net_bn_idr
FROM dante_classic_stable_catalog.tempo_scan_supply_chain.fact_sales t
CROSS JOIN me
WHERE me.is_admin OR me.allowed_region = 'ALL' OR t.region = me.allowed_region
GROUP BY t.region
ORDER BY orders DESC;
