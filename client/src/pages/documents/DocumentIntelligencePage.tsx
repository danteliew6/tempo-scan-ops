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
import { useMemo, useState } from 'react';
import { FileText, ScanText, Table2, Sparkles } from 'lucide-react';

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

export function DocumentIntelligencePage() {
  const { data, loading, error } = useAnalyticsQuery('documents_extracted', {});
  const docs = useMemo(() => data ?? [], [data]);
  const [selId, setSelId] = useState<string | null>(null);

  const types = useMemo(() => Array.from(new Set(docs.map((d) => d.doc_type))), [docs]);
  const selected: DocRow | undefined = docs.find((d) => d.doc_id === selId) ?? docs[0];

  return (
    <div className="space-y-5 w-full max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full ts-header text-white shadow-sm">
            <ScanText className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-foreground leading-tight">Document Intelligence</h2>
            <p className="text-sm text-muted-foreground">
              Parse &amp; extract structured fields from invoices, POs, COAs &amp; BPOM filings — with AI functions on the warehouse
            </p>
          </div>
        </div>
        <Badge variant="secondary" className="gap-1"><Sparkles className="h-3 w-3" /> ai_parse_document + ai_extract</Badge>
      </div>

      <Alert>
        <AlertDescription className="text-xs">
          <strong>How it works.</strong> Raw supply-chain documents in a Unity Catalog Volume are turned into
          text by <code>ai_parse_document</code>, then <code>ai_extract</code> pulls the regulated commercial
          fields (vendor, document number, totals, BPOM registration) — all in SQL on the governed SQL warehouse,
          no external OCR service. Results below are live query output; nothing is fabricated.
        </AlertDescription>
      </Alert>

      {error && <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">Error: {error}</div>}

      {loading && !data ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full lg:col-span-2" />
        </div>
      ) : docs.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="py-16 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <div className="font-medium text-foreground">No parsed documents yet</div>
            <div className="text-sm text-muted-foreground mt-1">
              The document pipeline (<code>ai_parse_document</code> over the sample invoices / POs / COAs / BPOM
              filings into <code>ts_parsed_documents</code>) has not populated results. Once documents exist,
              extracted fields appear here automatically.
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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* document list */}
            <Card className="shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4 text-primary" /> Documents ({docs.length})</CardTitle></CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[460px]">
                  <div className="divide-y">
                    {docs.map((d) => {
                      const active = (selected?.doc_id ?? '') === d.doc_id;
                      return (
                        <button key={d.doc_id} onClick={() => setSelId(d.doc_id)}
                          className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-accent' : 'hover:bg-muted'}`}>
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

            {/* parsed text + extracted fields */}
            <div className="lg:col-span-2 space-y-4">
              <Card className="shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Table2 className="h-4 w-4 text-primary" /> Extracted Fields <span className="text-xs font-normal text-muted-foreground">· ai_extract</span></CardTitle></CardHeader>
                <CardContent>
                  {selected ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                      {FIELD_ROWS.map((f) => {
                        const v = String(selected[f.key] ?? '').trim();
                        return (
                          <div key={f.key} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">{f.label}</span>
                            <span className="text-sm font-medium text-foreground text-right">{v || <span className="text-muted-foreground italic">—</span>}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : <div className="text-sm text-muted-foreground">Select a document.</div>}
                </CardContent>
              </Card>

              <Card className="shadow-sm">
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ScanText className="h-4 w-4 text-primary" /> Parsed Text <span className="text-xs font-normal text-muted-foreground">· ai_parse_document</span></CardTitle></CardHeader>
                <CardContent>
                  {selected ? (
                    <ScrollArea className="h-[240px]">
                      <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed pr-3">{selected.parsed_text || 'No parsed text available for this document.'}</pre>
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
