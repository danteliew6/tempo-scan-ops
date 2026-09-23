import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
  BarChart,
} from '@databricks/appkit-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  Activity,
  AlertTriangle,
  Play,
  Pause,
  Clock,
  MapPin,
  ShieldAlert,
  CheckCircle2,
  MessageSquare,
  Boxes,
  CalendarClock,
  RefreshCw,
  PackageX,
} from 'lucide-react';

// How often to re-poll Lakebase (feels live; picks up refresh-synced-tables updates).
const REFRESH_MS = 20000;

// Region centroids for the national symbol map (Indonesian island groups).
const REGION_CENTROID: Record<string, { lat: number; lng: number }> = {
  Jawa: { lat: -7.4, lng: 110.2 },
  Sumatera: { lat: 0.2, lng: 101.6 },
  Kalimantan: { lat: 0.0, lng: 114.0 },
  Sulawesi: { lat: -2.2, lng: 120.4 },
  'Bali-Nusra': { lat: -8.7, lng: 117.2 },
};

// ---------------------------------------------------------------------------
// Data feeders — poll Lakebase on mount + on each `tick`.
// ---------------------------------------------------------------------------
function useLakebaseFeed<T>(url: string, onData: (d: T[]) => void) {
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d)) onData(d as T[]); })
      .catch(() => { /* keep previous data on transient error */ });
    return () => { alive = false; };
  }, [url, onData]);
}
function RegionFeeder({ onData }: { onData: (d: RegionRow[]) => void }) {
  useLakebaseFeed<RegionRow>('/api/lakebase/region-latest', onData);
  return null;
}
function DailyFeeder({ onData }: { onData: (d: DailyRow[]) => void }) {
  useLakebaseFeed<DailyRow>('/api/lakebase/national-daily', onData);
  return null;
}
function RiskFeeder({ onData }: { onData: (d: ProductRiskRow[]) => void }) {
  useLakebaseFeed<ProductRiskRow>('/api/lakebase/product-risk', onData);
  return null;
}

// ---------------------------------------------------------------------------
// Types (mirror the Lakebase serving shapes)
// ---------------------------------------------------------------------------
interface RegionRow {
  region: string;
  sales_date: string;
  demand_units: number;
  fill_rate: number;
  stockout_rate: number;
  revenue_at_risk_m_idr: number;
  backorder_count: number;
}
interface DailyRow {
  sales_date: string;
  revenue_bn_idr: number;
  revenue_at_risk_m_idr: number;
  demand_units: number;
  fill_rate: number;
  stockout_rate: number;
  backorder_count: number;
}
interface ProductRiskRow {
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
type Tone = 'ok' | 'warn' | 'crit';

// ---------------------------------------------------------------------------
// Threshold helpers — the "when does an ops screen light up" logic.
// ---------------------------------------------------------------------------
const N = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const toneStockout = (v: number): Tone => (v >= 0.15 ? 'crit' : v >= 0.08 ? 'warn' : 'ok');
const toneFill = (v: number): Tone => (v <= 0.8 ? 'crit' : v <= 0.9 ? 'warn' : 'ok');

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  crit: 'text-red-600 dark:text-red-400',
};
const TONE_BORDER: Record<Tone, string> = {
  ok: 'border-l-emerald-500',
  warn: 'border-l-amber-500',
  crit: 'border-l-red-500',
};
const TONE_DOT: Record<Tone, string> = { ok: '#10b981', warn: '#f59e0b', crit: '#dc2626' };

const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

// Stockout color ramp for the map.
function gapColor(v: number): string {
  if (v >= 0.18) return '#dc2626';
  if (v >= 0.12) return '#f97316';
  if (v >= 0.06) return '#f59e0b';
  return '#10b981';
}

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------
function StatTile({
  label, value, tone, delta, hint,
}: { label: string; value: string; tone: Tone; delta?: string; hint?: string }) {
  return (
    <Card className={`shadow-sm border-l-4 ${TONE_BORDER[tone]}`}>
      <CardContent className="pt-4 pb-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${TONE_TEXT[tone]}`}>{value}</div>
        {delta && <div className="text-xs text-muted-foreground mt-0.5">{delta}</div>}
        {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// National symbol map — a real street basemap from CARTO raster tiles laid out by
// hand (Web-Mercator math), so it needs NO map library. One circle per region:
// size = demand, color = stockout rate.
// ---------------------------------------------------------------------------
const TILE = 256;
const MAP_H = 420;
const MAP_PAD = 56;
const worldX = (lng: number, z: number) => ((lng + 180) / 360) * TILE * 2 ** z;
const worldY = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};

interface MapPoint extends RegionRow { lat: number; lng: number }

function RegionMap({
  points, selectedId, onSelect,
}: { points: MapPoint[]; selectedId: string | null; onSelect: (r: MapPoint | null) => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(760);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth || 760);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    if (points.length === 0) return null;
    const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    let z = 15;
    for (; z > 3; z--) {
      const spanX = worldX(maxLng, z) - worldX(minLng, z);
      const spanY = worldY(minLat, z) - worldY(maxLat, z);
      if (spanX <= w - 2 * MAP_PAD && spanY <= MAP_H - 2 * MAP_PAD) break;
    }
    const originX = worldX((minLng + maxLng) / 2, z) - w / 2;
    const originY = worldY((minLat + maxLat) / 2, z) - MAP_H / 2;
    return { z, originX, originY };
  }, [points, w]);

  const maxDemand = useMemo(() => Math.max(...points.map((p) => N(p.demand_units)), 1), [points]);

  const tiles = useMemo(() => {
    if (!view) return [];
    const { z, originX, originY } = view;
    const n = 2 ** z;
    const out: { key: string; src: string; left: number; top: number }[] = [];
    for (let tx = Math.floor(originX / TILE); tx <= Math.floor((originX + w) / TILE); tx++) {
      for (let ty = Math.floor(originY / TILE); ty <= Math.floor((originY + MAP_H) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const sub = 'abcd'[Math.abs(tx + ty) % 4];
        out.push({
          key: `${z}-${tx}-${ty}`,
          src: `https://${sub}.basemaps.cartocdn.com/light_all/${z}/${wx}/${ty}@2x.png`,
          left: tx * TILE - originX, top: ty * TILE - originY,
        });
      }
    }
    return out;
  }, [view, w]);

  return (
    <div ref={wrapRef} className="relative w-full rounded-lg overflow-hidden border bg-muted/30" style={{ height: MAP_H }}>
      {!view ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No region activity in this window.</div>
      ) : (
        <>
          {tiles.map((t) => (
            <img key={t.key} src={t.src} alt="" draggable={false}
                 style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE }} />
          ))}
          {points.map((p) => {
            const x = worldX(p.lng, view.z) - view.originX;
            const y = worldY(p.lat, view.z) - view.originY;
            const col = gapColor(N(p.stockout_rate));
            const sel = p.region === selectedId;
            const critical = N(p.stockout_rate) >= 0.15;
            const r = 12 + Math.sqrt(N(p.demand_units) / maxDemand) * 22;
            return (
              <div key={p.region} onClick={() => onSelect(sel ? null : p)}
                   title={`${p.region} · demand ${N(p.demand_units).toLocaleString()} · stockout ${fmtPct(N(p.stockout_rate))} · fill ${fmtPct(N(p.fill_rate))}`}
                   className={`absolute cursor-pointer ${critical ? 'animate-pulse' : ''}`}
                   style={{
                     left: x, top: y, width: r * 2, height: r * 2, transform: 'translate(-50%,-50%)',
                     borderRadius: '9999px', background: `${col}55`, border: `${sel ? 3 : 1.5}px solid ${col}`, zIndex: 5,
                   }}>
                <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-foreground"
                      style={{ top: r * 2 + 2, textShadow: '0 1px 2px rgba(255,255,255,0.9)' }}>
                  {p.region}
                </span>
              </div>
            );
          })}
          <div className="absolute bottom-1 right-2 text-[9px] text-muted-foreground/80 bg-background/70 px-1 rounded" style={{ zIndex: 6 }}>
            © OpenStreetMap © CARTO
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function CommandCenterPage() {
  const navigate = useNavigate();

  // LIVE by default: pinned to the latest day, auto-refreshing from Lakebase.
  // REPLAY: scrub the recent-30d national timeline (watch the flu-season spike build).
  const [mode, setMode] = useState<'live' | 'replay'>('live');
  const [dayIdx, setDayIdx] = useState<number | null>(null); // index into daily rows (replay)
  const [playing, setPlaying] = useState(false);
  const [selRegion, setSelRegion] = useState<MapPoint | null>(null);

  const [tick, setTick] = useState(0);
  const [regionRows, setRegionRows] = useState<RegionRow[]>([]);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [risk, setRisk] = useState<ProductRiskRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const onRegion = useCallback((d: RegionRow[]) => { setRegionRows(d); setLoaded(true); setLastUpdated(new Date()); }, []);
  const onDaily = useCallback((d: DailyRow[]) => setDaily(d), []);
  const onRisk = useCallback((d: ProductRiskRow[]) => setRisk(d), []);

  // periodic data refresh (re-runs the Lakebase feeders) — this is what makes LIVE live.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  // REPLAY auto-advance through the recent days.
  useEffect(() => {
    if (mode !== 'replay' || !playing || daily.length === 0) return;
    const t = setInterval(() => setDayIdx((i) => ((i ?? daily.length - 1) + 1) % daily.length), 900);
    return () => clearInterval(t);
  }, [mode, playing, daily.length]);

  const loading = !loaded;

  // map points = region snapshot joined to centroids
  const mapPoints = useMemo<MapPoint[]>(
    () => regionRows
      .filter((r) => REGION_CENTROID[r.region])
      .map((r) => ({ ...r, ...REGION_CENTROID[r.region] })),
    [regionRows],
  );

  // national aggregates (latest live snapshot from region rows)
  const nat = useMemo(() => {
    const demand = regionRows.reduce((s, r) => s + N(r.demand_units), 0);
    const backorders = regionRows.reduce((s, r) => s + N(r.backorder_count), 0);
    const revAtRisk = regionRows.reduce((s, r) => s + N(r.revenue_at_risk_m_idr), 0);
    const wFill = demand ? regionRows.reduce((s, r) => s + N(r.fill_rate) * N(r.demand_units), 0) / demand : 0;
    const wStockout = demand ? regionRows.reduce((s, r) => s + N(r.stockout_rate) * N(r.demand_units), 0) / demand : 0;
    return { demand, backorders, revAtRisk, fill: wFill, stockout: wStockout };
  }, [regionRows]);

  const worstRegion = useMemo(
    () => [...regionRows].sort((a, b) => N(b.stockout_rate) - N(a.stockout_rate))[0],
    [regionRows],
  );

  // at-risk SKU rollups
  const expirySkus = useMemo(() => risk.filter((r) => N(r.expiry_risk_pct) >= 70), [risk]);
  const stockoutSkus = useMemo(() => risk.filter((r) => N(r.stockout_risk_pct) >= 50), [risk]);
  const topRisk = useMemo(
    () => [...risk].sort((a, b) => Math.max(N(b.expiry_risk_pct), N(b.stockout_risk_pct)) - Math.max(N(a.expiry_risk_pct), N(a.stockout_risk_pct))).slice(0, 8),
    [risk],
  );
  const riskByRegion = useMemo(() => {
    const byRegion: Record<string, number> = {};
    for (const r of risk) byRegion[r.region] = (byRegion[r.region] ?? 0) + 1;
    return Object.entries(byRegion).map(([region, count]) => ({ region, count })).sort((a, b) => b.count - a.count);
  }, [risk]);

  // selected replay day (or latest)
  const selDay = mode === 'replay' && dayIdx != null ? daily[dayIdx] : daily[daily.length - 1];
  const clockDate = selDay?.sales_date ?? (regionRows[0]?.sales_date ?? '—');

  // ---- alert feed (derived) ----
  interface Alert { id: string; sev: Tone; icon: ReactNode; title: string; detail: string; action: string; ask?: string; }
  const alerts: Alert[] = [];
  if (worstRegion && toneStockout(N(worstRegion.stockout_rate)) === 'crit') {
    alerts.push({
      id: 'stockout', sev: 'crit', icon: <ShieldAlert className="h-4 w-4" />,
      title: `Stockout spike — ${worstRegion.region}`,
      detail: `Stockout rate ${fmtPct(N(worstRegion.stockout_rate))} with fill ${fmtPct(N(worstRegion.fill_rate))} — Rp ${N(worstRegion.revenue_at_risk_m_idr).toLocaleString()} M at risk. Seasonal OTC demand (Bodrex, Oskadon, Bodrexin, Hemaviton) is outrunning supply.`,
      action: 'Pre-position stock to the affected DCs and expedite replenishment on the flu-season SKUs.',
      ask: `Which regions have the highest stockout rate in the last 30 days?`,
    });
  }
  if (stockoutSkus.length > 0) {
    alerts.push({
      id: 'sku-stockout', sev: 'crit', icon: <PackageX className="h-4 w-4" />,
      title: `${stockoutSkus.length} SKUs at high stockout risk`,
      detail: `${stockoutSkus.length} SKU×DC combinations are predicted ≥50% likely to stock out. Most exposed: ${stockoutSkus.slice(0, 3).map((r) => r.product_name).join(', ')}.`,
      action: 'Redistribute on-hand inventory from over-stocked DCs to the shortage regions.',
      ask: 'Which SKUs are most likely to stock out this week?',
    });
  }
  if (expirySkus.length > 0) {
    alerts.push({
      id: 'expiry', sev: 'warn', icon: <CalendarClock className="h-4 w-4" />,
      title: `${expirySkus.length} SKUs trending to expiry write-off`,
      detail: `${expirySkus.length} short-shelf-life SKU×DC batches have expiry risk ≥70%. Nearest: ${expirySkus.slice(0, 3).map((r) => `${r.product_name} (${N(r.days_to_expiry)}d)`).join(', ')}.`,
      action: 'Promote or redistribute near-expiry stock before it is written off.',
      ask: 'Which products are closest to expiry and where?',
    });
  }
  if (nat.backorders > 0) {
    alerts.push({
      id: 'backorder', sev: 'warn', icon: <Boxes className="h-4 w-4" />,
      title: `${nat.backorders.toLocaleString()} orders on backorder`,
      detail: `${nat.backorders.toLocaleString()} orders unfulfilled across the network — concentrated in ${worstRegion?.region ?? 'high-demand regions'}.`,
      action: 'Confirm inbound shipments and prioritise allocation to backordered outlets.',
    });
  }
  const overall: Tone = alerts.some((a) => a.sev === 'crit') ? 'crit' : alerts.some((a) => a.sev === 'warn') ? 'warn' : 'ok';
  const hasStockout = alerts.some((a) => a.id === 'stockout');
  const headline =
    overall === 'crit'
      ? hasStockout ? 'ELEVATED — active stockout incident' : 'ELEVATED — incidents require attention'
      : overall === 'warn' ? 'WATCH — network under pressure' : 'NOMINAL — supply chain healthy';

  return (
    <div className="space-y-5 w-full max-w-7xl mx-auto">
      {/* invisible data feeders — remount each tick to re-poll Lakebase (live refresh) */}
      <RegionFeeder key={`r-${tick}`} onData={onRegion} />
      <DailyFeeder key={`d-${tick}`} onData={onDaily} />
      <RiskFeeder key={`k-${tick}`} onData={onRisk} />

      {/* header + controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full ts-header text-white shadow-sm">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-foreground leading-tight">National Distribution Command Center</h2>
            <p className="text-sm text-muted-foreground">Live supply-chain health across Indonesia · PT Tempo network · recent 30 days</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground bg-card border rounded-md px-2.5 py-1.5 shadow-sm">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" /> {clockDate}
          </div>
          {mode === 'live' ? (
            <span className="flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-2.5 py-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              LIVE
            </span>
          ) : (
            <Button variant={playing ? 'secondary' : 'default'} size="sm" onClick={() => setPlaying((p) => !p)} className="gap-1">
              {playing ? <><Pause className="h-3.5 w-3.5" /> Playing</> : <><Play className="h-3.5 w-3.5" /> Play</>}
            </Button>
          )}
          <Button
            variant={mode === 'replay' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => { if (mode === 'live') { setMode('replay'); setDayIdx(daily.length - 1); setPlaying(false); } else { setMode('live'); setDayIdx(null); setPlaying(false); } }}
            className="gap-1"
            title={mode === 'live' ? 'Replay recent days' : 'Return to live'}
          >
            <CalendarClock className="h-3.5 w-3.5" /> {mode === 'live' ? 'Replay' : 'Go live'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setTick((x) => x + 1)} className="gap-1 text-muted-foreground" title="Refresh now">
            <RefreshCw className="h-3.5 w-3.5" />
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* status banner */}
      {!loading && (
        <div className={`rounded-lg px-4 py-3 flex items-center gap-3 border-l-4 ${TONE_BORDER[overall]} ${
          overall === 'crit' ? 'bg-red-500/10' : overall === 'warn' ? 'bg-amber-500/10' : 'bg-emerald-500/10'
        }`}>
          {overall === 'ok' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className={`h-5 w-5 ${TONE_TEXT[overall]}`} />}
          <div className={`font-semibold ${TONE_TEXT[overall]}`}>{headline}</div>
          <div className="text-sm text-muted-foreground ml-auto">{alerts.length} active alert{alerts.length === 1 ? '' : 's'}</div>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {loading ? (
          ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => <Skeleton key={s} className="h-24 w-full" />)
        ) : (
          <>
            <StatTile label="Fill Rate" value={fmtPct(nat.fill)} tone={toneFill(nat.fill)} hint="demand-weighted" />
            <StatTile label="Stockout Rate" value={fmtPct(nat.stockout)} tone={toneStockout(nat.stockout)}
              delta={worstRegion ? `worst: ${worstRegion.region} ${fmtPct(N(worstRegion.stockout_rate))}` : undefined} />
            <StatTile label="Revenue at Risk" value={`Rp ${nat.revAtRisk.toLocaleString()} M`} tone={nat.revAtRisk > 0 ? 'crit' : 'ok'} />
            <StatTile label="Demand (units)" value={nat.demand.toLocaleString()} tone="ok" />
            <StatTile label="Backorders" value={nat.backorders.toLocaleString()} tone={nat.backorders ? 'warn' : 'ok'} />
            <StatTile label="At-Risk SKUs" value={`${risk.length}`} tone={expirySkus.length || stockoutSkus.length ? 'crit' : 'ok'} hint="expiry or stockout" />
          </>
        )}
      </div>

      {/* 30-day timeline / scrubber */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            30-Day National Timeline
            <span className="text-xs font-normal text-muted-foreground">· stockout rate by day · click to scrub</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading || daily.length === 0 ? <Skeleton className="h-14 w-full" /> : (
            <>
              <div className="flex gap-0.5">
                {daily.map((d, i) => {
                  const t = toneStockout(N(d.stockout_rate));
                  const active = mode === 'replay' && i === dayIdx;
                  return (
                    <button
                      key={d.sales_date}
                      onClick={() => { setMode('replay'); setDayIdx(i); setPlaying(false); }}
                      title={`${d.sales_date} · stockout ${fmtPct(N(d.stockout_rate))} · backorders ${N(d.backorder_count).toLocaleString()}`}
                      className={`flex-1 rounded-sm transition-all ${active ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'hover:opacity-80'}`}
                      style={{ height: 40, backgroundColor: TONE_DOT[t], opacity: active ? 1 : 0.6 }}
                    />
                  );
                })}
              </div>
              {selDay && (
                <div className="flex justify-between mt-1.5 text-[11px] text-muted-foreground">
                  <span>{daily[0]?.sales_date}</span>
                  <span className="font-medium text-foreground">
                    {selDay.sales_date}: stockout {fmtPct(N(selDay.stockout_rate))} · Rp {N(selDay.revenue_at_risk_m_idr).toLocaleString()} M at risk · {N(selDay.backorder_count).toLocaleString()} backorders
                  </span>
                  <span>{daily[daily.length - 1]?.sales_date}</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* map + alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="shadow-sm lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" /> Regional Demand &amp; Stockout Map</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-[380px] w-full" /> : (
              <>
                <RegionMap points={mapPoints} selectedId={selRegion?.region ?? null} onSelect={setSelRegion} />
                <div className="flex items-center justify-between flex-wrap gap-2 mt-2">
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: '#10b981' }} /> healthy</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: '#f59e0b' }} /> tight</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: '#f97316' }} /> strained</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: '#dc2626' }} /> stockout</span>
                    <span className="ml-1">· bubble size = demand</span>
                  </div>
                  {selRegion && (
                    <div className="text-xs text-foreground/80">
                      <span className="font-semibold">{selRegion.region}</span> · demand {N(selRegion.demand_units).toLocaleString()} · stockout {fmtPct(N(selRegion.stockout_rate))} · fill {fmtPct(N(selRegion.fill_rate))}
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* alert feed */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-primary" /> Alert Feed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 max-h-[420px] overflow-y-auto">
            {loading ? <Skeleton className="h-40 w-full" /> : alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                <div className="text-sm font-medium text-foreground">No active incidents</div>
                <div className="text-xs text-muted-foreground">Network operating within normal thresholds.</div>
              </div>
            ) : alerts.map((a) => (
              <div key={a.id} className={`rounded-lg border border-l-4 ${TONE_BORDER[a.sev]} bg-card p-3`}>
                <div className={`flex items-center gap-2 font-semibold text-sm ${TONE_TEXT[a.sev]}`}>
                  {a.icon} {a.title}
                </div>
                <p className="text-xs text-foreground/80 mt-1">{a.detail}</p>
                <div className="text-xs mt-2 flex items-start gap-1.5">
                  <span className="text-muted-foreground shrink-0">▶ Recommended:</span>
                  <span className="text-foreground/90">{a.action}</span>
                </div>
                {a.ask && (
                  <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 text-primary"
                    onClick={() => { void navigate(`/ask?q=${encodeURIComponent(a.ask!)}`); }}>
                    <MessageSquare className="h-3.5 w-3.5" /> Ask Tempo
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* region health + SKU risk watch */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-base">Region Health · {clockDate}</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-48 w-full" /> : (
              <div className="space-y-2">
                {[...regionRows].sort((a, b) => N(b.stockout_rate) - N(a.stockout_rate)).map((c) => {
                  const t = toneStockout(N(c.stockout_rate));
                  return (
                    <div key={c.region} className="flex items-center gap-3">
                      <div className="w-24 text-sm font-medium text-foreground shrink-0">{c.region}</div>
                      <div className="flex-1 h-5 rounded bg-muted overflow-hidden">
                        <div className="h-full rounded" style={{ width: `${Math.min(N(c.stockout_rate) * 100 * 4, 100)}%`, backgroundColor: TONE_DOT[t] }} />
                      </div>
                      <div className={`w-14 text-right text-sm font-semibold ${TONE_TEXT[t]}`}>{fmtPct(N(c.stockout_rate))}</div>
                      <div className="w-20 text-right text-xs text-muted-foreground">fill {fmtPct(N(c.fill_rate))}</div>
                    </div>
                  );
                })}
                <p className="text-[11px] text-muted-foreground pt-1">Stockout rate by region (bar scaled ×4 for contrast).</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><Boxes className="h-4 w-4 text-primary" /> Top At-Risk SKUs</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-48 w-full" /> : risk.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">No SKUs above risk thresholds.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3">Product</th>
                      <th className="py-2 pr-3">Region</th>
                      <th className="py-2 pr-3">Expiry</th>
                      <th className="py-2 pr-3">Stockout</th>
                      <th className="py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topRisk.map((r) => (
                      <tr key={`${r.dc_id}-${r.product_id}`} className="border-b border-border/50">
                        <td className="py-1.5 pr-3 font-medium">{r.product_name}<span className="text-muted-foreground"> · {r.brand}</span></td>
                        <td className="py-1.5 pr-3">{r.region}</td>
                        <td className={`py-1.5 pr-3 font-semibold ${N(r.expiry_risk_pct) >= 70 ? 'text-red-600' : 'text-muted-foreground'}`}>{N(r.expiry_risk_pct)}%</td>
                        <td className={`py-1.5 pr-3 font-semibold ${N(r.stockout_risk_pct) >= 50 ? 'text-red-600' : 'text-muted-foreground'}`}>{N(r.stockout_risk_pct)}%</td>
                        <td className="py-1.5 capitalize">{r.recommended_action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* forecast summary bar */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-base">At-Risk SKUs by Region (worklist size)</CardTitle></CardHeader>
        <CardContent>
          <BarChart data={riskByRegion} xKey="region" yKey="count" height={130} orientation="horizontal" />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        {mode === 'live' ? 'Live view' : 'Replay'} · served from Lakebase Postgres (<span className="font-mono">gold_region_daily</span> / <span className="font-mono">gold_national_daily</span> / <span className="font-mono">gold_product_risk</span>) · SKU risk from the served demand-forecast model · auto-refreshes every {REFRESH_MS / 1000}s · governed in Unity Catalog, resident in AWS Jakarta.
      </p>
    </div>
  );
}
