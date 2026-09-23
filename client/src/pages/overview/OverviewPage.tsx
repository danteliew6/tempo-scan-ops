import {
  BarChart,
  LineChart,
  DonutChart,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Badge,
  Input,
} from '@databricks/appkit-ui/react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Database } from 'lucide-react';
import { useLakebase } from '../../lib/useLakebase';

interface RecentSaleRow {
  sale_id: string;
  order_ts: string;
  region: string;
  city: string;
  division: string;
  brand: string;
  product_name: string;
  units_ordered: number;
  units_fulfilled: number;
  net_m_idr: number;
  status: string;
}

// Recent backorder / partial-fill feed — plain table fed from Lakebase.
function BackorderTable() {
  const { data, loading, error } = useLakebase<RecentSaleRow>('/api/lakebase/recent-sales');
  const [q, setQ] = useState('');
  const rows = useMemo(
    () => (data ?? []).filter((r) => `${r.product_name} ${r.brand} ${r.region}`.toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );
  if (error) return <div className="text-destructive text-sm">Error: {error}</div>;
  if (loading && !data) return <Skeleton className="h-56 w-full" />;
  if (data && data.length === 0) {
    return <div className="text-sm text-muted-foreground py-8 text-center">No backorders or partial fills in the serving window.</div>;
  }
  return (
    <>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter product, brand, region…" className="mb-3 max-w-xs" />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3">Order</th>
              <th className="py-2 pr-3">Product</th>
              <th className="py-2 pr-3">Division</th>
              <th className="py-2 pr-3">Region</th>
              <th className="py-2 pr-3">Ordered / Filled</th>
              <th className="py-2 pr-3">Net (M IDR)</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((r) => (
              <tr key={r.sale_id} className="border-b border-border/50">
                <td className="py-1.5 pr-3 text-xs text-muted-foreground">{r.order_ts}</td>
                <td className="py-1.5 pr-3 font-medium">{r.product_name}<span className="text-muted-foreground"> · {r.brand}</span></td>
                <td className="py-1.5 pr-3">{r.division}</td>
                <td className="py-1.5 pr-3">{r.region}</td>
                <td className="py-1.5 pr-3">{Number(r.units_ordered).toLocaleString()} / {Number(r.units_fulfilled).toLocaleString()}</td>
                <td className="py-1.5 pr-3">{Number(r.net_m_idr).toLocaleString()}</td>
                <td className="py-1.5">
                  <Badge variant={r.status === 'backorder' ? 'destructive' : 'secondary'}>{r.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function KpiCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' | 'crit' }) {
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

interface NationalKpis {
  revenue_bn_idr: number;
  revenue_at_risk_bn_idr: number;
  demand_units: number;
  order_count: number;
  backorder_count: number;
  fill_rate: number;
  stockout_rate: number;
}

export function OverviewPage() {
  // All served from Lakebase Postgres (gold_national_daily / gold_region_daily /
  // gold_sales_serving) — sub-second reads.
  const { data: kpiRows, loading, error } = useLakebase<NationalKpis>('/api/lakebase/national-kpis');
  const daily = useLakebase('/api/lakebase/national-daily');
  const region = useLakebase('/api/lakebase/region-latest');
  const division = useLakebase('/api/lakebase/division-mix');
  const k = kpiRows?.[0];

  return (
    <div className="space-y-6 w-full max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Distribution Overview</h2>
          <p className="text-sm text-muted-foreground">
            National sell-through, fill rate &amp; revenue-at-risk across Indonesia · last 30 days
          </p>
        </div>
        <Badge variant="secondary" className="gap-1">
          <Database className="h-3 w-3" /> Served from Lakebase
        </Badge>
      </div>

      {/* KPI row */}
      {error && <div className="text-destructive bg-destructive/10 p-3 rounded-md">Error: {error}</div>}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {loading || !k ? (
          ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => <Skeleton key={s} className="h-24 w-full" />)
        ) : (
          <>
            <KpiCard label="Net Revenue (30d)" value={`Rp ${k.revenue_bn_idr} B`} hint="fulfilled sell-through" />
            <KpiCard label="Fill Rate" value={`${(k.fill_rate * 100).toFixed(1)}%`} tone={k.fill_rate >= 0.9 ? 'good' : 'warn'} />
            <KpiCard label="Stockout Rate" value={`${(k.stockout_rate * 100).toFixed(1)}%`} tone={k.stockout_rate >= 0.15 ? 'crit' : k.stockout_rate >= 0.08 ? 'warn' : 'good'} hint="high-demand SKU-days" />
            <KpiCard label="Revenue at Risk" value={`Rp ${k.revenue_at_risk_bn_idr} B`} tone="crit" hint="lost to stockouts" />
            <KpiCard label="Demand (units)" value={Number(k.demand_units).toLocaleString()} />
            <KpiCard label="Backorders" value={Number(k.backorder_count).toLocaleString()} tone={k.backorder_count > 0 ? 'warn' : 'good'} />
          </>
        )}
      </div>

      {/* charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="shadow-sm">
          <CardHeader><CardTitle>Net Revenue vs Revenue at Risk (daily)</CardTitle></CardHeader>
          <CardContent>
            <LineChart data={daily.data ?? []} xKey="sales_date" yKey={['revenue_bn_idr', 'revenue_at_risk_m_idr']} height={280} showLegend />
            <p className="text-xs text-muted-foreground mt-2">Net revenue (Bn IDR) against revenue lost to stockouts (M IDR) — the flu-season spike widens the gap.</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader><CardTitle>Demand by Region (latest day)</CardTitle></CardHeader>
          <CardContent>
            <BarChart data={region.data ?? []} xKey="region" yKey="demand_units" height={280} />
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader><CardTitle>Revenue by Division</CardTitle></CardHeader>
          <CardContent>
            <DonutChart data={division.data ?? []} xKey="division" yKey="net_bn_idr" height={280} />
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader><CardTitle>National Stockout Rate by Day</CardTitle></CardHeader>
          <CardContent>
            <LineChart data={daily.data ?? []} xKey="sales_date" yKey="stockout_rate" height={280} />
            <p className="text-xs text-muted-foreground mt-2">
              Recent 30 days climb as the seasonal OTC demand surge (Bodrex, Oskadon, Bodrexin, Hemaviton) hits Jawa + Sumatera.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader><CardTitle>Live Backorder &amp; Partial-Fill Feed</CardTitle></CardHeader>
        <CardContent>
          <BackorderTable />
        </CardContent>
      </Card>
    </div>
  );
}
