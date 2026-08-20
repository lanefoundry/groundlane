declare namespace Cloudflare {
  interface Env {
    GROUNDLANE_AUTH_TOKEN: string;
    TAVILY_API_KEY?: string;
    EXA_API_KEY?: string;
    BRAVE_API_KEY?: string;
    FIRECRAWL_API_KEY?: string;
    SERPAPI_API_KEY?: string;
    BROWSERBASE_API_KEY?: string;
    PARALLEL_API_KEY?: string;
    BROWSERLESS_TOKEN?: string;
  }
}

interface SubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}
