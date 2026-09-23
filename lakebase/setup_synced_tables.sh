#!/usr/bin/env bash
# ============================================================================
# Lakebase operational serving via SYNCED TABLES (Delta -> Lakebase Postgres).
# ----------------------------------------------------------------------------
# We register the Lakebase database as a UC catalog and create managed synced
# tables that keep the app's read tables in sync with the Delta gold layer.
#
# The app reads these synced tables from `public.*` (read-only in Postgres) and
# writes its own operational decisions to the app-owned `ops.*` schema — the
# read/write split is unchanged.
#
# Idempotent: safe to re-run. SNAPSHOT mode (no CDF required); the realtime job
# re-triggers each synced table's pipeline via jobs/refresh_synced_tables.py.
#
# Config comes from env (TEMPO_*) with the original build's values as defaults;
# pass --profile <name> for the target workspace. The synced-table set mirrors
# tempo_config.SERVING_TABLES.
# ============================================================================
set -euo pipefail

PROFILE="${TEMPO_PROFILE:-fevm-dante-classic-stable}"
PHASE="all"   # all | project | sync
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --phase)   PHASE="$2"; shift 2 ;;   # project: only create the Lakebase project
                                        # sync:    register catalog + synced tables + grant
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

CATALOG="${TEMPO_CATALOG:-dante_classic_stable_catalog}"
SCHEMA="${TEMPO_SCHEMA:-tempo_scan_supply_chain}"
PROJECT="${TEMPO_LAKEBASE_PROJECT:-tempo-scan-ops-db}"
BRANCH="${TEMPO_LAKEBASE_BRANCH:-projects/${PROJECT}/branches/production}"
LB_CATALOG="${TEMPO_LAKEBASE_CATALOG:-tempo_scan_lakebase}"
PG_DATABASE="${TEMPO_PG_DATABASE:-databricks_postgres}"
APP_NAME="${TEMPO_APP_NAME:-tempo-scan-ops}"
SRC="${CATALOG}.${SCHEMA}"

db() { databricks --profile "$PROFILE" "$@"; }

echo "==> Lakebase synced-table setup (profile=$PROFILE, project=$PROJECT, lb_catalog=$LB_CATALOG)"

# ---- 1. Lakebase Autoscaling project (create if missing) -------------------
if db postgres get-project "projects/${PROJECT}" >/dev/null 2>&1; then
  echo "    project projects/${PROJECT} exists"
else
  echo "    creating project projects/${PROJECT} ..."
  db postgres create-project "$PROJECT" --json '{"spec":{"display_name":"Tempo Scan Ops (Lakebase)"}}'
fi

if [[ "$PHASE" == "project" ]]; then
  echo "==> phase=project done (project ensured; run --phase sync after the bootstrap job)."
  exit 0
fi

# ---- 2. Register the Lakebase DB as a UC catalog (once) --------------------
if db catalogs get "$LB_CATALOG" >/dev/null 2>&1; then
  echo "    UC catalog $LB_CATALOG exists"
else
  echo "    registering Lakebase UC catalog $LB_CATALOG ..."
  db postgres create-catalog "$LB_CATALOG" --json "$(cat <<JSON
{"spec": {"postgres_database": "${PG_DATABASE}", "branch": "${BRANCH}"}}
JSON
)"
fi

# ---- 3. Synced tables (Delta gold -> Lakebase Postgres, SNAPSHOT) ----------
# storage_catalog must be a REGULAR UC catalog for the managed sync pipeline
# metadata (NOT the Lakebase catalog) — we use the Tempo Scan catalog.
sync_table() {
  local tbl="$1"; shift
  local pk_json="$1"; shift   # e.g. '["dc_id","product_id"]'
  local full="${LB_CATALOG}.public.${tbl}"
  if db postgres get-synced-table "synced_tables/${full}" >/dev/null 2>&1; then
    echo "    synced table ${full} exists — skipping create"
    return 0
  fi
  echo "    creating synced table ${full} (SNAPSHOT) from ${SRC}.${tbl} ..."
  db postgres create-synced-table "$full" --json "$(cat <<JSON
{
  "spec": {
    "source_table_full_name": "${SRC}.${tbl}",
    "primary_key_columns": ${pk_json},
    "scheduling_policy": "SNAPSHOT",
    "branch": "${BRANCH}",
    "postgres_database": "${PG_DATABASE}",
    "create_database_objects_if_missing": true,
    "new_pipeline_spec": {"storage_catalog": "${CATALOG}", "storage_schema": "${SCHEMA}"}
  }
}
JSON
)"
}

# Mirrors tempo_config.SERVING_TABLES (table -> primary key columns).
sync_table gold_product_risk    '["dc_id","product_id"]'
sync_table gold_region_daily    '["region","sales_date"]'
sync_table gold_national_daily  '["sales_date"]'
sync_table gold_sales_serving   '["sale_id"]'
sync_table gold_demand_forecast '["region","forecast_date"]'

# ---- 4. Grant the app's service principal read access ----------------------
# The app SP needs SELECT on the synced tables in public. Requires the app to
# be deployed already (so its SP + Postgres role exist). Skipped with a warning
# if the app isn't found yet — re-run this script after `bundle deploy`.
SP_CLIENT_ID="$(db apps get "$APP_NAME" -o json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("service_principal_client_id",""))' 2>/dev/null || true)"
if [[ -n "${SP_CLIENT_ID:-}" ]]; then
  echo "    granting SELECT on public.* to app SP ${SP_CLIENT_ID} ..."
  EP="${BRANCH}/endpoints/primary"
  HOST="$(db postgres get-endpoint "$EP" -o json | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"]["hosts"]["host"])')"
  TOKEN="$(db postgres generate-database-credential "$EP" -o json | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
  PGUSER="$(db current-user me -o json | python3 -c 'import json,sys;print(json.load(sys.stdin)["userName"])')"
  PGPASSWORD="$TOKEN" psql "host=$HOST user=$PGUSER dbname=$PG_DATABASE sslmode=require" <<SQL
GRANT USAGE ON SCHEMA public TO "${SP_CLIENT_ID}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${SP_CLIENT_ID}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${SP_CLIENT_ID}";
SQL
  echo "    grants applied."
else
  echo "    WARN: app '$APP_NAME' not found — deploy the app first, then re-run this script to grant the SP SELECT."
fi

echo "==> Lakebase synced-table setup complete."
