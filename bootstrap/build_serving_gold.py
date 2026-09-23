"""Bootstrap task — build the operational-serving gold tables.

Reads lakebase/build_serving_gold.sql, re-points it at the configured
catalog.schema, and runs each statement. These small gold tables
(gold_region_daily, gold_national_daily, gold_sales_serving) are what the
Lakebase synced tables copy into Postgres for the app's low-latency operational
reads (see lakebase/setup_synced_tables.sh). gold_product_risk and
gold_demand_forecast are produced by the ML stage.

Runs as a serverless spark_python_task in the DABs bootstrap job.
"""
import os
import re
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tempo_config import S, get_spark  # noqa: E402

_ORIGIN = "dante_classic_stable_catalog.tempo_scan_supply_chain"
_SQL_FILE = os.path.join(_REPO_ROOT, "lakebase", "build_serving_gold.sql")


def statements(sql: str):
    """Split a multi-statement SQL file on ';', dropping comments/blank lines.

    Comments are stripped BEFORE splitting on ';' — a ';' inside a `-- ...`
    comment (e.g. "(all-time; small)") must not fragment a statement.
    """
    no_comments = re.sub(r"--[^\n]*", "", sql)  # strip -- to end-of-line comments
    for raw in no_comments.split(";"):
        stmt = raw.strip()
        if stmt:
            yield stmt


def main():
    spark = get_spark()
    with open(_SQL_FILE) as f:
        sql = f.read().replace(_ORIGIN, S)
    for i, stmt in enumerate(statements(sql), 1):
        print(f"[serving-gold] statement {i} ...")
        spark.sql(stmt)
    print(f"[serving-gold] done, target schema {S}")


if __name__ == "__main__":
    main()
