import {
  useAnalyticsQuery,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Badge,
  Alert,
  AlertDescription,
  ScrollArea,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { useMemo, useState } from 'react';
import { FileText, ScanText, Table2, Sparkles, MousePointerClick } from 'lucide-react';

interface DocRow {
  doc_id: string;
  doc_type: string;
  file_name: string;
  parsed_text: string;
  vendor_name: string;
  document_number: string;
  document_date: string;
  total_amount_idr: string;
  currency: string;
  bpom_reg_no: string;
  product_name: string;
}

interface ParsedElement {
  id: string;
  type: string;
  content: string;
  coord: [number, number, number, number] | null;
  page_id: number | null;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  purchase_order: 'Purchase Order',
  coa: 'Certificate of Analysis',
  bpom_filing: 'BPOM Filing',
};

const FIELD_ROWS: { key: keyof DocRow; label: string }[] = [
  { key: 'vendor_name', label: 'Vendor' },
  { key: 'document_number', label: 'Document No.' },
  { key: 'document_date', label: 'Date' },
  { key: 'product_name', label: 'Product' },
  { key: 'total_amount_idr', label: 'Total Amount' },
  { key: 'currency', label: 'Currency' },
  { key: 'bpom_reg_no', label: 'BPOM Reg. No.' },
];

// Element-type → overlay color (border + translucent fill). ai_parse_document tags
// each region as title / section_header / text / table / etc.
const TYPE_COLOR: Record<string, string> = {
  title: '#b45309', // amber-700 — matches the Tempo gold theme
  section_header: '#b45309',
  header: '#b45309',
  text: '#2563eb', // blue-600
  table: '#059669', // emerald-600
  list: '#7c3aed', // violet-600
  figure: '#db2777', // pink-600
};
const typeColor = (t: string) => TYPE_COLOR[t?.toLowerCase()] ?? '#6b7280';

// Normalize text for best-effort field→element matching (drop punctuation/whitespace).
const norm = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[\s,.:；;/\\—–-]+/g, '')
    .trim();

function parseElements(json: string | undefined | null): ParsedElement[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as ParsedElement[];
    return Array.isArray(arr) ? arr.filter((e) => Array.isArray(e.coord) && e.coord.length === 4) : [];
  } catch {
    return [];
  }
}

export function DocumentIntelligencePage() {
  const { data, loading, error } = useAnalyticsQuery('documents_extracted', {});
  const docs = useMemo(() => data ?? [], [data]);
  const [selId, setSelId] = useState<string | null>(null);
  // The element highlighted on the page: either hovered/clicked on the image, or
  // matched from a clicked extracted-field value. { id, source } drives the styling.
  const [activeEl, setActiveEl] = useState<string | null>(null);

  const types = useMemo(() => Array.from(new Set(docs.map((d) => d.doc_type))), [docs]);
  const selected: DocRow | undefined = docs.find((d) => d.doc_id === selId) ?? docs[0];
  const activeDocId = selected?.doc_id ?? '';

  // Cheap per-doc payload: the rasterized page image + ai_parse element boxes.
  const pageParams = useMemo(() => ({ doc_id: sql.string(activeDocId) }), [activeDocId]);
  const page = useAnalyticsQuery('document_page', pageParams, { autoStart: !!activeDocId });
  const pageRow = page.data?.[0];
  const elements = useMemo(() => parseElements(pageRow?.elements_json), [pageRow?.elements_json]);
  const pw = pageRow?.page_width ?? 0;
  const ph = pageRow?.page_height ?? 0;
  const hasImage = !!pageRow?.image_base64 && pw > 0 && ph > 0;

  // Click an extracted field → highlight the element whose parsed content contains it.
  const highlightField = (value: string) => {
    const target = norm(value);
    if (!target || target.length < 2) return;
    const match = elements.find((e) => {
      const c = norm(e.content);
      return c.includes(target) || target.includes(c);
    });
    setActiveEl(match ? match.id : null);
  };

  const activeElement = elements.find((e) => e.id === activeEl) ?? null;

  return (
    <div className="space-y-5 w-full max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full ts-header text-white shadow-sm">
            <ScanText className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-foreground leading-tight">Document Intelligence</h2>
            <p className="text-sm text-muted-foreground">
              See the parsed document, the located regions and the extracted fields — invoices, POs, COAs &amp; BPOM filings
            </p>
          </div>
        </div>
        <Badge variant="secondary" className="gap-1"><Sparkles className="h-3 w-3" /> ai_parse_document + ai_extract</Badge>
      </div>

      <Alert>
        <AlertDescription className="text-xs">
          <strong>How it works.</strong> Raw supply-chain documents in a Unity Catalog Volume are parsed by{' '}
          <code>ai_parse_document</code> into text and located regions (bounding boxes), then{' '}
          <code>ai_extract</code> pulls the regulated commercial fields — all in SQL on the governed SQL warehouse,
          no external OCR service. The page below shows the actual document with each parsed region overlaid;
          click an extracted field to find where it sits on the page.
        </AlertDescription>
      </Alert>

      {error && <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">Error: {error}</div>}

      {loading && !data ? (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <Skeleton className="h-[560px] w-full" />
          <Skeleton className="h-[560px] w-full lg:col-span-2" />
          <Skeleton className="h-[560px] w-full" />
        </div>
      ) : docs.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="py-16 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <div className="font-medium text-foreground">No parsed documents yet</div>
            <div className="text-sm text-muted-foreground mt-1">
              The document pipeline (<code>ai_parse_document</code> over the sample invoices / POs / COAs / BPOM
              filings into <code>ts_parsed_documents</code>) has not populated results. Once documents exist,
              the page image, located regions and extracted fields appear here automatically.
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {types.length > 1 && (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {types.map((t) => (
                <Badge key={t} variant="outline">{DOC_TYPE_LABEL[t] ?? t} · {docs.filter((d) => d.doc_type === t).length}</Badge>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* -------- document list -------- */}
            <Card className="shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4 text-primary" /> Documents ({docs.length})</CardTitle></CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[560px]">
                  <div className="divide-y">
                    {docs.map((d) => {
                      const active = (selected?.doc_id ?? '') === d.doc_id;
                      return (
                        <button
                          key={d.doc_id}
                          onClick={() => { setSelId(d.doc_id); setActiveEl(null); }}
                          className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-accent' : 'hover:bg-muted'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm text-foreground truncate">{d.file_name}</span>
                            <Badge variant="secondary" className="shrink-0 text-[10px]">{DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">{d.vendor_name || d.product_name || d.document_number}</div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* -------- document image + bbox overlays -------- */}
            <Card className="shadow-sm lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ScanText className="h-4 w-4 text-primary" /> Parsed Document
                  <span className="text-xs font-normal text-muted-foreground">· ai_parse_document</span>
                  {elements.length > 0 && <Badge variant="outline" className="ml-auto text-[10px]">{elements.length} regions</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {page.loading && !pageRow ? (
                  <Skeleton className="h-[500px] w-full" />
                ) : hasImage ? (
                  <>
                    <ScrollArea className="h-[500px] rounded-md border bg-muted/30">
                      <div className="relative w-full select-none" style={{ aspectRatio: `${pw} / ${ph}` }}>
                        <img
                          src={`data:image/png;base64,${pageRow?.image_base64}`}
                          alt={selected?.file_name ?? 'document'}
                          className="block w-full h-auto"
                          draggable={false}
                        />
                        {elements.map((e) => {
                          if (!e.coord) return null;
                          // Clamp to the image bounds: ai_parse occasionally over-estimates a
                          // region edge slightly beyond the page, which would otherwise overflow.
                          const x0 = Math.max(0, Math.min(e.coord[0], pw));
                          const y0 = Math.max(0, Math.min(e.coord[1], ph));
                          const x1 = Math.max(0, Math.min(e.coord[2], pw));
                          const y1 = Math.max(0, Math.min(e.coord[3], ph));
                          const color = typeColor(e.type);
                          const isActive = e.id === activeEl;
                          return (
                            <div
                              key={e.id}
                              onMouseEnter={() => setActiveEl(e.id)}
                              onClick={() => setActiveEl(e.id)}
                              title={`${e.type}: ${e.content}`}
                              className="absolute cursor-pointer transition-colors"
                              style={{
                                left: `${(x0 / pw) * 100}%`,
                                top: `${(y0 / ph) * 100}%`,
                                width: `${((x1 - x0) / pw) * 100}%`,
                                height: `${((y1 - y0) / ph) * 100}%`,
                                border: `1.5px solid ${color}`,
                                background: isActive ? `${color}33` : 'transparent',
                                boxShadow: isActive ? `0 0 0 2px ${color}` : 'none',
                                borderRadius: 2,
                              }}
                            />
                          );
                        })}
                      </div>
                    </ScrollArea>

                    {/* legend + active-region readout */}
                    <div className="mt-3 space-y-2">
                      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                        {Array.from(new Set(elements.map((e) => e.type.toLowerCase()))).map((t) => (
                          <span key={t} className="inline-flex items-center gap-1">
                            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ border: `1.5px solid ${typeColor(t)}` }} />
                            {t}
                          </span>
                        ))}
                      </div>
                      {activeElement ? (
                        <div className="rounded-md border bg-accent/40 p-2.5 text-xs">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ border: `1.5px solid ${typeColor(activeElement.type)}` }} />
                            <span className="font-semibold uppercase tracking-wide text-muted-foreground">{activeElement.type}</span>
                          </div>
                          <div className="text-foreground/90 whitespace-pre-wrap leading-relaxed">{activeElement.content}</div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <MousePointerClick className="h-3.5 w-3.5" /> Hover a region on the page, or click an extracted field to locate it.
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="space-y-3">
                    <Alert>
                      <AlertDescription className="text-xs">
                        Page image not available for this document — showing the parsed text instead.
                      </AlertDescription>
                    </Alert>
                    <ScrollArea className="h-[440px]">
                      <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed pr-3">{pageRow?.parsed_text || selected?.parsed_text || 'No parsed text available.'}</pre>
                    </ScrollArea>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* -------- extracted fields + parsed text -------- */}
            <div className="space-y-4">
              <Card className="shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Table2 className="h-4 w-4 text-primary" /> Extracted Fields
                    <span className="text-xs font-normal text-muted-foreground">· ai_extract</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {selected ? (
                    <div className="space-y-1">
                      <p className="text-[11px] text-muted-foreground mb-2">Click a value to locate it on the page.</p>
                      {FIELD_ROWS.map((f) => {
                        const v = String(selected[f.key] ?? '').trim();
                        const clickable = v.length > 1 && hasImage;
                        return (
                          <div key={f.key} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">{f.label}</span>
                            {v ? (
                              <button
                                type="button"
                                disabled={!clickable}
                                onClick={() => highlightField(v)}
                                className={`text-sm font-medium text-right ${clickable ? 'text-primary hover:underline underline-offset-2 cursor-pointer' : 'text-foreground cursor-default'}`}
                              >
                                {v}
                              </button>
                            ) : (
                              <span className="text-sm text-muted-foreground italic">—</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : <div className="text-sm text-muted-foreground">Select a document.</div>}
                </CardContent>
              </Card>

              <Card className="shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ScanText className="h-4 w-4 text-primary" /> Parsed Text</CardTitle></CardHeader>
                <CardContent>
                  {selected ? (
                    <ScrollArea className="h-[220px]">
                      <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed pr-3">{pageRow?.parsed_text || selected.parsed_text || 'No parsed text available for this document.'}</pre>
                    </ScrollArea>
                  ) : <div className="text-sm text-muted-foreground">Select a document.</div>}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
