import { DisabledBrowserBackend } from "./adapters/browser/disabled.js";
import { LinkupAnswerProvider } from "./adapters/answer/linkup.js";
import { YouAnswerProvider } from "./adapters/answer/you.js";
import { ExaContentProvider } from "./adapters/content/exa.js";
import { FirecrawlContentProvider } from "./adapters/content/firecrawl.js";
import { FirecrawlCrawlProvider } from "./adapters/crawl/firecrawl.js";
import { FirecrawlMapProvider } from "./adapters/map/firecrawl.js";
import { KeenableContentProvider } from "./adapters/content/keenable.js";
import { LinkupContentProvider } from "./adapters/content/linkup.js";
import { BraveImagesProvider } from "./adapters/images/brave.js";
import { SerperImagesProvider } from "./adapters/images/serper.js";
import { SerpApiImagesProvider } from "./adapters/images/serpapi.js";
import { BraveNewsProvider } from "./adapters/news/brave.js";
import { SerperNewsProvider } from "./adapters/news/serper.js";
import { SerpApiNewsProvider } from "./adapters/news/serpapi.js";
import { TavilyMapProvider } from "./adapters/map/tavily.js";
import { TavilyContentProvider } from "./adapters/content/tavily.js";
import { TavilyCrawlProvider } from "./adapters/crawl/tavily.js";
import { TinyFishContentProvider } from "./adapters/content/tinyfish.js";
import { YouContentProvider } from "./adapters/content/you.js";
import { BrowserlessBackend } from "./adapters/browser/browserless.js";
import { LinkupBalanceChecker } from "./adapters/balance/linkup.js";
import { FirecrawlBalanceChecker } from "./adapters/balance/firecrawl.js";
import { SerpApiBalanceChecker } from "./adapters/balance/serpapi.js";
import { YouBalanceChecker } from "./adapters/balance/you.js";
import { LinkupResearchProvider } from "./adapters/research/linkup.js";
import { ParallelResearchProvider } from "./adapters/research/parallel.js";
import { YouResearchProvider } from "./adapters/research/you.js";
import { LocalPlaywrightBrowserBackend } from "./adapters/browser/local-playwright.js";
import { SafeHttpFetcher } from "./adapters/http/undici-fetcher.js";
import { JinaReaderBackend } from "./adapters/reader/jina.js";
import { BraveSearchProvider } from "./adapters/search/brave.js";
import { BrowserbaseSearchProvider } from "./adapters/search/browserbase.js";
import { ExaSearchProvider } from "./adapters/search/exa.js";
import { FirecrawlSearchProvider } from "./adapters/search/firecrawl.js";
import { KeenableSearchProvider } from "./adapters/search/keenable.js";
import { LinkupSearchProvider } from "./adapters/search/linkup.js";
import { ParallelSearchProvider } from "./adapters/search/parallel.js";
import { SerperSearchProvider } from "./adapters/search/serper.js";
import { SerpApiSearchProvider } from "./adapters/search/serpapi.js";
import { SearchApiSearchProvider } from "./adapters/search/searchapi.js";
import { TavilySearchProvider } from "./adapters/search/tavily.js";
import { TinyFishSearchProvider } from "./adapters/search/tinyfish.js";
import { YouSearchProvider } from "./adapters/search/you.js";
import type { GroundlaneConfig } from "./config.js";
import type { AnswerProvider, BrowserBackend, ContentProvider, CrawlProvider, ImagesProvider, MapProvider, NewsProvider, ResearchProvider, SearchProvider } from "./core/contracts.js";
import { AnswerRouter } from "./core/answer-router.js";
import { ContentRouter } from "./core/content-router.js";
import { CrawlRouter } from "./core/crawl-router.js";
import { FetchPipeline } from "./core/fetch-pipeline.js";
import { ImagesRouter } from "./core/images-router.js";
import { ConcurrencyLimiter } from "./core/limits.js";
import { DynamicPenaltyHealthTracker } from "./core/provider-health.js";
import { MapRouter } from "./core/map-router.js";
import { NewsRouter } from "./core/news-router.js";
import { ProviderBalanceRegistry } from "./core/provider-balance.js";
import { builtInRegistry, type ProviderCapabilities } from "./core/provider-registry.js";
import { ResearchRouter } from "./core/research-router.js";
import { SearchRouter } from "./core/search-router.js";
import { CompositeSearchBudget, DailySearchBudget, MinuteRateLimiter, MonthlySearchBudget } from "./core/search-budget.js";
import { SourceAwareDocsResolver } from "./core/source-aware-docs.js";
import { createMcpRegistry, type McpRegistryFactory } from "./mcp/registry.js";
import { CrawlJobManager } from "./core/crawl-jobs.js";
import { CorpusStore, InMemoryCorpusBackend } from "./core/corpus-runtime.js";
import { createCrawlJobsModule } from "./tools/crawl-jobs.js";
import { createCorpusToolsModule } from "./tools/corpus-tools.js";
import { createDocumentPolicyModule } from "./tools/document-policy.js";
import { createWebExtractSchemaModule } from "./tools/web-extract-schema.js";
import { createProviderBalanceModule } from "./tools/provider-balance.js";
import { createProviderCapabilitiesModule } from "./tools/provider-capabilities.js";
import { createProviderQuotaModule } from "./tools/provider-quota.js";
import { createParseModule } from "./tools/parse.js";
import { createSearchBudgetStatusModule } from "./tools/search-budget-status.js";
import { createWebAnswerModule } from "./tools/web-answer.js";
import { createWebContentModule } from "./tools/web-content.js";
import { createWebCrawlModule } from "./tools/web-crawl.js";
import { createWebExtractModule } from "./tools/web-extract.js";
import { createWebFetchModule } from "./tools/web-fetch.js";
import { createWebImagesModule } from "./tools/web-images.js";
import { createWebMapModule } from "./tools/web-map.js";
import { createWebNewsModule } from "./tools/web-news.js";
import { createWebResearchModule } from "./tools/web-research.js";
import { createWebSearchModule } from "./tools/web-search.js";
import { createErrorLogModule } from "./tools/error-log.js";
import { getErrorLogSink } from "./tools/common.js";
import { NoopErrorSink } from "./core/error-log.js";
export interface GroundlaneServices {
  registryFactory: McpRegistryFactory;
  close(): Promise<void>;
}

interface AdapterEntry<T> {
  readonly providerId: string;
  readonly create: (apiKey?: string) => T;
  readonly requiresKey: boolean;
}

function providerKey(config: GroundlaneConfig, id: string): string | undefined {
  return (config.providerKeys as Partial<Record<string, string>>)[id];
}

function buildProviders<T>(
  capability: keyof ProviderCapabilities,
  adapters: readonly AdapterEntry<T>[],
  config: GroundlaneConfig,
): T[] {
  const providers: T[] = [];
  for (const adapter of adapters) {
    const reg = builtInRegistry.get(adapter.providerId);
    if (!reg?.capabilities[capability]) continue;
    const key = providerKey(config, adapter.providerId);
    if (adapter.requiresKey && key === undefined) continue;
    providers.push(adapter.create(key));
  }
  return providers;
}

const SEARCH_ADAPTERS: readonly AdapterEntry<SearchProvider>[] = [
  { providerId: "tavily", create: (key) => new TavilySearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "exa", create: (key) => new ExaSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "brave", create: (key) => new BraveSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "firecrawl", create: (key) => new FirecrawlSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "serpapi", create: (key) => new SerpApiSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "searchapi", create: (key) => new SearchApiSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "browserbase", create: (key) => new BrowserbaseSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "parallel", create: (key) => new ParallelSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "linkup", create: (key) => new LinkupSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "tinyfish", create: (key) => new TinyFishSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "keenable", create: (key) => new KeenableSearchProvider(key !== undefined ? { apiKey: key } : {}), requiresKey: false },
  { providerId: "serper", create: (key) => new SerperSearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "you", create: (key) => new YouSearchProvider(key !== undefined ? { apiKey: key } : {}), requiresKey: false },
];

const ANSWER_ADAPTERS: readonly AdapterEntry<AnswerProvider>[] = [
  { providerId: "linkup", create: (key) => new LinkupAnswerProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "you", create: (key) => new YouAnswerProvider({ apiKey: key! }), requiresKey: true },
];

const RESEARCH_ADAPTERS: readonly AdapterEntry<ResearchProvider>[] = [
  { providerId: "linkup", create: (key) => new LinkupResearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "you", create: (key) => new YouResearchProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "parallel", create: (key) => new ParallelResearchProvider({ apiKey: key! }), requiresKey: true },
];

const CONTENT_ADAPTERS: readonly AdapterEntry<ContentProvider>[] = [
  { providerId: "linkup", create: (key) => new LinkupContentProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "you", create: (key) => new YouContentProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "exa", create: (key) => new ExaContentProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "tavily", create: (key) => new TavilyContentProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "firecrawl", create: (key) => new FirecrawlContentProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "tinyfish", create: (key) => new TinyFishContentProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "keenable", create: (key) => new KeenableContentProvider(key !== undefined ? { apiKey: key } : {}), requiresKey: false },
];

const MAP_ADAPTERS: readonly AdapterEntry<MapProvider>[] = [
  { providerId: "firecrawl", create: (key) => new FirecrawlMapProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "tavily", create: (key) => new TavilyMapProvider({ apiKey: key! }), requiresKey: true },
];

const CRAWL_ADAPTERS: readonly AdapterEntry<CrawlProvider>[] = [
  { providerId: "firecrawl", create: (key) => new FirecrawlCrawlProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "tavily", create: (key) => new TavilyCrawlProvider({ apiKey: key! }), requiresKey: true },
];

const NEWS_ADAPTERS: readonly AdapterEntry<NewsProvider>[] = [
  { providerId: "brave", create: (key) => new BraveNewsProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "serper", create: (key) => new SerperNewsProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "serpapi", create: (key) => new SerpApiNewsProvider({ apiKey: key! }), requiresKey: true },
];

const IMAGES_ADAPTERS: readonly AdapterEntry<ImagesProvider>[] = [
  { providerId: "brave", create: (key) => new BraveImagesProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "serper", create: (key) => new SerperImagesProvider({ apiKey: key! }), requiresKey: true },
  { providerId: "serpapi", create: (key) => new SerpApiImagesProvider({ apiKey: key! }), requiresKey: true },
];

export function createSearchProviders(config: GroundlaneConfig): SearchProvider[] {
  return buildProviders("search", SEARCH_ADAPTERS, config);
}

export function createAnswerProviders(config: GroundlaneConfig): AnswerProvider[] {
  return buildProviders("answer", ANSWER_ADAPTERS, config);
}

export function createResearchProviders(config: GroundlaneConfig): ResearchProvider[] {
  return buildProviders("research", RESEARCH_ADAPTERS, config);
}

export function createContentProviders(config: GroundlaneConfig): ContentProvider[] {
  return buildProviders("content", CONTENT_ADAPTERS, config);
}

export function createMapProviders(config: GroundlaneConfig): MapProvider[] {
  return buildProviders("map", MAP_ADAPTERS, config);
}

export function createCrawlProviders(config: GroundlaneConfig): CrawlProvider[] {
  return buildProviders("crawl", CRAWL_ADAPTERS, config);
}

export function createNewsProviders(config: GroundlaneConfig): NewsProvider[] {
  return buildProviders("news", NEWS_ADAPTERS, config);
}

export function createImagesProviders(config: GroundlaneConfig): ImagesProvider[] {
  return buildProviders("images", IMAGES_ADAPTERS, config);
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
  const backendBudgetTrackers: import("./core/search-budget.js").SearchBudgetTracker[] = [
    new MinuteRateLimiter({ jina: config.jinaReaderRpm }),
  ];
  if (config.browserBackend === "browserless") {
    backendBudgetTrackers.push(new MonthlySearchBudget({ browserless: config.browserlessMonthlyUnits }));
  }
  const backendBudget = new CompositeSearchBudget(backendBudgetTrackers);
  const httpFetcher = new SafeHttpFetcher();
  const fetchPipeline = new FetchPipeline(
    httpFetcher,
    browser,
    reader,
    backendBudget,
    new SourceAwareDocsResolver(httpFetcher),
  );
  const providers = createSearchProviders(config);
  const healthTracker = new DynamicPenaltyHealthTracker();
  const answerProviders = createAnswerProviders(config);
  const researchProviders = createResearchProviders(config);
  const contentProviders = createContentProviders(config);
  const mapProviders = createMapProviders(config);
  const crawlProviders = createCrawlProviders(config);
  const newsProviders = createNewsProviders(config);
  const imagesProviders = createImagesProviders(config);
  const searchBudget = new CompositeSearchBudget([
    new MonthlySearchBudget(config.searchMonthlyRequestBudgets),
    new DailySearchBudget(config.searchDailyRequestBudgets),
  ]);
  const searchRouter = new SearchRouter(
    providers,
    config.searchProviderOrder,
    healthTracker,
    searchBudget,
  );
  const answerRouter = new AnswerRouter(answerProviders, undefined, searchBudget);
  const researchRouter = new ResearchRouter(researchProviders, undefined, searchBudget);
  const contentRouter = new ContentRouter(contentProviders, undefined, searchBudget);
  const mapRouter = new MapRouter(mapProviders, undefined, searchBudget);
  const crawlRouter = new CrawlRouter(crawlProviders, undefined, searchBudget);
  const newsRouter = new NewsRouter(newsProviders, undefined, searchBudget);
  const imagesRouter = new ImagesRouter(imagesProviders, undefined, searchBudget);
  const providerBalanceRegistry = new ProviderBalanceRegistry({
    supportedProviders: config.searchProviderOrder,
    configuredProviders: Object.keys(config.providerKeys),
    checkers: [
      new LinkupBalanceChecker(
        config.providerKeys.linkup === undefined ? {} : { apiKey: config.providerKeys.linkup },
      ),
      new FirecrawlBalanceChecker(
        config.providerKeys.firecrawl === undefined ? {} : { apiKey: config.providerKeys.firecrawl },
      ),
      new SerpApiBalanceChecker(
        config.providerKeys.serpapi === undefined ? {} : { apiKey: config.providerKeys.serpapi },
      ),
      new YouBalanceChecker(
        config.providerKeys.you === undefined ? {} : { apiKey: config.providerKeys.you },
      ),
    ],
  });
  const limiter = new ConcurrencyLimiter(config.maxConcurrency, config.maxQueue);
  const modules = [
    createProviderCapabilitiesModule(),
    createProviderBalanceModule({
      registry: providerBalanceRegistry,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    createProviderQuotaModule({
      balanceRegistry: providerBalanceRegistry,
      budget: searchBudget,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    createSearchBudgetStatusModule({
      budget: searchBudget,
    }),
    createWebAnswerModule({
      router: answerRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebResearchModule({
      router: researchRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebContentModule({
      router: contentRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebMapModule({
      router: mapRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebCrawlModule({
      router: crawlRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebNewsModule({
      router: newsRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebImagesModule({
      router: imagesRouter,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
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
    createParseModule({
      pipeline: fetchPipeline,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      maxOutputChars: config.maxOutputChars,
    }),
    createCrawlJobsModule({
      manager: new CrawlJobManager(),
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createWebExtractSchemaModule({
      // No extraction provider adapter is registered by default and no
      // benchmark report exists, so the tool stays closed behind the
      // benchmark gate (PROVIDER_UNAVAILABLE) until both land.
      providers: [],
      benchmarkReport: null,
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createDocumentPolicyModule({
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    createCorpusToolsModule({
      store: new CorpusStore(new InMemoryCorpusBackend()),
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createErrorLogModule({
      sink: getErrorLogSink() ?? new NoopErrorSink(),
      cloudflareQuery: undefined,
    }),
  ];

  return {
    registryFactory: () => createMcpRegistry(modules),
    async close(): Promise<void> {
      await browser.close?.();
    },
  };
}
