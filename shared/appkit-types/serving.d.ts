// Hand-maintained to mirror the Tempo Scan serving endpoint (tempo-demand-forecast).
// The orchestrator re-runs `npm run typegen` against the live endpoint after deploy.
// Generated from serving endpoint OpenAPI schemas
import "@databricks/appkit";
import "@databricks/appkit-ui/react";

declare module "@databricks/appkit" {
  interface ServingEndpointRegistry {
    default: {
      request: Record<string, unknown>;
      response: {
        predictions?: {
          /** @openapi double — probability the SKU x DC batch trends to expiry write-off */
          expiry_risk_score?: number;
          /** @openapi double — probability of stockout within the horizon */
          stockout_risk_score?: number;
        }[];
      };
      chunk: unknown;
    };
  }
}

declare module "@databricks/appkit-ui/react" {
  interface ServingEndpointRegistry {
    default: {
      request: Record<string, unknown>;
      response: {
        predictions?: {
          /** @openapi double */
          expiry_risk_score?: number;
          /** @openapi double */
          stockout_risk_score?: number;
        }[];
      };
      chunk: unknown;
    };
  }
}
