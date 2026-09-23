"""Load the serving-gold tables directly into Lakebase Postgres (public.*).

Fallback for workspaces where the managed synced-table path is unavailable (it
requires CREATE CATALOG on the metastore to register the Lakebase DB as a UC
catalog). This reads each gold Delta table via Spark and COPYs it into Postgres
so the app's low-latency reads work unchanged. Also grants the app SP SELECT.

Usage: python3 lakebase/load_postgres_direct.py [app_name]
"""
import csv
import os
import subprocess
import sys
import tempfile

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from tempo_config import (PROFILE, PG_DATABASE, LAKEBASE_BRANCH, SERVING_TABLES,
                          get_spark, fq)

APP_NAME = sys.argv[1] if len(sys.argv) > 1 else "tempo-scan-ops"
PSQL = "/opt/homebrew/opt/libpq/bin/psql"
EP = f"{LAKEBASE_BRANCH}/endpoints/primary"

_SPARK_TO_PG = {
    "string": "text", "boolean": "boolean", "double": "double precision",
    "float": "real", "bigint": "bigint", "long": "bigint", "int": "integer",
    "integer": "integer", "timestamp": "timestamp", "date": "date",
    "smallint": "smallint", "tinyint": "smallint",
}


def _db(*args):
    return subprocess.check_output(["databricks", *args, "-p", PROFILE, "-o", "json"]).decode()


def main():
    import json
    host = json.loads(_db("postgres", "get-endpoint", EP))["status"]["hosts"]["host"]
    token = json.loads(_db("postgres", "generate-database-credential", EP))["token"]
    pguser = json.loads(_db("current-user", "me"))["userName"]
    sp = json.loads(_db("apps", "get", APP_NAME)).get("service_principal_client_id", "")
    conn = f"host={host} user={pguser} dbname={PG_DATABASE} sslmode=require"
    env = {**os.environ, "PGPASSWORD": token}

    def psql(sql):
        subprocess.run([PSQL, conn, "-v", "ON_ERROR_STOP=1", "-c", sql], env=env, check=True)

    spark = get_spark()
    for tbl in SERVING_TABLES:
        df = spark.table(fq(tbl))
        cols = [(f.name, _SPARK_TO_PG.get(f.dataType.simpleString(), "text")) for f in df.schema.fields]
        ddl_cols = ", ".join(f'"{n}" {t}' for n, t in cols)
        pdf = df.toPandas()
        fd, path = tempfile.mkstemp(suffix=".csv")
        os.close(fd)
        pdf.to_csv(path, index=False, header=True, quoting=csv.QUOTE_MINIMAL, na_rep="")
        psql(f'DROP TABLE IF EXISTS public."{tbl}" CASCADE; CREATE TABLE public."{tbl}" ({ddl_cols});')
        col_list = ", ".join(f'"{n}"' for n, _ in cols)
        subprocess.run(
            [PSQL, conn, "-v", "ON_ERROR_STOP=1",
             "-c", f'\\copy public."{tbl}" ({col_list}) FROM \'{path}\' WITH (FORMAT csv, HEADER true, NULL \'\')'],
            env=env, check=True)
        os.remove(path)
        print(f"loaded public.{tbl}: {len(pdf)} rows")

    if sp:
        psql(f'GRANT USAGE ON SCHEMA public TO "{sp}"; '
             f'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "{sp}"; '
             f'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "{sp}";')
        print(f"granted SELECT on public.* to app SP {sp}")
    else:
        print("WARN: app SP not found; skipped grant")
    print("LAKEBASE DIRECT LOAD DONE")


if __name__ == "__main__":
    main()
