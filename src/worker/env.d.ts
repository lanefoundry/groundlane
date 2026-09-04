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
       * secret. Wiring the managed-token D1 adapter to this context is
       * pending; until then the managed-token data plane fails closed.
       */
      GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
      /**
       * D1 registry for managed-credential verifiers/metadata (PRD 696/706).
       * Commented out in wrangler.jsonc until provisioned; the D1-backed
       * ManagedTokenStore adapter is pending.
       */
      MANAGED_TOKEN_D1?: D1Database;
      /**
       * R2 bucket for durable async ArtifactRef storage (PRD 667/723).
       * Commented out in wrangler.jsonc until provisioned; the R2 storage
       * backend adapter is pending.
       */
      GROUNDLANE_ARTIFACTS?: R2Bucket;
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