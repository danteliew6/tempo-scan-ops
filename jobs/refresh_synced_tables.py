"""Refresh the Lakebase synced tables after a real-time ingest cycle (Lakeflow Job task).

Lakebase **synced tables** are the supported Delta -> Postgres path: each synced table
is backed by a managed Lakeflow pipeline, so "refreshing" the served copy just means
triggering that pipeline. This task does exactly that for every table the app reads at
OLTP latency (tempo_config.SERVING_TABLES):

    {LAKEBASE_CATALOG}.public.gold_product_risk
    {LAKEBASE_CATALOG}.public.gold_region_daily
    {LAKEBASE_CATALOG}.public.gold_national_daily
    {LAKEBASE_CATALOG}.public.gold_sales_serving
    {LAKEBASE_CATALOG}.public.gold_demand_forecast

No Spark and no native Postgres driver — pure Databricks SDK / REST. Per-table failures
are logged and skipped so one bad table never fails the whole run.
"""
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from tempo_config import LAKEBASE_CATALOG, SERVING_TABLES  # noqa: E402

from databricks.sdk import WorkspaceClient

TABLES = list(SERVING_TABLES)

w = WorkspaceClient()


def _pipeline_id_for(synced_full_name: str):
    """Read the synced table's backing pipeline id via the typed SDK getter.

    Uses ``w.database.get_synced_database_table`` (present in the installed SDK) and
    probes the common field paths on the returned object's dict, since the exact
    location of the backing pipeline id has shifted across releases.
    """
    st = w.database.get_synced_database_table(name=synced_full_name)
    resp = st.as_dict() if hasattr(st, "as_dict") else dict(st)
    # Try known locations for the backing pipeline id.
    candidates = [
        resp.get("data_synchronization_status", {}).get("pipeline_id"),
        resp.get("pipeline_id"),
        resp.get("spec", {}).get("pipeline_id"),
        resp.get("status", {}).get("pipeline_id"),
    ]
    for pid in candidates:
        if pid:
            return pid
    print(f"  ! could not find pipeline_id in response for {synced_full_name}: {resp}")
    return None


refreshed = 0
for name in TABLES:
    full = f"{LAKEBASE_CATALOG}.public.{name}"
    try:
        pid = _pipeline_id_for(full)
        if not pid:
            print(f"SKIP {full}: no backing pipeline id (is it created / ONLINE yet?)")
            continue
        w.pipelines.start_update(pipeline_id=pid)
        refreshed += 1
        print(f"REFRESH {full}: triggered sync pipeline {pid}")
    except Exception as e:  # noqa: BLE001 — one bad table must not fail the run
        print(f"WARN {full}: refresh failed ({type(e).__name__}: {e})")

print(f"Triggered refresh on {refreshed}/{len(TABLES)} Lakebase synced tables.")
