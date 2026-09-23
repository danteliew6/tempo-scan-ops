// ============================================================================
// Tempo Scan architecture diagram — SINGLE SOURCE OF TRUTH.
// Edit this file to reconfigure the diagram: add/remove layers, nodes, edges,
// or change a node's category/detail. The Architecture page renders from here.
// ============================================================================

export type CategoryKey = 'source' | 'ingest' | 'quality' | 'govern' | 'serve';

export interface ArchNode {
  id: string;
  title: string;
  sub: string;
  icon: string; // emoji
  category: CategoryKey;
  detail: string; // shown in the inspector when the node is clicked
}

export interface ArchLayer {
  id: string;
  title: string;
  nodes: ArchNode[];
}

export interface ArchEdge {
  from: string;
  to: string;
  label?: string;
}

export const CATEGORIES: Record<CategoryKey, { label: string; color: string }> = {
  source: { label: 'Sources', color: '#64748B' },
  ingest: { label: 'Ingestion', color: '#3B7EA1' },
  quality: { label: 'Data quality', color: '#D9A441' },
  govern: { label: 'Governance', color: '#8E5AA6' },
  serve: { label: 'Serving & AI', color: '#A8842A' },
};

export const LAYERS: ArchLayer[] = [
  {
    id: 'sources',
    title: 'Sources',
    nodes: [
      { id: 'legacy_dw', title: 'Legacy Warehouse', sub: 'Federated (no migration)', icon: '🗄️', category: 'source',
        detail: 'The existing analytics warehouse (e.g. BigQuery) stays in place — queried via Lakehouse Federation while data consolidates onto the lakehouse. No rip-and-replace.' },
      { id: 'sellthrough', title: 'Sell-Through & Orders', sub: 'PT Tempo DMS / POS', icon: '🧾', category: 'source',
        detail: 'Shipment, order and retail sell-through events across the PT Tempo national distribution network — pharmacies, modern trade, minimarkets, hospitals.' },
      { id: 'inventory', title: 'Inventory & Cold-Chain', sub: 'DC + IoT sensors', icon: '🌡️', category: 'source',
        detail: 'Per-DC×product×day inventory: on-hand, in-transit, days of supply, batch expiry and cold-chain readings for regulated pharma SKUs.' },
    ],
  },
  {
    id: 'ingest',
    title: 'Ingest → Bronze',
    nodes: [
      { id: 'lakeflow_connect', title: 'Lakeflow Ingest', sub: 'Auto Loader / Connect', icon: '🔌', category: 'ingest',
        detail: 'Managed ingestion lands raw source data into the bronze layer — no self-built connectors to maintain.' },
      { id: 'bronze', title: 'Bronze', sub: 'Raw landing (~8% dirty)', icon: '🥉', category: 'ingest',
        detail: 'bronze_sales_raw — raw, schema-on-read, intentionally carries ~8% quality defects (null product_id/region, negative units, bad status) to prove the cleansing story.' },
    ],
  },
  {
    id: 'cleanse',
    title: 'Cleanse → Gold',
    nodes: [
      { id: 'dq', title: 'Lakeflow Pipeline', sub: '6 DQ expectations', icon: '✅', category: 'quality',
        detail: 'Declarative pipeline with data-quality expectations; violating rows are quarantined with a labelled reason. Pipeline metrics are monitored.' },
      { id: 'silver', title: 'Silver', sub: 'Cleansed & conformed', icon: '🥈', category: 'quality',
        detail: 'Typed, de-duplicated, conformed sell-through and inventory records that passed all quality rules.' },
      { id: 'gold', title: 'Gold Star Schema', sub: 'facts + dims', icon: '🥇', category: 'quality',
        detail: 'fact_sales, fact_inventory plus dim_product / dim_outlet / dim_account / dim_distribution_center — the analytics-ready model powering BI, Genie and ML.' },
      { id: 'metrics', title: 'Metric Views', sub: 'Governed KPIs', icon: '📐', category: 'quality',
        detail: 'Reusable, governed KPI definitions (fill rate, stockout rate, revenue at risk, expiry write-off) shared across Genie and dashboards.' },
    ],
  },
  {
    id: 'serve',
    title: 'Serve & Consume',
    nodes: [
      { id: 'genie', title: 'Genie', sub: 'NL analytics (EN/Bahasa)', icon: '💬', category: 'serve',
        detail: 'Natural-language questions over the governed gold model, in English or Bahasa Indonesia, with auto-generated SQL and visualizations (space: tempo_scan_data).' },
      { id: 'aibi', title: 'AI/BI Dashboards', sub: 'Self-service BI', icon: '📊', category: 'serve',
        detail: 'Managed Lakeview dashboards on the same governed metrics — embeddable and cross-filtered.' },
      { id: 'forecast', title: 'Forecast + Serving', sub: 'Demand + expiry/stockout risk', icon: '🤖', category: 'serve',
        detail: 'Demand-forecast model (region/division, 14-day horizon) plus a per-SKU×DC expiry/stockout risk model, served real-time via Model Serving (tempo-demand-forecast).' },
      { id: 'lakebase', title: 'Lakebase Serving', sub: 'Synced gold (OLTP)', icon: '⚡', category: 'serve',
        detail: 'Curated gold tables synced into Lakebase Postgres for sub-second operational reads and app write-back (replenishment decisions).' },
      { id: 'app', title: 'Tempo Scan App', sub: 'This ops cockpit', icon: '📦', category: 'serve',
        detail: 'The white-labeled Databricks App you are using now — native charts, Genie chat, document intelligence and live ML predictions.' },
    ],
  },
];

// Governance is cross-cutting — rendered as a band spanning the whole flow.
export const GOVERNANCE = {
  title: 'Unity Catalog — governance & sovereignty across every layer',
  points: [
    'PII column masks (contact_name / email / phone / NIK)',
    'Attribute-based row filters (region scoping)',
    'Data residency + classification tags (AWS Jakarta · UU PDP / BPOM)',
    'End-to-end lineage bronze → gold → serving, with audit',
  ],
};

export const EDGES: ArchEdge[] = [
  { from: 'legacy_dw', to: 'lakeflow_connect' },
  { from: 'sellthrough', to: 'lakeflow_connect' },
  { from: 'inventory', to: 'lakeflow_connect' },
  { from: 'lakeflow_connect', to: 'bronze' },
  { from: 'bronze', to: 'dq' },
  { from: 'dq', to: 'silver', label: 'expectations' },
  { from: 'silver', to: 'gold' },
  { from: 'gold', to: 'metrics' },
  { from: 'gold', to: 'genie' },
  { from: 'gold', to: 'aibi' },
  { from: 'gold', to: 'forecast' },
  { from: 'gold', to: 'lakebase' },
  { from: 'metrics', to: 'aibi' },
  { from: 'forecast', to: 'app' },
  { from: 'lakebase', to: 'app' },
];
