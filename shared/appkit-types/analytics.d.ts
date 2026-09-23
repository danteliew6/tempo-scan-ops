// Hand-maintained to mirror config/queries/*.sql for the Tempo Scan build.
// The orchestrator re-runs `npm run typegen` against the live SQL warehouse after
// deploy (typegen needs a warehouse connection, so it is regenerated there).
import "@databricks/appkit-ui/react";
import type { SQLStringMarker } from "@databricks/appkit-ui/js";

declare module "@databricks/appkit-ui/react" {
  interface QueryRegistry {
    whoami: {
        name: "whoami";
        parameters: Record<string, never>;
        result: Array<{
          /** @sqlType STRING */
          identity: string;
          /** @sqlType BOOLEAN */
          is_ws_admin: boolean;
        }>;
      };
    persona_summary: {
        name: "persona_summary";
        parameters: {
          /** STRING - use sql.string() */
          persona: SQLStringMarker;
        };
        result: Array<{
          /** @sqlType BOOLEAN */
          pii_visible: boolean;
          /** @sqlType STRING */
          allowed_region: string;
          /** @sqlType BIGINT */
          visible_sales: number;
          /** @sqlType BIGINT */
          visible_regions: number;
        }>;
      };
    persona_accounts: {
        name: "persona_accounts";
        parameters: {
          /** STRING - use sql.string() */
          persona: SQLStringMarker;
        };
        result: Array<{
          /** @sqlType STRING */
          account_id: string;
          /** @sqlType STRING */
          contact_name: string;
          /** @sqlType STRING */
          nik: string;
          /** @sqlType STRING */
          email: string;
          /** @sqlType STRING */
          phone: string;
          /** @sqlType STRING */
          region: string;
          /** @sqlType STRING */
          outlet_id: string;
          /** @sqlType STRING */
          account_type: string;
        }>;
      };
    persona_sales_by_region: {
        name: "persona_sales_by_region";
        parameters: {
          /** STRING - use sql.string() */
          persona: SQLStringMarker;
        };
        result: Array<{
          /** @sqlType STRING */
          region: string;
          /** @sqlType BIGINT */
          orders: number;
          /** @sqlType DOUBLE */
          net_bn_idr: number;
        }>;
      };
    documents_extracted: {
        name: "documents_extracted";
        parameters: Record<string, never>;
        result: Array<{
          /** @sqlType STRING */
          doc_id: string;
          /** @sqlType STRING */
          doc_type: string;
          /** @sqlType STRING */
          file_name: string;
          /** @sqlType STRING */
          parsed_text: string;
          /** @sqlType STRING */
          vendor_name: string;
          /** @sqlType STRING */
          document_number: string;
          /** @sqlType STRING */
          document_date: string;
          /** @sqlType STRING */
          total_amount_idr: string;
          /** @sqlType STRING */
          currency: string;
          /** @sqlType STRING */
          bpom_reg_no: string;
          /** @sqlType STRING */
          product_name: string;
        }>;
      };
    document_page: {
        name: "document_page";
        parameters: {
          /** STRING - use sql.string() */
          doc_id: SQLStringMarker;
        };
        result: Array<{
          /** @sqlType STRING */
          doc_id: string;
          /** @sqlType STRING */
          doc_type: string;
          /** @sqlType STRING */
          file_name: string;
          /** @sqlType STRING */
          parsed_text: string;
          /** @sqlType STRING - JSON array of {id,type,content,coord,page_id} */
          elements_json: string;
          /** @sqlType STRING - base64 PNG of the page @150 DPI */
          image_base64: string;
          /** @sqlType INT */
          page_width: number;
          /** @sqlType INT */
          page_height: number;
        }>;
      };
  }
}
