declare global {
  namespace Cloudflare {
    interface Env {
      GROUNDLANE_AUTH_TOKEN: string;
      OAUTH_KV: KVNamespace;
      OAUTH_OWNER_PASSPHRASE: string;
      /** Injected by @cloudflare/workers-oauth-provider at request time; not a configured binding. */
      OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
      TAVILY_API_KEY?: string;
      EXA_API_KEY?: string;
      BRAVE_API_KEY?: string;
      FIRECRAWL_API_KEY?: string;
      SERPAPI_API_KEY?: string;
      BROWSERBASE_API_KEY?: string;
      PARALLEL_API_KEY?: string;
      LINKUP_API_KEY?: string;
      SERPER_API_KEY?: string;
      YOU_API_KEY?: string;
      BROWSERLESS_TOKEN?: string;
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
