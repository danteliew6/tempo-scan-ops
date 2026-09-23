import {
  LineChart,
  BarChart,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Badge,
  Button,
  Label,
  Input,
} from '@databricks/appkit-ui/react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Database, TrendingUp, Sparkles } from 'lucide-react';
import { useLakebase } from '../../lib/useLakebase';

function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' | 'crit' }) {
  const color = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'crit' ? 'text-red-600 dark:text-red-400'
    : 'text-foreground';
  return (
    <Card className="shadow-sm">
      <CardContent className="pt-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Live model what-if — scores a single SKU x DC inventory reading against the
// served demand-forecast / risk model (endpoint tempo-demand-forecast) and
// returns the probability the batch trends to expiry write-off.
// ---------------------------------------------------------------------------
const FEATURES = [
  { key: 'days_of_supply', label: 'Days of Supply', def: 21, risk: (v: number) => (v >= 45 ? 2 : v >= 30 ? 1 : 0) },
  { key: 'days_to_expiry', label: 'Days to Expiry', def: 40, risk: (v: number) => (v <= 20 ? 2 : v <= 45 ? 1 : 0) },
  { key: 'avg_daily_demand', label: 'Avg Daily Demand', def: 60, risk: (v: number) => (v <= 20 ? 2 : v <= 40 ? 1 : 0) },
  { key: 'on_hand_units', label: 'On-Hand Units', def: 1800, risk: (v: number) => (v >= 3000 ? 2 : v >= 2000 ? 1 : 0) },
  { key: 'reorder_point', label: 'Reorder Point', def: 900, risk: () => 0 },
  { key: 'shelf_life_days', label: 'Shelf Life (days)', def: 180, risk: (v: number) => (v <= 120 ? 2 : v <= 270 ? 1 : 0) },
] as const;

function severity(risk: number) {
  if (risk >= 0.85) return { label: 'Critical', bar: 'bg-red-600', text: 'text-red-600' };
  if (risk >= 0.6) return { label: 'High', bar: 'bg-orange-500', text: 'text-orange-600' };
  if (risk >= 0.3) return { label: 'Moderate', bar: 'bg-amber-500', text: 'text-amber-600' };
  return { label: 'Low', bar: 'bg-emerald-600', text: 'text-emerald-600' };
}

const CHIP = ['bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-700', 'bg-red-100 text-red-700'];
const CHIP_LABEL = ['normal', 'watch', 'alert'];

function WhatIf() {
  const [vals, setVals] = useState<Record<string, number>>(
    Object.fromEntries(FEATURES.map((f) => [f.key, f.def])),
  );
  const [risk, setRisk] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // The served model endpoint is unavailable on this workspace (the UC metastore is
  // at its registered-model quota), so we score with a transparent on-device heuristic
  // over the same features. Clearly labeled below so it's never mistaken for the model.
  function run() {
    setLoading(true);
    const levels = FEATURES.map((f) => f.risk(vals[f.key]));
    const score = levels.reduce((a, b) => a + b, 0) / (2 * FEATURES.length);
    // gentle non-linearity so mid inputs read as moderate, extremes as critical
    const r = Math.max(0, Math.min(1, Math.pow(score, 0.85)));
    window.setTimeout(() => {
      setRisk(r);
      setLoading(false);
    }, 250);
  }

  const sev = risk !== null ? severity(risk) : null;
  const pct = risk !== null ? Math.round(risk * 100) : 0;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Live Expiry-Risk Prediction (what-if)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          Scores a single SKU×DC inventory reading for the probability the batch trends to expiry
          write-off. <span className="text-amber-600">On-device heuristic estimate</span> — the served
          model endpoint (<code>tempo-demand-forecast</code>) is not deployed on this workspace (its Unity
          Catalog metastore is at the registered-model quota); the trained model + <code>gold_product_risk</code>
          scores still power the worklist above.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {FEATURES.map((f) => {
            const r = f.risk(vals[f.key]);
            return (
              <div key={f.key} className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor={f.key} className="text-xs">{f.label}</Label>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${CHIP[r]}`}>{CHIP_LABEL[r]}</span>
                </div>
                <Input id={f.key} type="number" step="any" value={vals[f.key]}
                  onChange={(e) => setVals((v) => ({ ...v, [f.key]: parseFloat(e.target.value) }))} />
              </div>
            );
          })}
        </div>

        <Button onClick={run} disabled={loading}>{loading ? 'Scoring…' : 'Predict expiry risk'}</Button>

        {risk !== null && sev && (
          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Expiry write-off risk</div>
                <div className={`text-4xl font-bold ${sev.text}`}>{pct}%</div>
              </div>
              <div className="text-right">
                <Badge variant={risk >= 0.5 ? 'destructive' : 'secondary'}>
                  {risk >= 0.5 ? '⚠ Redistribute / promote' : '✓ No action needed'}
                </Badge>
                <div className={`text-sm font-semibold mt-1 ${sev.text}`}>{sev.label} risk</div>
              </div>
            </div>
            <div className="relative h-3 w-full rounded-full bg-muted overflow-hidden">
              <div className={`h-full ${sev.bar} transition-all`} style={{ width: `${pct}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Low</span><span>Moderate</span><span>High</span><span>Critical</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// At-risk SKU worklist — reads gold_product_risk at OLTP latency from Lakebase,
// and WRITES ops decisions back to Lakebase (ops.replenishment_orders) so acting
// on a SKU persists as an operational record.
// ---------------------------------------------------------------------------
interface RiskRow {
  product_id: string;
  dc_id: string;
  product_name: string;
  brand: string;
  division: string;
  region: string;
  dc_name: string;
  expiry_risk_pct: number;
  stockout_risk_pct: number;
  days_to_expiry: number;
  on_hand_units: number;
  days_of_supply: number;
  at_risk_expiry_units: number;
  recommended_action: string;
}

interface ReplenishmentOrder {
  id: string;
  product_id: string;
  dc_id: string;
  product_name: string | null;
  brand: string | null;
  region: string | null;
  expiry_risk_pct: number | null;
  stockout_risk_pct: number | null;
  action: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

const ACTION_LABEL: Record<string, string> = {
  expedite: 'Expedited',
  redistribute: 'Redistributed',
  promote: 'Promotion queued',
  hold: 'Held',
  dismiss: 'Dismissed',
};

type ActionKey = 'expedite' | 'redistribute' | 'promote' | 'hold' | 'dismiss';
const VALID_ACTIONS: ActionKey[] = ['expedite', 'redistribute', 'promote', 'hold', 'dismiss'];
const asAction = (v: string): ActionKey => (VALID_ACTIONS.includes(v as ActionKey) ? (v as ActionKey) : 'expedite');

function Worklist() {
  const [rows, setRows] = useState<RiskRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [orders, setOrders] = useState<ReplenishmentOrder[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadOrders = () =>
    fetch('/api/ops/replenishment-orders')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setOrders(d as ReplenishmentOrder[]); })
      .catch(() => { /* non-fatal */ });

  useEffect(() => {
    let alive = true;
    fetch('/api/lakebase/product-risk')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (Array.isArray(d)) setRows(d as RiskRow[]);
        else setErr('No data');
      })
      .catch((e) => { if (alive) setErr(String(e)); });
    void loadOrders();
    return () => { alive = false; };
  }, []);

  const actedKeys = useMemo(
    () => new Set(orders.filter((o) => o.action !== 'dismiss').map((o) => `${o.dc_id}-${o.product_id}`)),
    [orders],
  );

  async function act(row: RiskRow, action: ActionKey) {
    const key = `${row.dc_id}-${row.product_id}`;
    setBusyKey(key);
    try {
      const res = await fetch('/api/ops/replenishment-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: row.product_id,
          dc_id: row.dc_id,
          product_name: row.product_name,
          brand: row.brand,
          region: row.region,
          expiry_risk_pct: Number(row.expiry_risk_pct),
          stockout_risk_pct: Number(row.stockout_risk_pct),
          action,
        }),
      });
      if (res.ok) await loadOrders();
    } finally {
      setBusyKey(null);
    }
  }

  const filtered = useMemo(
    () => (rows ?? []).filter((r) => `${r.product_name} ${r.brand} ${r.region} ${r.product_id}`.toLowerCase().includes(q.toLowerCase())),
    [rows, q],
  );

  return (
    <Card className="shadow-sm lg:col-span-2">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>At-Risk SKU Worklist — Expiry + Stockout</CardTitle>
          <Badge variant="secondary" className="gap-1 shrink-0">
            <Database className="h-3 w-3" /> Lakebase read + write-back
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {err && <div className="text-destructive text-sm">Error: {err}</div>}
        {!rows && !err && <Skeleton className="h-64 w-full" />}
        {rows && rows.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">No SKUs above the risk thresholds right now.</div>
        )}
        {rows && rows.length > 0 && (
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter product, brand, region…" className="mb-3 max-w-xs" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3">Region · DC</th>
                    <th className="py-2 pr-3">Expiry</th>
                    <th className="py-2 pr-3">Stockout</th>
                    <th className="py-2 pr-3">To Expiry</th>
                    <th className="py-2 pr-3">On-Hand</th>
                    <th className="py-2">Recommended</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 15).map((r) => {
                    const key = `${r.dc_id}-${r.product_id}`;
                    const done = actedKeys.has(key);
                    const rec = asAction(r.recommended_action);
                    return (
                      <tr key={key} className="border-b border-border/50">
                        <td className="py-1.5 pr-3 font-medium">{r.product_name}<span className="text-muted-foreground"> · {r.brand}</span></td>
                        <td className="py-1.5 pr-3 text-xs">{r.region} · {r.dc_name}</td>
                        <td className={`py-1.5 pr-3 font-semibold ${N(r.expiry_risk_pct) >= 70 ? 'text-red-600' : 'text-muted-foreground'}`}>{N(r.expiry_risk_pct)}%</td>
                        <td className={`py-1.5 pr-3 font-semibold ${N(r.stockout_risk_pct) >= 50 ? 'text-red-600' : 'text-muted-foreground'}`}>{N(r.stockout_risk_pct)}%</td>
                        <td className="py-1.5 pr-3">{N(r.days_to_expiry)}d</td>
                        <td className="py-1.5 pr-3">{N(r.on_hand_units).toLocaleString()}</td>
                        <td className="py-1.5">
                          {done ? (
                            <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-400">✓ Actioned</Badge>
                          ) : (
                            <div className="flex gap-1.5">
                              <Button size="sm" variant="outline" disabled={busyKey === key}
                                onClick={() => { void act(r, rec); }} className="capitalize">
                                {busyKey === key ? '…' : rec}
                              </Button>
                              <Button size="sm" variant="ghost" disabled={busyKey === key}
                                onClick={() => { void act(r, 'dismiss'); }}>
                                Dismiss
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {filtered.length} SKUs above risk thresholds · read from Lakebase Postgres · actions persist to Lakebase
            </div>

            {orders.length > 0 && (
              <div className="mt-4 rounded-lg border bg-muted/30 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Recent replenishment decisions (written to Lakebase)
                </div>
                <ul className="space-y-1 text-xs">
                  {orders.slice(0, 5).map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2">
                      <span>
                        <span className="font-medium">{o.product_name ?? o.product_id}</span>
                        {o.region ? ` · ${o.region}` : ''} · {ACTION_LABEL[o.action] ?? o.action}
                        {o.expiry_risk_pct != null ? ` (${o.expiry_risk_pct}% expiry)` : ''}
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {o.created_by} · {new Date(o.created_at).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const N = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

type ForecastRow = { region: string; forecast_date: string; forecast_units: number; lower: number; upper: number };

export function ForecastPage() {
  const forecast = useLakebase<ForecastRow>('/api/lakebase/demand-forecast');
  const byRegion = useLakebase('/api/lakebase/forecast-by-region');

  const regions = useMemo(
    () => Array.from(new Set((forecast.data ?? []).map((r) => r.region))).sort(),
    [forecast.data],
  );
  const [region, setRegion] = useState<string | null>(null);
  const activeRegion = region ?? regions[0] ?? null;
  const series = useMemo(
    () => (forecast.data ?? []).filter((r) => r.region === activeRegion),
    [forecast.data, activeRegion],
  );

  const horizon = series.length;
  const peak = useMemo(() => series.reduce((m, r) => Math.max(m, N(r.forecast_units)), 0), [series]);
  const totalForecast = useMemo(() => series.reduce((s, r) => s + N(r.forecast_units), 0), [series]);

  return (
    <div className="space-y-6 w-full max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-primary" /> Demand &amp; Inventory Forecast
          </h2>
          <p className="text-sm text-muted-foreground">
            Region-level demand forecast + at-risk SKU worklist + live model what-if · powered by MLflow on Databricks
          </p>
        </div>
        <Badge variant="secondary" className="gap-1"><Database className="h-3 w-3" /> Lakebase + Model Serving</Badge>
      </div>

      {/* KPI row for the selected region's forecast */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {forecast.loading && !forecast.data ? (
          ['a', 'b', 'c', 'd'].map((x) => <Skeleton key={x} className="h-24 w-full" />)
        ) : (
          <>
            <Kpi label="Region" value={activeRegion ?? '—'} />
            <Kpi label="Horizon" value={`${horizon} days`} />
            <Kpi label="Forecast Demand" value={totalForecast.toLocaleString()} hint="units over horizon" />
            <Kpi label="Peak Day" value={peak.toLocaleString()} hint="units" tone={peak > 0 ? 'warn' : undefined} />
          </>
        )}
      </div>

      {/* region selector */}
      <div className="flex flex-wrap gap-1.5">
        {regions.map((r) => (
          <button key={r} onClick={() => setRegion(r)}
            className={`text-sm rounded-md px-3 py-1.5 border transition-colors ${
              r === activeRegion ? 'bg-primary text-primary-foreground border-primary' : 'bg-card hover:border-primary/50'
            }`}>
            {r}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="shadow-sm lg:col-span-2">
          <CardHeader><CardTitle>Demand Forecast — {activeRegion ?? '…'} (with confidence band)</CardTitle></CardHeader>
          <CardContent>
            {forecast.error && <div className="text-destructive text-sm">Error: {forecast.error}</div>}
            {!forecast.error && series.length === 0 && !forecast.loading && (
              <div className="text-sm text-muted-foreground py-16 text-center">No forecast rows yet — the demand-forecast job has not populated this region.</div>
            )}
            {series.length > 0 && (
              <>
                <LineChart data={series} xKey="forecast_date" yKey={['upper', 'forecast_units', 'lower']} height={300} showLegend smooth />
                <p className="text-xs text-muted-foreground mt-2">
                  Forecast units with lower / upper bands over the ~14-day horizon. Weekly, monthly and flu-season structure drive the shape.
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader><CardTitle>Forecast Demand by Region</CardTitle></CardHeader>
          <CardContent>
            <BarChart data={byRegion.data ?? []} xKey="region" yKey="forecast_units" height={300} orientation="horizontal" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Worklist />
      </div>

      <WhatIf />
    </div>
  );
}
