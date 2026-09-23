-- @param persona STRING
-- Sovereignty & Governance: what the selected identity can see over fact_sales.
-- Reads the UNGOVERNED access_allowlist to mirror the ABAC region filter + the
-- ts_is_privileged() PII rule (see governance/apply_governance.py).
WITH me AS (
  SELECT COALESCE(MAX(is_admin), false) AS is_admin,
         COALESCE(MAX(allowed_region), 'NONE') AS allowed_region
  FROM dante_classic_stable_catalog.tempo_scan_supply_chain.access_allowlist
  WHERE email = :persona
)
SELECT
  me.is_admin AS pii_visible,
  me.allowed_region AS allowed_region,
  (SELECT COUNT(*) FROM dante_classic_stable_catalog.tempo_scan_supply_chain.fact_sales t
     WHERE me.is_admin OR me.allowed_region = 'ALL' OR t.region = me.allowed_region) AS visible_sales,
  (SELECT COUNT(DISTINCT t.region) FROM dante_classic_stable_catalog.tempo_scan_supply_chain.fact_sales t
     WHERE me.is_admin OR me.allowed_region = 'ALL' OR t.region = me.allowed_region) AS visible_regions
FROM me;
