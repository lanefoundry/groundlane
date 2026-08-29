import { Container } from "@cloudflare/containers";

import {
  DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE,
  DEFAULT_SEARCH_PROVIDER_ORDER_VALUE,
} from "../core/search-provider-catalog.js";
import { handleWorkerRequest } from "./handler.js";

export class GroundlaneContainer extends Container<Cloudflare.Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
  override pingEndpoint = "/healthz";
  override envVars = {
    GROUNDLANE_AUTH_TOKEN: this.env.GROUNDLANE_AUTH_TOKEN,
    PORT: String(this.defaultPort),
    READER_BACKEND: this.env.READER_BACKEND ?? "disabled",
    BROWSER_BACKEND: this.env.BROWSER_BACKEND ?? "local",
    BROWSERLESS_TOKEN: this.env.BROWSERLESS_TOKEN ?? "",
    BROWSERLESS_REGION: this.env.BROWSERLESS_REGION ?? "sfo",
    SEARCH_PROVIDER_ORDER:
      this.env.SEARCH_PROVIDER_ORDER ?? DEFAULT_SEARCH_PROVIDER_ORDER_VALUE,
    SEARCH_MONTHLY_REQUEST_BUDGETS:
      this.env.SEARCH_MONTHLY_REQUEST_BUDGETS ??
      DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE,
    TAVILY_API_KEY: this.env.TAVILY_API_KEY ?? "",
    EXA_API_KEY: this.env.EXA_API_KEY ?? "",
    BRAVE_API_KEY: this.env.BRAVE_API_KEY ?? "",
    FIRECRAWL_API_KEY: this.env.FIRECRAWL_API_KEY ?? "",
    SERPAPI_API_KEY: this.env.SERPAPI_API_KEY ?? "",
    BROWSERBASE_API_KEY: this.env.BROWSERBASE_API_KEY ?? "",
    PARALLEL_API_KEY: this.env.PARALLEL_API_KEY ?? "",
    LINKUP_API_KEY: this.env.LINKUP_API_KEY ?? "",
    KEENABLE_API_KEY: this.env.KEENABLE_API_KEY ?? "",
    SERPER_API_KEY: this.env.SERPER_API_KEY ?? "",
    YOU_API_KEY: this.env.YOU_API_KEY ?? "",
    REQUEST_TIMEOUT_MS: this.env.REQUEST_TIMEOUT_MS ?? "30000",
    MAX_RESPONSE_BYTES: this.env.MAX_RESPONSE_BYTES ?? "2000000",
    MAX_OUTPUT_CHARS: this.env.MAX_OUTPUT_CHARS ?? "100000",
    MAX_CONCURRENCY: this.env.MAX_CONCURRENCY ?? "4",
    MAX_QUEUE: this.env.MAX_QUEUE ?? "16",
  };
}

export default {
  fetch(request, env, ctx) {
    return handleWorkerRequest(request, env, crypto.subtle, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
