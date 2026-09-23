"""Central, env-driven configuration for the Tempo Scan supply-chain solution.

Every data / governance / ML / jobs script imports catalog, schema, warehouse and
Spark bootstrap from here so the whole solution can be re-pointed at a different
workspace by setting a handful of environment variables — the DABs bootstrap job
sets them from bundle variables (TEMPO_CATALOG=${var.catalog}, etc.).

Defaults reproduce the original `fevm-dante-classic-stable` build, so running any
script with no environment set behaves exactly as before (backward compatible).

Domain: "Molecule to Shelf, Governed in Indonesia" — PT Tempo Scan Group's
pharma + consumer-health supply chain, from manufacturing through PT Tempo's
national distribution network to retail sell-through. All data is synthetic.

Environment variables
----------------------
  TEMPO_CATALOG              UC catalog          (default: dante_classic_stable_catalog)
  TEMPO_SCHEMA               UC schema           (default: tempo_scan_supply_chain)
  TEMPO_PROFILE              CLI profile (local) (default: fevm-dante-classic-stable)
  TEMPO_WAREHOUSE_ID         SQL warehouse id    (default: 114b2f7bfa1273b1)
  TEMPO_SERVING_ENDPOINT     model serving name  (default: tempo-demand-forecast)
  TEMPO_EXPERIMENT_DIR       MLflow experiment parent dir
                             (default: /Shared/tempo_scan_ml)
  TEMPO_LAKEBASE_PROJECT     Lakebase project id (default: tempo-scan-ops-db)
  TEMPO_LAKEBASE_BRANCH      Lakebase branch resource path
  TEMPO_LAKEBASE_CATALOG     UC catalog registered over the Lakebase DB
                             (default: tempo_scan_lakebase)
  TEMPO_PG_DATABASE          Postgres database name (default: databricks_postgres)
"""
import os

CATALOG = os.environ.get("TEMPO_CATALOG", "dante_classic_stable_catalog")
SCHEMA = os.environ.get("TEMPO_SCHEMA", "tempo_scan_supply_chain")
PROFILE = os.environ.get("TEMPO_PROFILE", "fevm-dante-classic-stable")
WAREHOUSE_ID = os.environ.get("TEMPO_WAREHOUSE_ID", "114b2f7bfa1273b1")
SERVING_ENDPOINT = os.environ.get("TEMPO_SERVING_ENDPOINT", "tempo-demand-forecast")
EXPERIMENT_DIR = os.environ.get("TEMPO_EXPERIMENT_DIR", "/Shared/tempo_scan_ml")

# --- Data residency / sovereignty (narrated on the Sovereignty page) ---
# The demo workspace runs in the FEVM region, but the customer target is AWS
# Jakarta. These constants let the app + governance tags state residency intent.
DATA_REGION = os.environ.get("TEMPO_DATA_REGION", "AWS ap-southeast-3 (Jakarta)")
DATA_SOVEREIGNTY = os.environ.get("TEMPO_DATA_SOVEREIGNTY", "Indonesia (UU PDP / BPOM)")

# --- Lakebase (operational serving via synced tables) ---
LAKEBASE_PROJECT = os.environ.get("TEMPO_LAKEBASE_PROJECT", "tempo-scan-ops-db")
LAKEBASE_BRANCH = os.environ.get(
    "TEMPO_LAKEBASE_BRANCH", f"projects/{LAKEBASE_PROJECT}/branches/production"
)
LAKEBASE_CATALOG = os.environ.get("TEMPO_LAKEBASE_CATALOG", "tempo_scan_lakebase")
PG_DATABASE = os.environ.get("TEMPO_PG_DATABASE", "databricks_postgres")

# Gold tables the app serves from Lakebase (synced from UC Delta) -> primary key columns.
# Used by lakebase/setup_synced_tables.sh (create) and jobs/refresh_synced_tables.py (refresh).
SERVING_TABLES = {
    "gold_product_risk": ["dc_id", "product_id"],       # expiry + stockout risk per SKU x DC
    "gold_region_daily": ["region", "sales_date"],      # per-region daily demand / fill-rate
    "gold_national_daily": ["sales_date"],              # national KPI roll-up by day
    "gold_sales_serving": ["sale_id"],                  # recent sell-through rows
    "gold_demand_forecast": ["region", "forecast_date"],  # forecast per region
}

# Fully-qualified schema, e.g. "dante_classic_stable_catalog.tempo_scan_supply_chain"
S = f"{CATALOG}.{SCHEMA}"


def fq(table: str) -> str:
    """Fully-qualify a table/view name in the Tempo Scan schema."""
    return f"{CATALOG}.{SCHEMA}.{table}"


def _on_databricks() -> bool:
    """Heuristic: are we running on Databricks compute (job task / notebook)?"""
    return any(
        os.environ.get(v)
        for v in ("DATABRICKS_RUNTIME_VERSION", "DB_IS_DRIVER", "SPARK_HOME", "DATABRICKS_HOST_IP")
    )


def get_spark():
    """Return a SparkSession that works both on Databricks and locally.

    - On Databricks (job task / notebook), reuse/attach to the ambient session.
    - Locally, connect via Databricks Connect (serverless) using TEMPO_PROFILE.
    """
    # If a session already exists (notebook, or an earlier call), reuse it.
    try:
        from pyspark.sql import SparkSession

        active = SparkSession.getActiveSession()
        if active is not None:
            return active
        if _on_databricks():
            return SparkSession.builder.getOrCreate()
    except Exception:
        pass
    from databricks.connect import DatabricksSession

    return DatabricksSession.builder.profile(PROFILE).serverless(True).getOrCreate()
