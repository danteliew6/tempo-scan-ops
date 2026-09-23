"""Phase 2 — Unity Catalog governance + sovereignty for Tempo Scan.

 - PII classification tags (custom key `ts_pii`) on dim_account
 - Column masks on PII via allowlist-UDF bypass
 - Region-scoped row filter on fact_sales
 - Data-sovereignty tags (ts_data_residency, ts_data_classification) on every table
 - Schema grants for account users (Genie / dashboard / app SP read with policies enforced)

Pattern (per workspace constraints): masks/filters reference the UNGOVERNED
access_allowlist so they don't trip the "nested governed reference" restriction,
and privilege is decided by current_user() against that allowlist.
"""
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tempo_config import CATALOG, SCHEMA, S, DATA_REGION, DATA_SOVEREIGNTY, get_spark, fq  # noqa: E402,F401

spark = get_spark()

# Data-classification per table (sovereignty story):
#   regulated-health-pii     -> dim_account
#   commercial-confidential  -> facts + product / outlet
#   public-reference         -> dim_distribution_center
CLASSIFICATION = {
    "dim_account": "regulated-health-pii",
    "fact_sales": "commercial-confidential",
    "fact_inventory": "commercial-confidential",
    "dim_product": "commercial-confidential",
    "dim_outlet": "commercial-confidential",
    "dim_distribution_center": "public-reference",
}

stmts = [
    # ---------- privilege helper (reads ungoverned allowlist) ----------
    f"""CREATE OR REPLACE FUNCTION {S}.ts_is_privileged()
        RETURNS BOOLEAN
        COMMENT 'True for national/admin identities in the ungoverned access allowlist'
        RETURN current_user() IN (SELECT email FROM {fq('access_allowlist')} WHERE is_admin = true)""",

    # ---------- mask functions ----------
    f"""CREATE OR REPLACE FUNCTION {S}.ts_mask_str(v STRING)
        RETURNS STRING
        COMMENT 'Partial mask: privileged sees clear, others see bullets + last 2 chars'
        RETURN CASE WHEN {S}.ts_is_privileged() THEN v
                    WHEN v IS NULL THEN NULL
                    ELSE concat('•••', right(v, 2)) END""",
    f"""CREATE OR REPLACE FUNCTION {S}.ts_mask_full(v STRING)
        RETURNS STRING
        COMMENT 'Full redaction for high-sensitivity PII (e.g. NIK)'
        RETURN CASE WHEN {S}.ts_is_privileged() THEN v ELSE 'REDACTED-PII' END""",

    # ---------- region-scoped row-filter function ----------
    f"""CREATE OR REPLACE FUNCTION {S}.ts_region_filter(row_region STRING)
        RETURNS BOOLEAN
        COMMENT 'Row filter: privileged/national see all; regional managers see only their region'
        RETURN {S}.ts_is_privileged()
            OR EXISTS (SELECT 1 FROM {fq('access_allowlist')} a
                       WHERE a.email = current_user()
                         AND (a.allowed_region = 'ALL' OR a.allowed_region = row_region))""",

    # ---------- PII classification tags (custom key ts_pii) ----------
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN contact_name SET TAGS ('ts_pii' = 'name')",
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN nik SET TAGS ('ts_pii' = 'national_id')",
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN email SET TAGS ('ts_pii' = 'email')",
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN phone SET TAGS ('ts_pii' = 'phone')",

    # ---------- apply column masks ----------
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN contact_name SET MASK {S}.ts_mask_str",
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN email SET MASK {S}.ts_mask_str",
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN phone SET MASK {S}.ts_mask_str",
    f"ALTER TABLE {fq('dim_account')} ALTER COLUMN nik SET MASK {S}.ts_mask_full",

    # ---------- apply row filter (ABAC on region) ----------
    f"ALTER TABLE {fq('fact_sales')} SET ROW FILTER {S}.ts_region_filter ON (region)",

    # ---------- schema-level residency comment ----------
    f"COMMENT ON SCHEMA {S} IS 'PT Tempo Scan supply chain — data resident in "
    f"{DATA_REGION}; sovereignty: {DATA_SOVEREIGNTY}. All data synthetic.'",

    # ---------- grants (policies still enforced per identity) ----------
    f"GRANT USE CATALOG ON CATALOG {CATALOG} TO `account users`",
    f"GRANT USE SCHEMA ON SCHEMA {S} TO `account users`",
    f"GRANT SELECT ON SCHEMA {S} TO `account users`",
    f"GRANT EXECUTE ON SCHEMA {S} TO `account users`",
]

# ---------- sovereignty tags on every table (residency + classification) ----------
for t, classification in CLASSIFICATION.items():
    stmts.append(
        f"ALTER TABLE {fq(t)} SET TAGS ('ts_data_residency' = '{DATA_REGION}', "
        f"'ts_data_classification' = '{classification}')")

for i, s in enumerate(stmts, 1):
    label = " ".join(s.split())[:80]
    try:
        spark.sql(s)
        print(f"[{i:02d}] OK  {label}")
    except Exception as e:
        print(f"[{i:02d}] ERR {label}\n      -> {str(e).splitlines()[0][:160]}")

print("GOVERNANCE DONE")
