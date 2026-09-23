# Tempo Scan — Molecule to Shelf, Governed in Indonesia

An end-to-end Databricks prototype for **PT Tempo Scan Group**, one of Indonesia's largest
**pharmaceutical + consumer-health** manufacturers and distributors. It replaces a fragmented
stack (separate warehouse + BI + self-built OSS ML, monitoring and governance) with a single
governed lakehouse that ingests sell-through / shipment / inventory data, governs regulated
health + personal data, **forecasts demand**, answers questions in Bahasa/English, serves an
ops app, and keeps regulated data **resident in Indonesia** (AWS Jakarta) with full lineage —
for **BPOM** and **UU PDP**. All data is **synthetic**.

> **Reproduce the build:** [BUILD.md](./BUILD.md)
>
> **Replicate the whole thing in another workspace (one command):** the solution is
> packaged as a **Declarative Automation Bundle** ([`databricks.yml`](./databricks.yml) +
> [`resources/`](./resources)). Pipeline, jobs, app, dashboard and the Genie space are DAB
> resources; a single bootstrap job reproduces the data journey; Lakebase serving uses
> **synced tables**; the app binds to the DAB-managed Genie space automatically.
> ```bash
> ./replicate.sh --profile <target-profile> --catalog <c> --schema <s> --warehouse <id>
> ```
> See [BUILD.md](./BUILD.md) for the full flow.

---

## The customer problem (specific, not "improve operations")

Tempo Scan's stack is siloed, so it fails when it matters. Three stories are baked into the
synthetic data:

1. **Stockout spike (headline).** In the most recent ~30 days a seasonal flu-season surge in
   OTC analgesics / cough-cold (**Bodrex, Oskadon, Bodrexin, Hemaviton**) hits **Jawa** and
   **Sumatera**. Orders shift to `backorder` / `partial` and ~**1 in 4** high-demand SKU-days
   stock out → lost revenue. This is what the Command Center catches live.
2. **Expiry risk.** ~**12%** of SKUs (short shelf-life, over-stocked in specific DCs) trend
   toward expiry write-off as `expiry_risk_score` climbs past **0.7** — the ML risk target.
3. **Forecastable demand.** Demand has weekly, monthly and seasonal (flu) structure by
   region / division — the demand-forecast model's job.

There is no single governed view to react in time, no predictive signal for expiry/stockout,
and regulated health + personal data (pharmacist NIK, contact, credit terms) sits ungoverned.

## The solution — an integrated journey on one platform

| # | Stage | What it does here | Code |
|---|-------|-------------------|------|
| 1 | **Lakeflow + DQ** | Ingest raw synthetic sell-through (near-real-time via a scheduled **Lakeflow Job**); 6 DQ expectations; quarantine ~8% dirty rows; curate gold | [`governance/pipeline/`](./governance/pipeline), [`data_gen/`](./data_gen), [`jobs/`](./jobs) |
| 2 | **Unity Catalog + Sovereignty** | Tag PII (`ts_pii`), mask columns, region-scoped ABAC row filter, admin allowlist bypass; **data-residency + classification tags** (`ts_data_residency`, `ts_data_classification`) for UU PDP / BPOM | [`governance/apply_governance.py`](./governance/apply_governance.py) |
| 3 | **ML / AI** ⭐ | Region/division **demand forecast** (14-day, lower/upper bands) + XGBoost **expiry/stockout risk** model, served via Model Serving `tempo-demand-forecast` | [`ml/`](./ml) |
| 4 | **Genie** | Natural-language Q&A (EN + Bahasa) over governed tables | [`genie/genie_agent.json`](./genie/genie_agent.json) |
| 5 | **Lakebase** | Curated gold synced into Lakebase Postgres via **synced tables** (Delta → Postgres); served to the app at OLTP latency; **write-back** of ops decisions | [`lakebase/`](./lakebase) |
| 6 | **Databricks App** | AppKit React ops console; Command Center / Overview / Forecast served sub-second from Lakebase; **Document Intelligence** back-pocket (`ai_parse_document` + `ai_extract` over invoices / POs / COAs / BPOM filings) | [`client/`](./client), [`server/`](./server) |

## Business outcome (buyer KPIs)

- **Fill rate / stockout rate** — pre-position stock from the demand forecast + live Command
  Center alerts to cut the flu-season stockout spike.
- **Revenue at risk from stockouts** — recovered fulfilled orders flow straight to the top line.
- **Expiry write-off avoided** — the risk model flags at-risk SKU×DCs for expedite /
  redistribute / promote before write-off.
- **Forecast-driven pre-positioning** — demand forecast by region/division drives DC stocking.
- **Trust + consolidation + sovereignty** — DQ + governance make the numbers trustworthy;
  one platform retires the legacy warehouse / BI / OSS ML, and regulated data stays resident
  in Indonesia (AWS Jakarta) with full lineage.

## The app (Stage 6)

AppKit React + Express app, deployed from bundle-synced workspace files to Databricks Apps.
Pages:

- **Command Center** (`/command`) — national distribution cockpit: DC/region map by demand +
  stockout, live stockout/backorder alert feed for the recent-30d flu-season spike,
  auto-refresh from Lakebase.
- **Overview** (`/overview`) — KPIs + charts (fill rate, revenue, revenue-at-risk, demand by
  division/region), served sub-second from Lakebase.
- **Demand & Inventory Forecast** (`/forecast`) ⭐ — the star: demand forecast by region,
  at-risk SKU worklist (expiry + stockout) with **write-back**, and a **live model what-if**
  hitting the serving endpoint.
- **Sovereignty & Governance** (`/access`) — persona switch (Admin / National Analyst / Jawa RM
  / Sumatera RM) showing **live PII masking + region row-filter** over the SQL-warehouse path,
  plus a **residency + lineage + classification** panel (AWS Jakarta, `ts_data_*` tags,
  UU PDP / BPOM framing).
- **Document Intelligence** (`/documents`) — `ai_parse_document` + `ai_extract` over sample
  invoices / purchase orders / COAs / BPOM filings → parsed → extracted structured fields.
- **Ask Tempo** (`/ask`) — Genie chat (EN + Bahasa) + embedded Genie room.
- **AI/BI Dashboard** (`/dashboard`) — embedded Lakeview dashboard.
- **Architecture** (`/architecture`) — end-to-end diagram + stage story.

**Data access split:** operational/overview reads are served from **Lakebase Postgres**
(sub-second, no warehouse cold-start); the Sovereignty & Governance and Document Intelligence
pages stay on the **SQL warehouse** because Unity Catalog column-masks and row-filters don't
propagate to Lakebase — those pages must show governance live.

## Where things live

```
data_gen/    Lakeflow ingest source (synthetic sell-through)   genie/      Genie space config
governance/  UC governance + sovereignty + DQ pipeline SQL     lakebase/   gold build + Postgres load
ml/          demand forecast + expiry/stockout risk            dashboard/  AI/BI dashboard + SQL
jobs/        real-time ingestion Lakeflow Job scripts          bootstrap/  DAB job entrypoint + tasks
client/ server/ shared/ config/   the AppKit app               resources/  DAB resource definitions
```

### Real-time ingestion (Lakeflow Job)

`tempo-realtime-ingest` (scheduled every 10 min, **paused by default**) runs the near-real-time
loop: **append a fresh synthetic micro-batch** (current-time orders) → **run the DQ pipeline** →
**rebuild serving gold** → **refresh the Lakebase synced tables**. This replaces the app's
simulated clock with data that genuinely advances — see [BUILD.md](./BUILD.md).

**Workspace:** `fevm-dante-classic-stable` · **Catalog/schema:**
`dante_classic_stable_catalog.tempo_scan_supply_chain` · **Data is synthetic** — no real
customer data.
