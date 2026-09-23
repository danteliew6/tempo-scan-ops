-- @param persona STRING
-- Regulated health-sector PII on dim_account (contact_name / nik / email / phone).
-- Mirrors the UC column masks: ts_mask_str -> concat('•••', right(v,2)); nik uses
-- ts_mask_full -> 'REDACTED-PII'. Row scope mirrors ts_region_filter on region.
WITH me AS (
  SELECT COALESCE(MAX(is_admin), false) AS is_admin,
         COALESCE(MAX(allowed_region), 'NONE') AS allowed_region
  FROM dante_classic_stable_catalog.tempo_scan_supply_chain.access_allowlist
  WHERE email = :persona
)
SELECT
  a.account_id,
  CASE WHEN me.is_admin THEN a.contact_name ELSE concat('•••', right(a.contact_name, 2)) END AS contact_name,
  CASE WHEN me.is_admin THEN a.nik ELSE 'REDACTED-PII' END AS nik,
  CASE WHEN me.is_admin THEN a.email ELSE concat('•••', right(a.email, 2)) END AS email,
  CASE WHEN me.is_admin THEN a.phone ELSE concat('•••', right(a.phone, 2)) END AS phone,
  a.region,
  a.outlet_id,
  a.account_type
FROM dante_classic_stable_catalog.tempo_scan_supply_chain.dim_account a
CROSS JOIN me
WHERE me.is_admin OR me.allowed_region = 'ALL' OR a.region = me.allowed_region
ORDER BY a.account_id
LIMIT 100;
