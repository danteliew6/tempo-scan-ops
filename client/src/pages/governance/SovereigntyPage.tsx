import {
  useAnalyticsQuery,
  BarChart,
  DataTable,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Badge,
  Alert,
  AlertDescription,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { MapPin, ShieldCheck, GitBranch, Tags, FileLock2 } from 'lucide-react';

// Data residency / sovereignty constants — mirror tempo_config.DATA_REGION /
// DATA_SOVEREIGNTY. The customer target is AWS Jakarta; regulated by UU PDP / BPOM.
const DATA_REGION = 'AWS ap-southeast-3 (Jakarta)';
const DATA_SOVEREIGNTY = 'Indonesia (UU PDP / BPOM)';

interface Persona {
  key: string;
  email: string;
  label: string;
  role: string;
  scope: string;
}

// Matches the ungoverned access_allowlist rows (CONTRACT §2).
const PERSONAS: Persona[] = [
  { key: 'admin', email: 'dante.liew@databricks.com', label: 'Admin', role: 'Platform admin', scope: 'All regions · clear PII' },
  { key: 'analyst', email: 'national.analyst@temposcan.co.id', label: 'National Analyst', role: 'HQ analytics', scope: 'All regions · masked PII' },
  { key: 'jawa', email: 'jawa.rm@temposcan.co.id', label: 'Jawa RM', role: 'Regional manager', scope: 'Jawa only · masked PII' },
  { key: 'sumatera', email: 'sumatera.rm@temposcan.co.id', label: 'Sumatera RM', role: 'Regional manager', scope: 'Sumatera only · masked PII' },
];

// Table-level classification tags (ts_data_classification) applied in governance/apply_governance.py.
const CLASSIFICATIONS = [
  { cls: 'regulated-health-pii', tone: 'text-red-600 dark:text-red-400', tables: ['dim_account'] },
  { cls: 'commercial-confidential', tone: 'text-amber-600 dark:text-amber-400', tables: ['fact_sales', 'fact_inventory', 'dim_product', 'dim_outlet'] },
  { cls: 'public-reference', tone: 'text-emerald-600 dark:text-emerald-400', tables: ['dim_distribution_center'] },
];

// Documented lineage (labeled as such — narrated from system.access.* where available).
const LINEAGE = [
  'bronze_sales_raw (Lakeflow ingest, ~8% dirty)',
  '→ DQ pipeline · 6 expectations · quarantine',
  '→ fact_sales / fact_inventory (silver→gold)',
  '→ gold_* serving (synced to Lakebase)',
  '→ AI/BI dashboard · Genie · Tempo Scan app',
];

function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: 'good' | 'warn' }) {
  const color = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground';
  return (
    <Card className="shadow-sm">
      <CardContent className="pt-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

export function SovereigntyPage() {
  const [personaKey, setPersonaKey] = useState('jawa');
  const persona = PERSONAS.find((p) => p.key === personaKey)!;
  const params = useMemo(() => ({ persona: sql.string(persona.email) }), [persona.email]);

  const who = useAnalyticsQuery('whoami', {});
  const summary = useAnalyticsQuery('persona_summary', params);
  const s = summary.data?.[0];
  // analytics serializes booleans as strings ("true"/"false") — coerce explicitly
  const piiClear = String(s?.pii_visible) === 'true';
  const allRegions = s?.allowed_region === 'ALL';

  return (
    <div className="space-y-6 w-full max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Sovereignty &amp; Governance</h2>
          <p className="text-sm text-muted-foreground">
            One dataset, four identities. Unity Catalog enforces PII column masks (RBAC) and region
            row-scoping (ABAC), live over the SQL warehouse — and keeps regulated data resident in Indonesia.
          </p>
        </div>
        <Badge variant="secondary" className="gap-1"><MapPin className="h-3 w-3" /> {DATA_REGION}</Badge>
      </div>

      {/* residency + classification + lineage panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="shadow-sm border-l-4 border-l-primary">
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><FileLock2 className="h-4 w-4 text-primary" /> Data Residency</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="text-muted-foreground">Region</span><div className="font-semibold text-foreground">{DATA_REGION}</div></div>
            <div><span className="text-muted-foreground">Sovereignty</span><div className="font-semibold text-foreground">{DATA_SOVEREIGNTY}</div></div>
            <div className="text-xs text-muted-foreground pt-1">
              Every table carries a <code>ts_data_residency</code> tag = <span className="font-mono">{DATA_REGION}</span>; the schema comment states residency intent. Serving gold tables hold <strong>no PII</strong> — all regulated personal data stays on the governed UC path.
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Tags className="h-4 w-4 text-primary" /> Data Classification</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {CLASSIFICATIONS.map((c) => (
              <div key={c.cls} className="text-xs">
                <span className={`font-semibold ${c.tone}`}>{c.cls}</span>
                <div className="text-muted-foreground font-mono">{c.tables.join(', ')}</div>
              </div>
            ))}
            <div className="text-[11px] text-muted-foreground pt-1">Table-level <code>ts_data_classification</code> tags.</div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><GitBranch className="h-4 w-4 text-primary" /> Lineage (documented)</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-1 text-xs text-foreground/80">
              {LINEAGE.map((l) => <li key={l}>{l}</li>)}
            </ol>
            <div className="text-[11px] text-muted-foreground pt-2">Narrated from <code>system.access.*</code> (table/column lineage + audit) where queryable.</div>
          </CardContent>
        </Card>
      </div>

      {/* persona switcher */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {PERSONAS.map((p) => {
          const active = p.key === personaKey;
          return (
            <button
              key={p.key}
              onClick={() => setPersonaKey(p.key)}
              className={`text-left rounded-lg border p-3 transition-colors ${
                active ? 'border-primary bg-accent ring-1 ring-primary' : 'bg-card hover:bg-muted'
              }`}
            >
              <div className="font-semibold text-sm text-foreground">{p.label}</div>
              <div className="text-xs text-muted-foreground">{p.role}</div>
              <div className="text-xs mt-1 text-primary">{p.scope}</div>
            </button>
          );
        })}
      </div>

      {/* access summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {summary.loading || !s ? (
          ['a', 'b', 'c', 'd'].map((x) => <Skeleton key={x} className="h-24 w-full" />)
        ) : (
          <>
            <StatCard label="Identity" value={persona.label} />
            <StatCard label="PII Visible (RBAC)" value={piiClear ? 'Clear' : 'Masked'} tone={piiClear ? 'good' : 'warn'} />
            <StatCard label="Regions Visible (ABAC)" value={`${s.visible_regions} / 5`} />
            <StatCard label="Sales Rows Visible" value={Number(s.visible_sales).toLocaleString()} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* RBAC: PII masking */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /> Account PII — column masks (RBAC)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              {persona.label} {piiClear ? 'is privileged → sees clear contact name / email / phone / NIK.' : 'sees masked contact name, email, phone and a fully-redacted NIK (national ID).'}
            </p>
            <DataTable queryKey="persona_accounts" parameters={params} filterColumn="account_id" filterPlaceholder="Filter account…" pageSize={6} />
          </CardContent>
        </Card>

        {/* ABAC: row scoping */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Sell-Through by Region — row filter (ABAC)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              {persona.label} {allRegions ? 'sees every region.' : `is scoped to ${s?.allowed_region} — other regions are filtered out entirely.`}
            </p>
            <BarChart queryKey="persona_sales_by_region" parameters={params} xKey="region" yKey="orders" height={260} />
          </CardContent>
        </Card>
      </div>

      <Alert>
        <AlertDescription className="text-xs space-y-1">
          <div>
            <strong>How it works.</strong> The Unity Catalog tables <code>dim_account</code> and{' '}
            <code>fact_sales</code> carry column masks (<code>ts_mask_str</code> / <code>ts_mask_full</code> on
            contact_name / email / phone / nik) and a region row filter (<code>ts_region_filter</code>), both
            resolving against the caller&apos;s identity via the ungoverned <code>access_allowlist</code> and{' '}
            <code>ts_is_privileged()</code> — no per-persona copies of the data. This app runs as{' '}
            <code>{who.data?.[0]?.identity ?? '…'}</code>; the switcher simulates each persona&apos;s governed view so
            you can compare them side-by-side. UC masks do not propagate to Lakebase, so the operational serving
            tables deliberately carry no PII.
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
