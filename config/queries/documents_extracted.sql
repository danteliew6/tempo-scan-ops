-- Document Intelligence — structured-field extraction from parsed supply-chain
-- documents (invoices, purchase orders, COAs, BPOM regulatory filings), executed
-- LIVE on the SQL warehouse with ai_extract.
--
-- Upstream, ai_parse_document turns each raw file (PDF/scan) in a UC Volume into
-- plain text landed in ts_parsed_documents(doc_id, doc_type, file_name, parsed_text)
-- (see the document pipeline). This query then runs ai_extract over that text to
-- pull the regulated commercial fields the ops team cares about. Returns empty
-- until the orchestrator has generated + parsed the sample documents.
SELECT
  d.doc_id,
  d.doc_type,
  d.file_name,
  d.parsed_text,
  d.fields:vendor_name::string      AS vendor_name,
  d.fields:document_number::string  AS document_number,
  d.fields:document_date::string    AS document_date,
  d.fields:total_amount_idr::string AS total_amount_idr,
  d.fields:currency::string         AS currency,
  d.fields:bpom_reg_no::string      AS bpom_reg_no,
  d.fields:product_name::string     AS product_name
FROM (
  SELECT
    doc_id, doc_type, file_name, parsed_text,
    ai_extract(
      parsed_text,
      array('vendor_name', 'document_number', 'document_date',
            'total_amount_idr', 'currency', 'bpom_reg_no', 'product_name')
    ) AS fields
  FROM dante_classic_stable_catalog.tempo_scan_supply_chain.ts_parsed_documents
) d
ORDER BY d.doc_type, d.file_name
LIMIT 60;
