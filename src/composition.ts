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
import { ResearchRouter } from "./core/research-router.js";
import { SearchRouter } from "./core/search-router.js";
import { CompositeSearchBudget, DailySearchBudget, MinuteRateLimiter, MonthlySearchBudget } from "./core/search-budget.js";
import { SourceAwareDocsResolver } from "./core/source-aware-docs.js";
import { createMcpRegistry, type McpRegistryFactory } from "./mcp/registry.js";
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
  if (config.providerKeys.searchapi !== undefined) {
    providers.push(new SearchApiSearchProvider({ apiKey: config.providerKeys.searchapi }));
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
  if (config.providerKeys.tinyfish !== undefined) {
    providers.push(new TinyFishSearchProvider({ apiKey: config.providerKeys.tinyfish }));
  }
  providers.push(new KeenableSearchProvider(
    config.providerKeys.keenable === undefined
      ? {}
      : { apiKey: config.providerKeys.keenable },
  ));
  if (config.providerKeys.serper !== undefined) {
    providers.push(new SerperSearchProvider({ apiKey: config.providerKeys.serper }));
  }
  providers.push(new YouSearchProvider(
    config.providerKeys.you !== undefined ? { apiKey: config.providerKeys.you } : {},
  ));
  return providers;
}

export function createAnswerProviders(config: GroundlaneConfig): AnswerProvider[] {
  const providers: AnswerProvider[] = [];
  if (config.providerKeys.linkup !== undefined) {
    providers.push(new LinkupAnswerProvider({ apiKey: config.providerKeys.linkup }));
  }
  if (config.providerKeys.you !== undefined) {
    providers.push(new YouAnswerProvider({ apiKey: config.providerKeys.you }));
  }
  return providers;
}

export function createResearchProviders(config: GroundlaneConfig): ResearchProvider[] {
  const providers: ResearchProvider[] = [];
  if (config.providerKeys.linkup !== undefined) {
    providers.push(new LinkupResearchProvider({ apiKey: config.providerKeys.linkup }));
  }
  if (config.providerKeys.you !== undefined) {
    providers.push(new YouResearchProvider({ apiKey: config.providerKeys.you }));
  }
  if (config.providerKeys.parallel !== undefined) {
    providers.push(new ParallelResearchProvider({ apiKey: config.providerKeys.parallel }));
  }
  return providers;
}

export function createContentProviders(config: GroundlaneConfig): ContentProvider[] {
  const providers: ContentProvider[] = [];
  if (config.providerKeys.linkup !== undefined) {
    providers.push(new LinkupContentProvider({ apiKey: config.providerKeys.linkup }));
  }
  if (config.providerKeys.you !== undefined) {
    providers.push(new YouContentProvider({ apiKey: config.providerKeys.you }));
  }
  if (config.providerKeys.exa !== undefined) {
    providers.push(new ExaContentProvider({ apiKey: config.providerKeys.exa }));
  }
  if (config.providerKeys.tavily !== undefined) {
    providers.push(new TavilyContentProvider({ apiKey: config.providerKeys.tavily }));
  }
  if (config.providerKeys.firecrawl !== undefined) {
    providers.push(new FirecrawlContentProvider({ apiKey: config.providerKeys.firecrawl }));
  }
  if (config.providerKeys.tinyfish !== undefined) {
    providers.push(new TinyFishContentProvider({ apiKey: config.providerKeys.tinyfish }));
  }
  providers.push(new KeenableContentProvider(
    config.providerKeys.keenable === undefined
      ? {}
      : { apiKey: config.providerKeys.keenable },
  ));
  return providers;
}

export function createMapProviders(config: GroundlaneConfig): MapProvider[] {
  const providers: MapProvider[] = [];
  if (config.providerKeys.firecrawl !== undefined) {
    providers.push(new FirecrawlMapProvider({ apiKey: config.providerKeys.firecrawl }));
  }
  if (config.providerKeys.tavily !== undefined) {
    providers.push(new TavilyMapProvider({ apiKey: config.providerKeys.tavily }));
  }
  return providers;
}

export function createCrawlProviders(config: GroundlaneConfig): CrawlProvider[] {
  const providers: CrawlProvider[] = [];
  if (config.providerKeys.firecrawl !== undefined) {
    providers.push(new FirecrawlCrawlProvider({ apiKey: config.providerKeys.firecrawl }));
  }
  if (config.providerKeys.tavily !== undefined) {
    providers.push(new TavilyCrawlProvider({ apiKey: config.providerKeys.tavily }));
  }
  return providers;
}

export function createNewsProviders(config: GroundlaneConfig): NewsProvider[] {
  const providers: NewsProvider[] = [];
  if (config.providerKeys.brave !== undefined) {
    providers.push(new BraveNewsProvider({ apiKey: config.providerKeys.brave }));
  }
  if (config.providerKeys.serper !== undefined) {
    providers.push(new SerperNewsProvider({ apiKey: config.providerKeys.serper }));
  }
  if (config.providerKeys.serpapi !== undefined) {
    providers.push(new SerpApiNewsProvider({ apiKey: config.providerKeys.serpapi }));
  }
  return providers;
}

export function createImagesProviders(config: GroundlaneConfig): ImagesProvider[] {
  const providers: ImagesProvider[] = [];
  if (config.providerKeys.brave !== undefined) {
    providers.push(new BraveImagesProvider({ apiKey: config.providerKeys.brave }));
  }
  if (config.providerKeys.serper !== undefined) {
    providers.push(new SerperImagesProvider({ apiKey: config.providerKeys.serper }));
  }
  if (config.providerKeys.serpapi !== undefined) {
    providers.push(new SerpApiImagesProvider({ apiKey: config.providerKeys.serpapi }));
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
