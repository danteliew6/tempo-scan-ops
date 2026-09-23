"""Document Intelligence source — generate sample Tempo Scan documents, parse them
with ai_parse_document, and land ts_parsed_documents for the app's /documents page.

This backs the /documents viewer: the app shows the ACTUAL rasterized document page
with bounding-box overlays for every parsed element, next to the structured fields
that `documents_extracted.sql` pulls LIVE with ai_extract. So this stage produces,
per document, three things that make the viewer work:
  - parsed_text   : plain text (concat of element contents) — for the text panel
  - elements_json : JSON array of {id, type, content, coord:[x0,y0,x1,y1], page_id}
                    from ai_parse_document — for the bounding-box overlays
  - image_base64  : the PDF's first page rasterized to PNG at 150 DPI (base64) plus
                    page_width / page_height — the backdrop the boxes are drawn on

Coordinate space: ai_parse_document returns element bboxes in its internal render
space (A4 @ ~150 DPI ≈ 1240x1754 px, top-left origin). We rasterize the same page at
150 DPI so the image pixel space matches those coords; the UI then positions each box
as a percentage (coord / page_width) so it scales to any display size.

Flow (runs as a serverless spark_python_task in the DABs bootstrap job, or locally via
Databricks Connect):
  1. CREATE VOLUME <schema>.raw_documents
  2. generate ~12 sample PDFs into the volume (best-effort — the volume FUSE mount is
     only writable on Databricks compute; locally we reuse the PDFs already there)
  3. ai_parse_document(content, map('version','2.0')) over the volume → text + elements
  4. rasterize each PDF's first page to PNG @150 DPI (PyMuPDF) → base64 + page dims
  5. write ts_parsed_documents(doc_id, doc_type, file_name, parsed_text, elements_json,
     image_base64, page_width, page_height, volume_path, parsed_at)

Requires DBR 17.3+ for ai_parse_document (serverless env version that includes it).
"""
import base64
import os
import subprocess
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tempo_config import CATALOG, SCHEMA, S, fq, get_spark  # noqa: E402

VOLUME = "raw_documents"
VOL_DIR = f"/Volumes/{CATALOG}/{SCHEMA}/{VOLUME}"

# ---------------------------------------------------------------------------
# 1. sample document content (synthetic; real Tempo Scan brands, fake figures)
# ---------------------------------------------------------------------------
# Each tuple: (file_name, doc_type, title, list-of-(label, value) lines, footer lines)
_BRANDS = ["Bodrex", "Oskadon", "NEO Rheumason", "Hemaviton", "Marina", "My Baby", "Vitalis"]

_DOCS = [
    ("invoice_APL_2026_00841.pdf", "invoice", "PT Anugrah Pharmindo Lestari — TAX INVOICE", [
        ("Invoice No", "APL/2026/00841"),
        ("Invoice Date", "2026-09-03"),
        ("Distributor", "PT Anugrah Pharmindo Lestari (PT Tempo)"),
        ("Bill To", "Apotek Sehat Sentosa — Surabaya, Jawa Timur"),
        ("NPWP", "01.234.567.8-609.000"),
        ("Product", "Bodrex Extra 4x6 — SKU-00142"),
        ("Quantity", "480 boxes"),
        ("Unit Price (IDR)", "18,500"),
        ("Subtotal (IDR)", "8,880,000"),
        ("PPN 11% (IDR)", "976,800"),
        ("Total Due (IDR)", "9,856,800"),
        ("Payment Terms", "Net 30"),
        ("Due Date", "2026-10-03"),
    ], ["Goods remain property of PT Tempo Scan until paid in full.",
        "Cold-chain items excluded from this shipment."]),

    ("invoice_APL_2026_00907.pdf", "invoice", "PT Anugrah Pharmindo Lestari — TAX INVOICE", [
        ("Invoice No", "APL/2026/00907"),
        ("Invoice Date", "2026-09-11"),
        ("Bill To", "Guardian Pharmacy — Jakarta Selatan, DKI Jakarta"),
        ("Product", "Hemaviton Energy 10x4 — SKU-00318"),
        ("Quantity", "260 boxes"),
        ("Unit Price (IDR)", "42,000"),
        ("Subtotal (IDR)", "10,920,000"),
        ("PPN 11% (IDR)", "1,201,200"),
        ("Total Due (IDR)", "12,121,200"),
        ("Payment Terms", "Net 45"),
    ], ["Distributed by PT Tempo — Jakarta Distribution Center DC-001."]),

    ("invoice_APL_2026_00953.pdf", "invoice", "PT Anugrah Pharmindo Lestari — TAX INVOICE", [
        ("Invoice No", "APL/2026/00953"),
        ("Invoice Date", "2026-09-18"),
        ("Bill To", "Kimia Farma #218 — Medan, Sumatera Utara"),
        ("Product", "Oskadon SP 4x10 — SKU-00205"),
        ("Quantity", "600 boxes"),
        ("Unit Price (IDR)", "9,800"),
        ("Total Due (IDR)", "6,527,760"),
        ("Payment Terms", "Net 30"),
    ], ["Backorder note: 120 boxes pending — flu-season demand surge."]),

    ("po_TEMPO_PO_55120.pdf", "purchase_order", "PT Tempo — PURCHASE ORDER", [
        ("PO Number", "TEMPO-PO-55120"),
        ("PO Date", "2026-09-01"),
        ("Vendor", "Tempo Scan Pacific Manufacturing — Cikarang Plant"),
        ("Ship To", "Distribution Center DC-004 — Bandung, Jawa Barat"),
        ("Product", "NEO Rheumason Cream 30g — SKU-00461"),
        ("Quantity Ordered", "3,200 units"),
        ("Unit Cost (IDR)", "7,400"),
        ("Total (IDR)", "23,680,000"),
        ("Requested Delivery", "2026-09-15"),
        ("Buyer", "Supply Planning — Central"),
    ], ["Replenishment trigger: days-of-supply below reorder point."]),

    ("po_TEMPO_PO_55187.pdf", "purchase_order", "PT Tempo — PURCHASE ORDER", [
        ("PO Number", "TEMPO-PO-55187"),
        ("PO Date", "2026-09-08"),
        ("Vendor", "Tempo Scan Pacific Manufacturing — Cikarang Plant"),
        ("Ship To", "Distribution Center DC-002 — Surabaya, Jawa Timur"),
        ("Product", "Bodrex Flu & Batuk PE 4x4 — SKU-00171"),
        ("Quantity Ordered", "9,600 units"),
        ("Unit Cost (IDR)", "5,900"),
        ("Total (IDR)", "56,640,000"),
        ("Requested Delivery", "2026-09-14"),
        ("Priority", "EXPEDITE — flu-season stockout risk (Jawa)"),
    ], ["Expedited per demand-forecast alert."]),

    ("po_TEMPO_PO_55210.pdf", "purchase_order", "PT Tempo — PURCHASE ORDER", [
        ("PO Number", "TEMPO-PO-55210"),
        ("PO Date", "2026-09-12"),
        ("Ship To", "Distribution Center DC-007 — Palembang, Sumatera Selatan"),
        ("Product", "Marina Hand & Body Lotion 200ml — SKU-00612"),
        ("Quantity Ordered", "4,800 units"),
        ("Unit Cost (IDR)", "8,100"),
        ("Total (IDR)", "38,880,000"),
    ], ["Consumer-Health division — regular replenishment."]),

    ("coa_BATCH_BDX26091.pdf", "coa", "CERTIFICATE OF ANALYSIS (CoA)", [
        ("Product", "Bodrex Extra Tablet"),
        ("Batch No", "BDX-26091"),
        ("SKU", "SKU-00142"),
        ("Manufacture Date", "2026-06-15"),
        ("Expiry Date", "2028-06-14"),
        ("Active Ingredient", "Paracetamol 350mg, Caffeine 50mg"),
        ("Assay (Paracetamol)", "99.2% (spec 95.0–105.0%)"),
        ("Dissolution", "Pass (Q=80% in 30 min)"),
        ("Uniformity of Dosage", "Pass"),
        ("Microbial Limit", "Pass"),
        ("Result", "RELEASED"),
        ("QC Analyst", "Dept. Quality Control — Cikarang"),
    ], ["Complies with Farmakope Indonesia and BPOM release specification."]),

    ("coa_BATCH_HMV26074.pdf", "coa", "CERTIFICATE OF ANALYSIS (CoA)", [
        ("Product", "Hemaviton Energy Capsule"),
        ("Batch No", "HMV-26074"),
        ("SKU", "SKU-00318"),
        ("Manufacture Date", "2026-05-02"),
        ("Expiry Date", "2027-05-01"),
        ("Assay (Vitamin C)", "98.7% (spec 90.0–110.0%)"),
        ("Moisture Content", "3.1% (spec ≤5.0%)"),
        ("Result", "RELEASED"),
    ], ["Short shelf-life SKU — monitor days-to-expiry at DC level."]),

    ("coa_BATCH_OSK26102.pdf", "coa", "CERTIFICATE OF ANALYSIS (CoA)", [
        ("Product", "Oskadon SP Tablet"),
        ("Batch No", "OSK-26102"),
        ("SKU", "SKU-00205"),
        ("Manufacture Date", "2026-07-20"),
        ("Expiry Date", "2028-07-19"),
        ("Active Ingredient", "Paracetamol 500mg, Ibuprofen 200mg"),
        ("Assay", "100.4% (spec 95.0–105.0%)"),
        ("Result", "RELEASED"),
    ], ["Released for national distribution."]),

    ("bpom_reg_DKL2026001A1.pdf", "bpom_filing", "BADAN POM RI — REGISTRASI OBAT", [
        ("Nomor Registrasi (Reg. No.)", "DKL2026001A1"),
        ("Nama Produk (Product)", "Bodrex Extra Tablet"),
        ("Kategori (Category)", "Obat Bebas Terbatas (OTC)"),
        ("Pendaftar (Registrant)", "PT Tempo Scan Pacific Tbk"),
        ("Zat Aktif (Active)", "Paracetamol, Caffeine"),
        ("Tanggal Terbit (Issued)", "2026-02-10"),
        ("Masa Berlaku (Valid Until)", "2031-02-09"),
        ("Status", "DISETUJUI (APPROVED)"),
    ], ["Dokumen registrasi resmi Badan Pengawas Obat dan Makanan Republik Indonesia."]),

    ("bpom_reg_NC14260500123.pdf", "bpom_filing", "BADAN POM RI — NOTIFIKASI KOSMETIK", [
        ("Nomor Notifikasi (Notif. No.)", "NC14260500123"),
        ("Nama Produk (Product)", "Marina Hand & Body Lotion UV White 200ml"),
        ("Kategori (Category)", "Kosmetik / Personal Care"),
        ("Pendaftar (Registrant)", "PT Tempo Scan Pacific Tbk"),
        ("Tanggal Notifikasi (Date)", "2026-05-04"),
        ("Masa Berlaku (Valid Until)", "2029-05-03"),
        ("Status", "TERNOTIFIKASI (NOTIFIED)"),
    ], ["Notifikasi kosmetik sesuai peraturan BPOM."]),

    ("bpom_reg_DKL2026044B2.pdf", "bpom_filing", "BADAN POM RI — REGISTRASI OBAT", [
        ("Nomor Registrasi (Reg. No.)", "DKL2026044B2"),
        ("Nama Produk (Product)", "NEO Rheumason Cream 30g"),
        ("Kategori (Category)", "Obat Bebas (OTC topical)"),
        ("Pendaftar (Registrant)", "PT Tempo Scan Pacific Tbk"),
        ("Tanggal Terbit (Issued)", "2026-03-22"),
        ("Masa Berlaku (Valid Until)", "2031-03-21"),
        ("Status", "DISETUJUI (APPROVED)"),
    ], ["Registrasi obat luar (topikal)."]),
]


def _ensure_pkg(import_name, pip_name=None):
    try:
        __import__(import_name)
    except ImportError:
        pip_name = pip_name or import_name
        print(f"[docs] installing {pip_name} ...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", pip_name])


def _write_pdf(path, title, rows, footer):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    y = h - 30 * mm
    c.setFont("Helvetica-Bold", 15)
    c.drawString(25 * mm, y, title)
    y -= 6 * mm
    c.setLineWidth(0.6)
    c.line(25 * mm, y, w - 25 * mm, y)
    y -= 10 * mm
    c.setFont("Helvetica", 11)
    for label, value in rows:
        c.setFont("Helvetica-Bold", 11)
        c.drawString(25 * mm, y, f"{label}:")
        c.setFont("Helvetica", 11)
        c.drawString(85 * mm, y, str(value))
        y -= 7.5 * mm
    y -= 4 * mm
    c.setFont("Helvetica-Oblique", 9)
    for line in footer:
        c.drawString(25 * mm, y, line)
        y -= 5 * mm
    c.showPage()
    c.save()


def _rasterize_pages(spark):
    """Read each PDF from the volume, rasterize its first page to a 150-DPI PNG, and
    return a Spark DataFrame [file_name, image_base64, page_width, page_height].

    Works on Databricks compute and locally via Databricks Connect: we pull the raw
    file bytes through Spark's binaryFile reader (so no FUSE mount is required) and run
    PyMuPDF on the driver. 150 DPI keeps the pixel space aligned to ai_parse's bbox
    coords, so the UI can map coord/page_width -> percent for overlays.
    """
    _ensure_pkg("pymupdf")
    import pymupdf  # PyMuPDF (the modern module name; `fitz` alias is deprecated)

    file_rows = (
        spark.read.format("binaryFile").load(VOL_DIR).select("path", "content").collect()
    )
    out = []
    for r in file_rows:
        file_name = r["path"].rsplit("/", 1)[-1]
        if not file_name.lower().endswith(".pdf"):
            continue
        try:
            doc = pymupdf.open(stream=bytes(r["content"]), filetype="pdf")
            page = doc.load_page(0)
            pix = page.get_pixmap(dpi=150)
            b64 = base64.b64encode(pix.tobytes("png")).decode("ascii")
            out.append((file_name, b64, int(pix.width), int(pix.height)))
            doc.close()
        except Exception as e:  # noqa: BLE001 — one bad PDF shouldn't kill the batch
            print(f"[docs] WARN rasterize failed for {file_name}: {e}")
    print(f"[docs] rasterized {len(out)} page images @150 DPI")
    return spark.createDataFrame(
        out, schema="file_name STRING, image_base64 STRING, page_width INT, page_height INT"
    )


def main():
    spark = get_spark()

    # 1. volume
    spark.sql(f"CREATE VOLUME IF NOT EXISTS {S}.{VOLUME} "
              f"COMMENT 'Sample Tempo Scan documents for ai_parse_document (synthetic).'")
    print(f"[docs] volume ready: {VOL_DIR}")

    # 2. generate PDFs into the volume — best-effort. The volume FUSE mount is writable
    #    on Databricks compute; running locally via Databricks Connect it is not, so we
    #    fall back to the PDFs already present in the volume.
    try:
        _ensure_pkg("reportlab")
        for file_name, _doc_type, title, rows, footer in _DOCS:
            _write_pdf(os.path.join(VOL_DIR, file_name), title, rows, footer)
        print(f"[docs] wrote {len(_DOCS)} sample PDFs to volume")
    except Exception as e:  # noqa: BLE001
        print(f"[docs] skip PDF generation (using existing volume PDFs): {e}")

    # doc_type lookup so we don't rely on the classifier for the known set
    type_map = {fn: dt for (fn, dt, *_rest) in _DOCS}
    type_case = " ".join(
        f"WHEN '{fn}' THEN '{dt}'" for fn, dt in type_map.items()
    )

    # 3. parse -> staging temp view (parsed_text + elements_json with bbox coords)
    #    elements_json: JSON array of {id, type, content, coord:[x0,y0,x1,y1], page_id}
    #    from the first bbox of each element (all our sample docs are single-page).
    spark.sql(f"""
    CREATE OR REPLACE TEMP VIEW _ts_parsed_stg AS
    WITH parsed AS (
      SELECT
        regexp_extract(path, '([^/]+)$', 1)                                   AS file_name,
        ai_parse_document(content, map('version','2.0'))                      AS doc
      FROM READ_FILES('{VOL_DIR}', format => 'binaryFile')
    )
    SELECT
      md5(file_name)                                                          AS doc_id,
      CASE file_name {type_case} ELSE 'other' END                            AS doc_type,
      file_name,
      concat_ws('\\n', transform(variant_get(doc, '$.document.elements', 'ARRAY<VARIANT>'), e -> e:content::STRING)) AS parsed_text,
      to_json(transform(
        variant_get(doc, '$.document.elements', 'ARRAY<VARIANT>'),
        e -> named_struct(
          'id',      e:id::STRING,
          'type',    e:type::STRING,
          'content', e:content::STRING,
          'coord',   from_json(to_json(e:bbox[0]:coord), 'ARRAY<DOUBLE>'),
          'page_id', e:bbox[0]:page_id::INT
        )
      ))                                                                       AS elements_json,
      concat('{VOL_DIR}/', file_name)                                         AS volume_path,
      current_timestamp()                                                     AS parsed_at
    FROM parsed
    -- On success ai_parse_document sets error_status to JSON null, which is NOT SQL NULL
    -- (a VARIANT holding json-null). Match both so successful parses are kept.
    WHERE doc:error_status IS NULL OR to_json(doc:error_status) = 'null'
    """)

    # 4. rasterize the document pages -> temp view keyed by file_name
    _rasterize_pages(spark).createOrReplaceTempView("_ts_doc_images")

    # 5. land ts_parsed_documents (parsed text + elements + page image + dims)
    spark.sql(f"""
    CREATE OR REPLACE TABLE {fq('ts_parsed_documents')} AS
    SELECT s.doc_id, s.doc_type, s.file_name, s.parsed_text, s.elements_json,
           i.image_base64, i.page_width, i.page_height,
           s.volume_path, s.parsed_at
    FROM _ts_parsed_stg s
    LEFT JOIN _ts_doc_images i USING (file_name)
    """)
    n = spark.table(fq("ts_parsed_documents")).count()
    print(f"[docs] ts_parsed_documents: {n} rows parsed (with elements + page images)")


if __name__ == "__main__":
    main()
