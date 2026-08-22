import { DisabledBrowserBackend } from "./adapters/browser/disabled.js";
import { BrowserlessBackend } from "./adapters/browser/browserless.js";
import { LocalPlaywrightBrowserBackend } from "./adapters/browser/local-playwright.js";
import { SafeHttpFetcher } from "./adapters/http/undici-fetcher.js";
import { JinaReaderBackend } from "./adapters/reader/jina.js";
import { BraveSearchProvider } from "./adapters/search/brave.js";
import { BrowserbaseSearchProvider } from "./adapters/search/browserbase.js";
import { ExaSearchProvider } from "./adapters/search/exa.js";
import { FirecrawlSearchProvider } from "./adapters/search/firecrawl.js";
import { LinkupSearchProvider } from "./adapters/search/linkup.js";
import { ParallelSearchProvider } from "./adapters/search/parallel.js";
import { SerperSearchProvider } from "./adapters/search/serper.js";
import { SerpApiSearchProvider } from "./adapters/search/serpapi.js";
import { TavilySearchProvider } from "./adapters/search/tavily.js";
import { YouSearchProvider } from "./adapters/search/you.js";
import type { GroundlaneConfig } from "./config.js";
import type { BrowserBackend, SearchProvider } from "./core/contracts.js";
import { FetchPipeline } from "./core/fetch-pipeline.js";
import { ConcurrencyLimiter } from "./core/limits.js";
import { SearchRouter } from "./core/search-router.js";
import { MonthlySearchBudget } from "./core/search-budget.js";
import { createMcpRegistry, type McpRegistryFactory } from "./mcp/registry.js";
import { createWebExtractModule } from "./tools/web-extract.js";
import { createWebFetchModule } from "./tools/web-fetch.js";
import { createWebSearchModule } from "./tools/web-search.js";

export interface GroundlaneServices {
  registryFactory: McpRegistryFactory;
  close(): Promise<void>;
}

export function createSearchProviders(config: GroundlaneConfig): SearchProvider[] {
  const providers: SearchProvider[] = [];
  if (config.providerKeys.tavily !== undefined) {
    providers.push(new TavilySearchProvider({ apiKey: config.providerKeys.tavily }));
  }
  if (config.providerKeys.exa !== undefined) {
    providers.push(new ExaSearchProvider({ apiKey: config.providerKeys.exa }));
  }
  if (config.providerKeys.brave !== undefined) {
    providers.push(new BraveSearchProvider({ apiKey: config.providerKeys.brave }));
  }
  if (config.providerKeys.firecrawl !== undefined) {
    providers.push(new FirecrawlSearchProvider({ apiKey: config.providerKeys.firecrawl }));
  }
  if (config.providerKeys.serpapi !== undefined) {
    providers.push(new SerpApiSearchProvider({ apiKey: config.providerKeys.serpapi }));
  }
  if (config.providerKeys.browserbase !== undefined) {
    providers.push(new BrowserbaseSearchProvider({ apiKey: config.providerKeys.browserbase }));
  }
  if (config.providerKeys.parallel !== undefined) {
    providers.push(new ParallelSearchProvider({ apiKey: config.providerKeys.parallel }));
  }
  if (config.providerKeys.linkup !== undefined) {
    providers.push(new LinkupSearchProvider({ apiKey: config.providerKeys.linkup }));
  }
  if (config.providerKeys.serper !== undefined) {
    providers.push(new SerperSearchProvider({ apiKey: config.providerKeys.serper }));
  }
  if (config.providerKeys.you !== undefined) {
    providers.push(new YouSearchProvider({ apiKey: config.providerKeys.you }));
  }
  return providers;
}

export function createGroundlaneServices(config: GroundlaneConfig): GroundlaneServices {
  const browser: BrowserBackend =
    config.browserBackend === "local"
      ? new LocalPlaywrightBrowserBackend({ maxResponseBytes: config.maxResponseBytes })
      : config.browserBackend === "browserless"
        ? new BrowserlessBackend({
            token: config.browserlessToken ?? "",
            region: config.browserlessRegion,
          })
        : new DisabledBrowserBackend();
  const reader =
    config.readerBackend === "jina" ? new JinaReaderBackend() : undefined;
  const fetchPipeline = new FetchPipeline(new SafeHttpFetcher(), browser, reader);
  const providers = createSearchProviders(config);
  const searchRouter = new SearchRouter(
    providers,
    config.searchProviderOrder,
    undefined,
    new MonthlySearchBudget(config.searchMonthlyRequestBudgets),
  );
  const limiter = new ConcurrencyLimiter(config.maxConcurrency, config.maxQueue);
  const modules = [
    createWebFetchModule({
      pipeline: fetchPipeline,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebSearchModule({
      router: searchRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebExtractModule({
      pipeline: fetchPipeline,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      maxOutputChars: config.maxOutputChars,
    }),
  ];

  return {
    registryFactory: () => createMcpRegistry(modules),
    async close(): Promise<void> {
      await browser.close?.();
    },
  };
}
