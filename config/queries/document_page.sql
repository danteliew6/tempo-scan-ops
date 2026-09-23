-- @param doc_id STRING
-- Document Intelligence — single-document page payload for the /documents viewer.
--
-- Cheap companion to documents_extracted.sql: that query runs ai_extract (expensive)
-- across all docs for the list + structured fields; this one reads ONE document's
-- already-parsed artifacts directly from ts_parsed_documents so the viewer can render
-- the actual page image with bounding-box overlays without re-parsing.
--
--   parsed_text   : plain text (element contents joined) for the text panel
--   elements_json : JSON array of {id, type, content, coord:[x0,y0,x1,y1], page_id}
--                   from ai_parse_document — the overlay boxes
--   image_base64  : first page rasterized to PNG @150 DPI (base64) — the backdrop
--   page_width/height : pixel dims of that image; the UI positions each box as a
--                   percentage (coord / page_width) so overlays scale to any size.
SELECT
  doc_id,
  doc_type,
  file_name,
  parsed_text,
  elements_json,
  image_base64,
  page_width,
  page_height
FROM dante_classic_stable_catalog.tempo_scan_supply_chain.ts_parsed_documents
WHERE doc_id = :doc_id
LIMIT 1;
