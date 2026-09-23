/* eslint-disable react-hooks/set-state-in-effect --
   This diagram measures the laid-out DOM to draw SVG connectors, then commits the
   computed paths to state — via a layout effect and async resize/observer callbacks
   (which run outside React's commit phase, where setState is expected). */
import { Card, CardContent, Badge, Button } from '@databricks/appkit-ui/react';
import { ArrowRight } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { LAYERS, EDGES, CATEGORIES, GOVERNANCE } from './archConfig';
import type { ArchNode, CategoryKey } from './archConfig';

interface EdgePath {
  from: string;
  to: string;
  d: string;
  label?: string;
}

const NODE_BY_ID: Record<string, ArchNode> = Object.fromEntries(
  LAYERS.flatMap((l) => l.nodes).map((n) => [n.id, n]),
);

// Column + row index of every node (drives connector routing).
const COL_OF: Record<string, number> = {};
const ROW_OF: Record<string, number> = {};
LAYERS.forEach((l, ci) => l.nodes.forEach((n, ri) => { COL_OF[n.id] = ci; ROW_OF[n.id] = ri; }));

// Assign each cross-column edge its own vertical channel in the gutter it crosses, so
// parallel connectors (fan-in / fan-out) don't stack on the same line. Keyed "from->to".
const CHANNEL_FRAC: Record<string, number> = {};
{
  const byGutter: Record<number, typeof EDGES> = {};
  EDGES.forEach((e) => {
    if (COL_OF[e.to] > COL_OF[e.from]) (byGutter[COL_OF[e.from]] ??= []).push(e);
  });
  Object.values(byGutter).forEach((list) => {
    list.sort((a, b) => (ROW_OF[a.from] - ROW_OF[b.from]) || (ROW_OF[a.to] - ROW_OF[b.to]));
    list.forEach((e, i) => { CHANNEL_FRAC[`${e.from}->${e.to}`] = (i + 1) / (list.length + 1); });
  });
}

export function ArchitecturePage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [paths, setPaths] = useState<EdgePath[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showGov, setShowGov] = useState(true);

  const setNodeRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  }, []);

  const recompute = useCallback(() => {
    const cont = containerRef.current;
    if (!cont) return;
    const cr = cont.getBoundingClientRect();
    const next: EdgePath[] = [];
    for (const e of EDGES) {
      const a = nodeRefs.current.get(e.from);
      const b = nodeRefs.current.get(e.to);
      if (!a || !b) continue;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      let d: string;

      if (COL_OF[e.from] === COL_OF[e.to]) {
        // Same column → straight vertical connector between stacked nodes.
        const down = ROW_OF[e.to] > ROW_OF[e.from];
        const x = ar.left - cr.left + ar.width / 2;
        const y1 = (down ? ar.bottom : ar.top) - cr.top;
        const y2 = (down ? br.top : br.bottom) - cr.top;
        d = `M ${x} ${y1} L ${x} ${y2}`;
      } else {
        // Cross-column → orthogonal elbow routed through a dedicated gutter channel,
        // with rounded corners. Keeps every line in the gutters (never over a card).
        const x1 = ar.right - cr.left;
        const y1 = ar.top - cr.top + ar.height / 2;
        const x2 = br.left - cr.left;
        const y2 = br.top - cr.top + br.height / 2;
        if (Math.abs(y2 - y1) < 3) {
          d = `M ${x1} ${y1} L ${x2} ${y2}`;
        } else {
          const frac = CHANNEL_FRAC[`${e.from}->${e.to}`] ?? 0.5;
          const cx = x1 + (x2 - x1) * frac;
          const dirY = y2 > y1 ? 1 : -1;
          const r = Math.max(2, Math.min(10, (x2 - x1) * frac / 2, (x2 - x1) * (1 - frac) / 2, Math.abs(y2 - y1) / 2));
          d = `M ${x1} ${y1} L ${cx - r} ${y1} Q ${cx} ${y1} ${cx} ${y1 + dirY * r} L ${cx} ${y2 - dirY * r} Q ${cx} ${y2} ${cx + r} ${y2} L ${x2} ${y2}`;
        }
      }
      next.push({ from: e.from, to: e.to, label: e.label, d });
    }
    setPaths(next);
  }, []);

  useLayoutEffect(() => {
    recompute();
    const cont = containerRef.current;
    if (!cont) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(cont);
    window.addEventListener('resize', recompute);
    // recompute once more after fonts/layout settle
    const t = setTimeout(recompute, 200);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
      clearTimeout(t);
    };
  }, [recompute]);

  const selNode = selected ? NODE_BY_ID[selected] : null;
  const isEdgeActive = (e: EdgePath) => selected != null && (e.from === selected || e.to === selected);
  const isNodeDimmed = (id: string) =>
    selected != null && id !== selected && !EDGES.some((e) => (e.from === selected && e.to === id) || (e.to === selected && e.from === id));

  return (
    <div className="space-y-6 w-full max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-bold text-foreground">End-to-End Architecture</h2>
          <p className="text-sm text-muted-foreground">
            Ingest → cleanse → govern → serve on one Lakehouse. Click any component to inspect it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={showGov ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowGov((v) => !v)}>
            {showGov ? 'Hide' : 'Show'} governance
          </Button>
          {selected && <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Clear selection</Button>}
        </div>
      </div>

      {/* legend */}
      <div className="flex flex-wrap gap-3">
        {(Object.keys(CATEGORIES) as CategoryKey[]).map((k) => (
          <div key={k} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CATEGORIES[k].color }} />
            {CATEGORIES[k].label}
          </div>
        ))}
      </div>

      {/* diagram */}
      <Card className="shadow-sm">
        <CardContent className="pt-5 overflow-x-auto">
          <div ref={containerRef} className="relative min-w-[900px]">
            {/* connectors */}
            <svg className="absolute inset-0 h-full w-full pointer-events-none" style={{ overflow: 'visible' }} aria-hidden>
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" className="text-primary/50" />
                </marker>
                <marker id="arrow-active" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" className="text-primary" />
                </marker>
              </defs>
              {paths.map((e) => {
                const active = isEdgeActive(e);
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    d={e.d}
                    fill="none"
                    strokeWidth={active ? 2.5 : 1.5}
                    className={active ? 'text-primary' : 'text-primary/30'}
                    stroke="currentColor"
                    markerEnd={active ? 'url(#arrow-active)' : 'url(#arrow)'}
                    strokeDasharray={selected && !active ? '4 4' : undefined}
                  />
                );
              })}
            </svg>

            {/* columns */}
            <div className="relative grid grid-cols-4 gap-x-10">
              {LAYERS.map((layer) => (
                <div key={layer.id} className="flex flex-col gap-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{layer.title}</div>
                  {layer.nodes.map((n) => {
                    const cat = CATEGORIES[n.category];
                    const active = selected === n.id;
                    return (
                      <button
                        key={n.id}
                        ref={setNodeRef(n.id)}
                        onClick={() => setSelected(active ? null : n.id)}
                        className={`relative z-10 text-left rounded-lg border bg-card p-3 shadow-sm transition-all ${
                          active ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'
                        } ${isNodeDimmed(n.id) ? 'opacity-45' : ''}`}
                        style={{ borderTopColor: cat.color, borderTopWidth: 3 }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xl leading-none">{n.icon}</span>
                          <span className="font-semibold text-sm text-foreground">{n.title}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1">{n.sub}</div>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* governance band */}
            {showGov && (
              <div className="relative z-10 mt-6 rounded-lg border border-dashed p-3"
                   style={{ borderColor: CATEGORIES.govern.color, backgroundColor: `${CATEGORIES.govern.color}12` }}>
                <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: CATEGORIES.govern.color }}>
                  {GOVERNANCE.title}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {GOVERNANCE.points.map((p) => (
                    <span key={p} className="text-xs text-foreground/80">• {p}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* inspector */}
      {selNode ? (
        <Card className="shadow-sm">
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{selNode.icon}</span>
              <div>
                <div className="font-semibold text-foreground">{selNode.title}</div>
                <div className="text-xs" style={{ color: CATEGORIES[selNode.category].color }}>
                  {CATEGORIES[selNode.category].label} · {selNode.sub}
                </div>
              </div>
              <Badge variant="secondary" className="ml-auto">Unity Catalog governed</Badge>
            </div>
            <p className="text-sm text-foreground/80 mt-3">{selNode.detail}</p>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground text-center">Select a component above to see what it does and how it fits the flow.</p>
      )}

      {/* competitive framing — before → after, graphical */}
      <Card className="shadow-sm">
        <CardContent className="pt-5">
          <div className="text-sm font-semibold text-foreground mb-4">One governed platform replaces a fragmented stack</div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-stretch">
            {/* BEFORE */}
            <div className="rounded-lg border border-dashed border-muted-foreground/40 bg-muted/30 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Before · fragmented stack
              </div>
              <div className="flex flex-wrap gap-2">
                {['Legacy warehouse', 'Separate BI tool', 'OSS pipelines', 'OSS MLflow', 'Manual DQ', 'Fragmented governance', 'No residency guarantees'].map((t) => (
                  <span key={t} className="text-[11px] rounded-md border border-muted-foreground/30 bg-card px-2 py-1 text-muted-foreground line-through decoration-red-400/70">
                    {t}
                  </span>
                ))}
              </div>
              <div className="text-[11px] text-red-500/80 mt-3">Stitched together · governance &amp; residency rebuilt by hand</div>
            </div>

            {/* ARROW */}
            <div className="flex md:flex-col items-center justify-center gap-1 text-primary">
              <ArrowRight className="h-7 w-7 rotate-90 md:rotate-0" />
              <span className="text-[11px] font-semibold">Databricks</span>
            </div>

            {/* AFTER */}
            <div className="rounded-lg border-2 p-4" style={{ borderColor: CATEGORIES.serve.color, backgroundColor: `${CATEGORIES.serve.color}0F` }}>
              <div className="text-[11px] font-semibold uppercase tracking-wide mb-3" style={{ color: CATEGORIES.serve.color }}>
                After · one governed Lakehouse
              </div>
              <div className="flex flex-wrap gap-2">
                {['Lakeflow + DQ', 'Unity Catalog + residency', 'Genie', 'AI/BI', 'Forecast + Serving', 'Lakebase + Apps'].map((t) => (
                  <span key={t} className="text-[11px] rounded-md px-2 py-1 font-medium"
                        style={{ backgroundColor: `${CATEGORIES.serve.color}1A`, color: CATEGORIES.serve.color }}>
                    ✓ {t}
                  </span>
                ))}
              </div>
              <div className="text-[11px] mt-3" style={{ color: CATEGORIES.serve.color }}>Legacy warehouse stays a source via federation — no rip-and-replace</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
