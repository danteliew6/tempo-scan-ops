# BUILD — package & replicate the Tempo Scan solution (DAB)

The whole solution is packaged as a **Declarative Automation Bundle (DAB)** so it
can be reproduced in another workspace with a handful of commands. All data is
**synthetic** — no real customer data. Everything is parameterized off bundle
variables (catalog, schema, warehouse, Lakebase project, …); the `source` target
reproduces the original build on `fevm-dante-classic-stable`, and the `replica`
target is a fill-in-the-blank template for a new workspace.

## What the bundle contains

| DAB resource (key) | File | Notes |
|---|---|---|
| Pipeline `tempo_dq_pipeline` | `resources/pipeline.yml` | bronze → silver/quarantine → curated gold (SQL in `governance/pipeline/`) |
| Job `tempo_bootstrap` | `resources/job_bootstrap.yml` | one-shot data + governance/sovereignty + metric views + ML + serving gold |
| Job `tempo_realtime_ingest` | `resources/job_realtime.yml` | near-real-time gen → DQ → gold → **refresh synced tables** (schedule PAUSED) |
| App `tempo_ops` | `resources/app.yml` | AppKit control center, deployed from bundle-synced workspace files |
| Dashboard `tempo_ops_dashboard` | `resources/dashboard.yml` | AI/BI Lakeview dashboard (`dashboard/tempo_ops_dashboard.json`) |
| Genie space `tempo_genie` | `resources/genie.yml` | NL Q&A space (`tempo_scan_data`); body inlined from `genie/genie_agent.json` at deploy. The app binds to it via `${resources.genie_spaces.tempo_genie.id}` — no manual import. |

Not DAB-native (provisioned by the replicate flow):
- **Lakebase synced tables** — created via `lakebase/setup_synced_tables.sh`
  (the DAB `synced_database_tables` resource is deprecated and fails on current
  Lakebase, so the supported `databricks postgres create-synced-table` CLI is used).

`bootstrap/run.py` is the single entrypoint for every serverless job task: it
promotes `--ts-*` task parameters into `TEMPO_*` env vars before importing
`tempo_config`, so the stage scripts (`data_gen/`, `governance/`, `ml/`,
`jobs/`, `bootstrap/`) need no job-specific code and re-point at any workspace.

### Bootstrap stages (`bootstrap/run.py <stage>`)

`gen_dims → gen_bronze → gen_facts → add_comments → run_dq_pipeline`, then in
parallel off the pipeline: `apply_governance`, `create_metric_views`,
`build_serving_gold`, `train_expiry_risk → stockout_proba`, `train_demand_forecast`.

### Metric views

`bootstrap/create_metric_views.py` creates two governed UC metric views over the
curated facts (no dashboard-owned SQL needed — they re-point via `tempo_config`):

| Metric view | Source | Measures (selected) | Dimensions |
|---|---|---|---|
| `sales_metrics` | `fact_sales` | Net/Gross Revenue IDR, Units Ordered/Fulfilled, **Fill Rate**, **Stockout Rate**, **Revenue At Risk IDR**, Order Count | Region, Province, City, Division, Brand, Category, Channel, Order Status, Is Promo, Sale Date/Month |
| `inventory_risk_metrics` | `fact_inventory` | On-Hand / At-Risk Expiry Units, **Avg Expiry Risk Score**, **Stockout Rate**, Avg Days-of-Supply / To-Expiry, SKUs At Expiry Risk | Region, Division, Brand, Distribution Center, Reading Date |

### Serving gold (Lakebase synced-table sources)

`build_serving_gold.py` runs `lakebase/build_serving_gold.sql`; the ML stage
produces `gold_product_risk` and `gold_demand_forecast`. Gold tables + PKs are
fixed in `tempo_config.SERVING_TABLES`: `gold_product_risk` `[dc_id, product_id]`,
`gold_region_daily` `[region, sales_date]`, `gold_national_daily` `[sales_date]`,
`gold_sales_serving` `[sale_id]`, `gold_demand_forecast` `[region, forecast_date]`.
Per §3 of CONTRACT.md these contain **no PII** — UC masks/row-filters do not
propagate to Lakebase.

## Prerequisites

- Databricks CLI ≥ v1.3, authenticated: `databricks auth login --host <workspace> --profile <profile>`
- `psql` (libpq) for the Lakebase SP grant
- Node 22+ / npm only for local app dev (the platform builds the app on deploy)

## Reproduce on the original workspace (`source`)

```bash
./replicate.sh --target source --profile fevm-dante-classic-stable
```

That runs, in dependency order: retarget static assets (no-op on source) → create
the Lakebase project → `bundle deploy` (pipeline, jobs, app, dashboard, **and the
Genie space**) → `bundle run tempo_bootstrap` → Lakebase synced-table setup +
app-SP grant. No manual Genie step.

## Replicate into a NEW workspace (`replica`)

1. Edit `databricks.yml` → `targets.replica`: set `workspace.host` (and, if you
   prefer, the variable defaults).
2. Run, passing the target catalog/schema/warehouse as flags — `replicate.sh`
   forwards them to the bundle as `--var` and exports the matching `TEMPO_*`
   env for the shell steps (render + Lakebase), so everything lines up:
   ```bash
   ./replicate.sh --profile <your-profile> \
       --catalog <catalog> --schema <schema> --warehouse <warehouse-id>
   ```
   (`--target replica` is the default.) The Genie space is created by the bundle
   and the app binds to it automatically — nothing manual.

> The bundle is fully parameterized; step 0 of `replicate.sh` also retargets the
> catalog-qualified content that DABs doesn't substitute for you: the app SQL
> (`config/queries/*.sql`), the dashboard JSON, and the Genie space's `data_sources`
> (`genie/genie_agent.json`) — when the replica catalog/schema differs from the original.

## Individual bundle commands

```bash
databricks bundle validate -t source --profile <profile>
databricks bundle deploy   -t source --profile <profile>
databricks bundle run tempo_bootstrap        -t source --profile <profile>
databricks bundle run tempo_realtime_ingest  -t source --profile <profile>   # on demand
```

Unpause the realtime schedule when you want it live (it only costs per run):
edit `resources/job_realtime.yml` `pause_status: UNPAUSED` and redeploy.

## Local app dev

```bash
npm install && npm run dev     # set server/.env with PGHOST/PGDATABASE/LAKEBASE_ENDPOINT for Lakebase
npm run lint && npm run typecheck
```

> Deploy the app before local Lakebase dev so the app service principal owns its
> Postgres role; `lakebase/setup_synced_tables.sh` then grants it SELECT.
