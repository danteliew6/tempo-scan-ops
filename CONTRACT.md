# Tempo Scan Demo — Build Contract (authoritative)

This is the single source of truth for the **Tempo Scan "Molecule to Shelf, Governed in
Indonesia"** demo, a full-parity adaptation of the Bluebird ride-hailing solution.
Every subsystem MUST conform to the names, columns, and behaviors here. When in doubt,
this file wins. All data is **synthetic**.

Reference implementation (read the analogous Bluebird file, then adapt to this domain):
`/Users/dante.liew/vibe_sessions/bluebird_demo/bluebird-ops/` (also copied into this repo,
pre-rebrand). Keep the *engineering pattern* identical; change the *domain*.

## 0. Customer & story

**PT Tempo Scan Group** — one of Indonesia's largest pharmaceutical + consumer-health
groups. It manufactures pharma (Rx/OTC) and consumer/personal-care brands, and distributes
them through **PT Tempo's national distribution network** to tens of thousands of retail
outlets (pharmacies, modern trade, minimarkets, hospitals).

Board-level pitch: replace a fragmented stack with **one governed lakehouse** that ingests
sell-through/shipment/inventory data, governs regulated health + personal data, **forecasts
demand**, answers questions in Bahasa/English, serves an ops app, and keeps regulated data
**resident in Indonesia** (AWS Jakarta) with full lineage — for BPOM / UU PDP.

Three stories baked into the synthetic data (analogous to Bluebird's peak-shortage +
degradation + seasonality):

1. **STOCKOUT SPIKE (headline).** In the most recent ~30 days a seasonal-demand surge (flu
   season → OTC analgesics/cough-cold: **Bodrex, Oskadon, Bodrexin, Hemaviton**) hits
   **Jawa + Sumatera**. `fact_sales.status` shifts to `backorder`/`partial` and
   `fact_inventory.stockout_flag` spikes: ~**1 in 4** high-demand SKU-days stock out →
   lost revenue. This is what the Command Center catches live.
2. **EXPIRY RISK.** ~**12%** of SKUs (short shelf-life, over-stocked in specific DCs) trend
   toward expiry write-off: `expiry_risk_score` climbs past **0.7** over the window →
   the ML target for the risk model.
3. **FORECASTABLE DEMAND.** Demand has weekly (weekday/weekend), monthly, and seasonal
   (flu) structure by region/division → the demand-forecast model.

Buyer KPIs the app must surface: **fill rate / stockout rate**, **revenue at risk from
stockouts**, **expiry write-off avoided**, **forecast-driven pre-positioning**, and
**trust/consolidation** (DQ + governance + one platform retires legacy warehouse/BI/OSS ML).

## 1. Naming (UC objects, resources, config)

- Config module: **`tempo_config`** (repo root `tempo_config.py`, already written). Import
  `CATALOG, SCHEMA, S, PROFILE, WAREHOUSE_ID, SERVING_ENDPOINT, EXPERIMENT_DIR,
  LAKEBASE_*, PG_DATABASE, SERVING_TABLES, DATA_REGION, DATA_SOVEREIGNTY, get_spark, fq`.
  `data_gen/common.py` imports the domain constants below plus `from tempo_config import ...`.
- Catalog / schema: `dante_classic_stable_catalog.tempo_scan_supply_chain`.
- UC object prefix: **`ts_`** (was `bb_`). e.g. `ts_is_privileged()`, `ts_mask_str`,
  `ts_mask_full`, `ts_region_filter`, PII tag key **`ts_pii`**.
- Bundle name: **`tempo-scan-ops`**. App: **`tempo-scan-ops`**. Genie space display name:
  **`tempo_scan_data`**. Serving endpoint: **`tempo-demand-forecast`**. Lakebase project:
  **`tempo-scan-ops-db`**. MLflow experiment dir: `/Shared/tempo_scan_ml`.
- DAB resource **keys** (logical, referenced across files — DO NOT rename without updating
  refs): pipeline `tempo_dq_pipeline`; jobs `tempo_bootstrap`, `tempo_realtime_ingest`;
  app `tempo_ops`; dashboard `tempo_ops_dashboard`; genie space `tempo_genie`
  (the app binds Genie via `${resources.genie_spaces.tempo_genie.id}`).

## 2. Data model (EXACT table + column names)

Regions = Indonesian island groups: **Jawa, Sumatera, Kalimantan, Sulawesi, Bali-Nusra**
(weights `[0.52, 0.22, 0.10, 0.09, 0.07]`, Jawa dominant). Divisions:
**Pharma-Rx, Pharma-OTC, Consumer-Health, Personal-Care**.

Brand pool (real Tempo Scan brands; synthetic data): OTC/pharma — **Bodrex, Bodrexin,
Oskadon, NEO Rheumason, Hemaviton, Contrexyn, Nonflamin**; consumer/personal-care —
**Marina, My Baby, Vitalis, Claudia, Total Care, S.O.S, Revlon (distributed)**.

### Dimensions
- **`dim_product`** — SKU catalog (~180 SKUs).
  `product_id` (`SKU-#####`), `product_name`, `brand`, `division`, `category`,
  `therapeutic_class` (pharma only, else 'n/a'), `pack_size`, `shelf_life_days` (short for
  some → expiry story), `requires_cold_chain` (bool), `bpom_reg_no`, `unit_cost_idr` (long),
  `unit_price_idr` (long), `status`.
- **`dim_distribution_center`** — PT Tempo DCs (~18), the map layer / "zone" analog.
  `dc_id` (`DC-###`), `dc_name`, `city`, `province`, `region`, `lat`, `lng`,
  `capacity_units` (long), `cold_chain_capable` (bool).
- **`dim_outlet`** — retail endpoints (~2,500), served by a DC.
  `outlet_id` (`OUT-######`), `outlet_name`, `outlet_type`
  (`pharmacy|modern_trade|minimarket|hospital|wholesaler`), `chain`, `city`, `province`,
  `region`, `dc_id`, `tier` (`A|B|C`), `status`.
- **`dim_account`** — the outlet's registered pharmacist/owner. **Holds all PII** (health-
  sector personal data → UU PDP framing).
  `account_id` (`ACC-######`), `outlet_id`, `contact_name` (PII name), `nik` (PII
  national_id, 16-digit), `email` (PII), `phone` (PII +62…), `region`, `credit_limit_idr`
  (long), `member_since` (date), `account_type`.
- **`access_allowlist`** — UNGOVERNED table powering mask/ABAC bypass. Columns exactly:
  `email STRING, allowed_region STRING, is_admin BOOLEAN`. Rows:
  - `dante.liew@databricks.com` / `ALL` / `true`
  - `national.analyst@temposcan.co.id` / `ALL` / `false`
  - `jawa.rm@temposcan.co.id` / `Jawa` / `false`
  - `sumatera.rm@temposcan.co.id` / `Sumatera` / `false`

### Facts
- **`fact_sales`** — the big fact (sell-through), ~120k rows over `HISTORY_DAYS=90`.
  `sale_id` (`SAL-########`), `product_id`, `outlet_id`, `dc_id`, `account_id`,
  `region`, `province`, `city`, `division`, `brand`, `category`,
  `order_ts` (timestamp), `ship_ts` (timestamp, null if not shipped),
  `units_ordered` (long), `units_fulfilled` (long), `unit_price_idr` (long),
  `gross_idr` (long), `discount_idr` (long), `net_idr` (long),
  `channel` (`distributor|direct|modern_trade`), `promo_flag` (int 0/1),
  `status` (`fulfilled|partial|backorder|cancelled`). ABAC row filter is on **`region`**.
- **`fact_inventory`** — DC×product×day, ~ (DCs × top SKUs × 90d). ML source (expiry/stockout).
  `dc_id`, `product_id`, `reading_date` (timestamp), `region`, `division`, `brand`,
  `on_hand_units` (long), `in_transit_units` (long), `reserved_units` (long),
  `days_of_supply` (double), `reorder_point` (long), `batch_expiry_date` (date),
  `days_to_expiry` (int), `at_risk_expiry_units` (long), `avg_daily_demand` (double),
  `stockout_flag` (int 0/1), `expiry_risk_score` (double 0..1).

### Bronze (Lakeflow ingest source; DQ story)
Mirror Bluebird's bronze approach: `data_gen/gen_bronze.py` writes a raw landing table
(e.g. **`bronze_sales_raw`**) derived from `fact_sales` with ~**8%** injected dirty rows
(null `product_id`/`region`, negative `units`, bad `status`, out-of-range price). The DQ
pipeline quarantines these. Keep the same 6-expectation structure as Bluebird.

## 3. Serving (Lakebase) gold tables — names + PKs are FIXED (see `tempo_config.SERVING_TABLES`)
- `gold_product_risk` PK `[dc_id, product_id]` — per SKU×DC: `expiry_risk_score`,
  `stockout_risk_score`, `days_to_expiry`, `on_hand_units`, `days_of_supply`,
  `recommended_action` (`expedite|redistribute|promote|hold`), plus product/region labels.
- `gold_region_daily` PK `[region, sales_date]` — daily demand, `fill_rate`, `stockout_rate`,
  `net_idr`, `revenue_at_risk_idr`, order counts.
- `gold_national_daily` PK `[sales_date]` — national roll-up KPIs by day.
- `gold_sales_serving` PK `[sale_id]` — recent sell-through rows for tables (NO PII columns).
- `gold_demand_forecast` PK `[region, forecast_date]` — forecast `forecast_units`,
  `lower`, `upper`, `division` optional; horizon ~14 days.

**Governance boundary (same as Bluebird):** UC column masks / row filters do NOT propagate
to Lakebase. Therefore serving gold tables contain **no PII** (no name/nik/email/phone) —
only non-sensitive aggregated operational state. All PII stays on the UC + Genie path, and
the app's **Sovereignty & Governance** page reads via the **SQL warehouse** so UC FGAC
applies live.

## 4. Governance & Sovereignty (the headline surface)
Extend `governance/apply_governance.py`:
- `ts_is_privileged()` → reads ungoverned `access_allowlist` `is_admin`.
- `ts_mask_str(v)` → privileged clear, else `concat('•••', right(v,2))`.
- `ts_mask_full(v)` → privileged clear, else `'REDACTED-PII'` (use for `nik`).
- `ts_region_filter(region)` → privileged/national see all; regional managers see only their
  `allowed_region`. Applied to **`fact_sales`** on `region`.
- PII tags `ts_pii` on `dim_account`: `contact_name`=name, `nik`=national_id, `email`=email,
  `phone`=phone. Masks: `contact_name/email/phone` → `ts_mask_str`, `nik` → `ts_mask_full`.
- **Sovereignty tags (NEW vs Bluebird):** set table-level tags on all tables:
  `ts_data_residency` = value of `DATA_REGION`, and `ts_data_classification` =
  `regulated-health-pii` (dim_account), `commercial-confidential` (facts + product/outlet),
  or `public-reference` (dim_distribution_center). Schema-level comment states residency.
- Grants: `USE CATALOG`, `USE SCHEMA`, `SELECT`, `EXECUTE` on schema to `account users`
  (policies still enforced per identity).
- Governance evidence for the app: lineage + audit are narrated via `system.access.*`
  (table_lineage, column_lineage, audit) where available; if not queryable, the app shows a
  documented static lineage/audit panel labeled as such. Do not fabricate live query results.

## 5. ML (the STAR — demand forecasting)
`ml/` (adapt Bluebird's three scripts):
- **`train_demand_forecast.py`** (headline) — region/division daily demand forecast. Prefer
  `ai_forecast` SQL if straightforward, else Prophet/XGBoost over `fact_sales` aggregated
  daily; write `gold_demand_forecast`. 14-day horizon with lower/upper bands.
- **`train_expiry_risk.py`** (was train_bluebird_ml) — XGBoost classifier/regressor on
  `fact_inventory` predicting `expiry_risk_score`/imminent stockout from features
  (days_of_supply, days_to_expiry, avg_daily_demand, on_hand, reorder gap, shelf_life).
  Register model + serve via Model Serving endpoint `tempo-demand-forecast` (single endpoint
  is fine; name kept generic). Produce per-SKU×DC scores feeding `gold_product_risk`.
- **`stockout_proba.py`** (was reserve_proba) — helper to score/what-if from the endpoint.
Keep MLflow registration + `@prod` alias pattern identical to Bluebird.

## 6. App (client) — pages & branding
Whitelabel **Tempo Scan** (gold wordmark). Header auto-detects a logo dropped at
`client/public/tempo-scan-logo.png` (and `.svg`), with a gold-wordmark fallback (adapt
Bluebird's `BluebirdMark`). Brand palette: Tempo Scan **gold `#A8842A`** (approx; primary),
deep neutral ink, clean white — set CSS tokens in `client/src/index.css`. NOT Bluebird blue.

Pages (map from Bluebird; keep routing/hub pattern in `App.tsx`):
- **Command Center** (`/command`) — national distribution cockpit. Map of DCs/regions
  (marker/symbol map by demand + stockout), **live stockout/backorder alert feed** for the
  recent-30d flu-season spike, auto-refresh from Lakebase, optional replay scrubber.
- **Overview** (`/overview`) — KPIs + charts (fill rate, revenue, revenue-at-risk, demand by
  division/region), served sub-second from Lakebase.
- **Demand & Inventory Forecast** (`/forecast`) ⭐ (was Fleet & Forecast) — the STAR:
  demand forecast chart by region, **at-risk SKU worklist** (expiry+stockout) from Lakebase
  with **write-back** of ops decisions, and a **live model what-if** hitting the serving
  endpoint. This is the page to make most impressive.
- **Sovereignty & Governance** (`/access`) (was Data Access) — persona switch
  (Admin / National Analyst / Jawa RM / Sumatera RM) showing **live PII masking + region
  row-filter** over the SQL-warehouse path, PLUS a **residency + lineage + classification**
  panel (AWS Jakarta, `ts_data_*` tags, UU PDP/BPOM framing). Their #1 ask — make it flashy.
- **Document Intelligence** (`/documents`) — NEW backpocket "wow": `ai_parse_document` +
  `ai_extract` over sample invoices / purchase orders / COAs / BPOM regulatory filings;
  show parsed → extracted structured fields → into a table. (Analytics/SQL-warehouse path.)
- **Ask Tempo** (`/ask`) (was Ask Bluebird) — Genie chat (EN + Bahasa) + embedded Genie room.
- **AI/BI Dashboard** (`/dashboard`) — embedded Lakeview dashboard.
- **Architecture** (`/architecture`) — end-to-end diagram + stage story, updated to this domain.

Server (`server/server.ts`) + `config/queries/*.sql` + `shared/appkit-types/*`: rename/retarget
to the tables above. Every SQL query the app runs MUST reference tables/columns from §2–3.
Overview/Command/Forecast read Lakebase gold; Sovereignty + Document Intelligence read the
SQL warehouse.

## 7. Packaging (DAB) & docs
`databricks.yml` (bundle `tempo-scan-ops`, vars mirror Bluebird with tempo defaults),
`resources/*.yml` (rename resource keys per §1), `bootstrap/run.py` (promote `--ts-*` task
params → `TEMPO_*` env), `replicate.sh`, `README.md`, `BUILD.md`. Keep the `source` target on
`fevm-dante-classic-stable`. `bootstrap/render_assets.py` retargets catalog-qualified content
(config SQL, dashboard JSON, genie `data_sources`) for the replica target.

## 8. Build discipline for subagents
- **Do NOT deploy to Databricks or run data generation.** The orchestrator (main session)
  owns auth + deploy + data-gen + Lakebase + verification. You WRITE and LOCALLY VALIDATE only.
- Local validation you SHOULD run: `npm run typecheck` and `npm run lint` (app agent, after
  `npm install`); `python3 -m py_compile <files>` (python agents); ensure SQL is
  syntactically sane. Do not start long-running servers.
- Preserve the Bluebird engineering patterns (mapInPandas gen, allowlist-bypass masks,
  synced-tables serving, bootstrap env promotion). Change domain, not architecture.
- Keep everything parameterized off `tempo_config` / DAB vars — no hard-coded workspace ids
  beyond the documented defaults.
- Report exactly which files you created/changed and any TODOs for the orchestrator.
