declare global {
  namespace Cloudflare {
    interface Env {
      GROUNDLANE_AUTH_TOKEN: string;
      OAUTH_KV: KVNamespace;
      OAUTH_OWNER_PASSPHRASE: string;
      /**
       * Managed-credential admin token (PRD 694/709). Operator-only; never a
       * data-plane credential. Absent by default: the admin surface stays
       * unavailable while data-plane profiles keep serving.
       */
      GROUNDLANE_ADMIN_TOKEN?: string;
      /**
       * Signing secret for the bounded Worker-to-Container internal principal
       * context (PRD 707). Must differ from every auth/data-plane/provider
       * secret. It also body-binds artifact parsing across the boundary.
       */
      GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
      /** Dedicated HMAC secret for opaque modern MCP requestState tokens. */
      GROUNDLANE_MCP_REQUEST_STATE_SECRET?: string;
      /** Container MCP rollout posture. */
      GROUNDLANE_MCP_PROTOCOL_MODE?: "legacy-only" | "dual" | "modern-only";
      /**
       * D1 registry for managed-credential verifiers/metadata (PRD 696/706).
       * Commented out in wrangler.jsonc until provisioned; the D1-backed
       * ManagedTokenStore adapter is pending.
       */
      MANAGED_TOKEN_D1?: D1Database;
      /**
       * R2 bucket for durable ArtifactRef storage (PRD 667/723). The Worker
       * owns upload/finalize/read; storage coordinates never enter MCP refs.
       */
      GROUNDLANE_ARTIFACTS?: R2Bucket;
      /** Account and bucket used only to construct direct R2 S3 upload URLs. */
      R2_ACCOUNT_ID?: string;
      R2_BUCKET_NAME?: string;
      /** Scoped object read/write credentials used only for SigV4 presigning. */
      R2_ACCESS_KEY_ID?: string;
      R2_SECRET_ACCESS_KEY?: string;
      /** Operator caps for upload intents and finalized source artifacts. */
      DOCUMENT_UPLOAD_MAX_TTL_SECONDS?: string;
      DOCUMENT_ARTIFACT_MAX_TTL_SECONDS?: string;
      /** Explicit opt-in and operator TTL bounds for the D1/R2 document cache. */
      DOCUMENT_CACHE_EDGE_ENABLED?: "true" | "false";
      DOCUMENT_OUTPUT_EDGE_ENABLED?: "true" | "false";
      /** Explicit paid-provider opt-in. Secret stays at the Worker, never forwarded to Container. */
      DOCUMENT_ASYNC_EDGE_ENABLED?: "true" | "false";
      REDUCTO_API_KEY?: string;
      DOCUMENT_CACHE_DEFAULT_TTL_SECONDS?: string;
      DOCUMENT_CACHE_MAX_TTL_SECONDS?: string;
      /** Injected by @cloudflare/workers-oauth-provider at request time; not a configured binding. */
      OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
      TAVILY_API_KEY?: string;
      EXA_API_KEY?: string;
      BRAVE_API_KEY?: string;
      FIRECRAWL_API_KEY?: string;
      SERPAPI_API_KEY?: string;
      SEARCHAPI_API_KEY?: string;
      BROWSERBASE_API_KEY?: string;
      PARALLEL_API_KEY?: string;
      LINKUP_API_KEY?: string;
      KEENABLE_API_KEY?: string;
      TINYFISH_API_KEY?: string;
      SERPER_API_KEY?: string;
      YOU_API_KEY?: string;
      BROWSERLESS_TOKEN?: string;
      /** Cloudflare Analytics Engine dataset for groundlane error events. */
      ERROR_LOG?: AnalyticsEngineDataset;
      /** Cloudflare account ID for SQL query API access. */
      ERROR_LOG_ACCOUNT_ID?: string;
      /** Cloudflare API token with Analytics Engine read scope. */
      ERROR_LOG_API_TOKEN?: string;
    }
  }

  interface SubtleCrypto {
    timingSafeEqual(
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView,
    ): boolean;
  }
}

export {};
