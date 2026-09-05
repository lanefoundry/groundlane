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
import { SqliteDurableRecordStore } from "./adapters/state/sqlite-durable-store.js";
import { SqliteImmutableBlobStore } from "./adapters/state/sqlite-immutable-blob.js";
import { DurableArtifactRepository } from "./core/durable-artifacts.js";
import { DurableDocumentOutputRuntime } from "./core/durable-document-output.js";
import { createDocumentResultModule } from "./tools/document-result.js";
import { SqliteCorpusDerivedIndex } from "./adapters/state/sqlite-corpus-index.js";
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
import {
  DurableCorpusRuntime,
  ImmutableBlobCorpusSourceArtifacts,
  corpusDocumentCacheSource,
} from "./core/durable-corpus-runtime.js";
import { DurableCorpusRepository } from "./core/durable-corpora.js";
import { createCrawlJobsModule } from "./tools/crawl-jobs.js";
import { createCorpusToolsModule } from "./tools/corpus-tools.js";
import { createDocumentPolicyModule } from "./tools/document-policy.js";
import {
  createDocumentParseModule,
  isParsedDocumentContent,
  runResolvedDocumentParse,
  type DocumentParseInput,
  type ResolvedDocumentSource,
} from "./tools/document-parse.js";
import type { McpRequestContext } from "./mcp/registry.js";
import { createDocumentUploadModule } from "./tools/document-upload.js";
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
import { DurableDocumentCacheRepository } from "./core/durable-document-cache.js";
import { RemoteDocumentOutputRuntime } from "./container/remote-document-output.js";
import { createArtifactRetentionPolicy } from "./core/artifact-retention-policy.js";
import { documentCacheBindingIdentity } from "./core/document-cache-contract.js";
import { DurableMcpTaskRuntime } from "./core/durable-mcp-tasks.js";
import { createDocumentJobModule } from "./tools/document-job.js";
import {
  nodeDocumentCacheSubtle,
  RemoteDocumentCacheRuntime,
} from "./container/remote-document-cache.js";
import { systemUtcClock } from "./worker/managed-tokens.js";
import {
  createAsyncResearchModule,
  createLinkupResearchTaskProvider,
} from "./tools/async-research.js";
export interface GroundlaneServices {
  registryFactory: McpRegistryFactory;
  parseResolvedDocument(
    input: DocumentParseInput,
    resolved: ResolvedDocumentSource,
    context: McpRequestContext,
    signal: AbortSignal,
  ): Promise<unknown>;
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
  const artifactRetention = createArtifactRetentionPolicy({
    uploadMaxTtlSeconds: config.documentUploadMaxTtlSeconds,
    artifactMaxTtlSeconds: config.documentArtifactMaxTtlSeconds,
  });
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
  const documentCacheStore = config.documentCacheStatePath === undefined
    ? undefined
    : new SqliteDurableRecordStore(config.documentCacheStatePath, "document-cache");
  const documentCachePayloads = config.documentCacheStatePath === undefined
    ? undefined
    : new SqliteImmutableBlobStore(config.documentCacheStatePath, "document-cache-payloads");
  const documentCache = documentCacheStore === undefined || documentCachePayloads === undefined
    ? undefined
    : new DurableDocumentCacheRepository(documentCacheStore, { payloads: documentCachePayloads });
  const documentCacheEnabled = config.documentCacheEdgeEnabled || documentCache !== undefined;
  const documentOutputStore = config.documentArtifactStatePath === undefined ? undefined
    : new SqliteDurableRecordStore(config.documentArtifactStatePath, "document-output-v1");
  const documentOutputBlobs = config.documentArtifactStatePath === undefined ? undefined
    : new SqliteImmutableBlobStore(config.documentArtifactStatePath, "document-output-v1");
  const documentOutputIntents = config.documentArtifactStatePath === undefined ? undefined
    : new SqliteDurableRecordStore(config.documentArtifactStatePath, "document-output-intents-v1");
  const documentOutputRepository = documentOutputStore === undefined || documentOutputBlobs === undefined
    ? undefined : new DurableArtifactRepository(documentOutputStore, documentOutputBlobs);
  const documentOutput = documentOutputRepository === undefined ? undefined
    : new DurableDocumentOutputRuntime(documentOutputRepository, Math.min(86_400, config.documentArtifactMaxTtlSeconds), Date.now, undefined, documentOutputIntents);
  let documentOutputSweepCursor: string | null = null;
  let documentOutputSweepInFlight = Promise.resolve();
  const sweepDocumentOutput = (): void => {
    documentOutputSweepInFlight = documentOutputSweepInFlight.then(async () => {
      if (documentOutputRepository === undefined) return;
      const page = await documentOutputRepository.sweepExpired(Date.now(), documentOutputSweepCursor, 100);
      documentOutputSweepCursor = page.nextCursor;
    }).catch(() => { /* Retry on the next bounded maintenance tick. */ });
  };
  if (documentOutputRepository !== undefined) sweepDocumentOutput();
  const documentOutputSweep = documentOutputRepository === undefined ? undefined
    : setInterval(sweepDocumentOutput, 60_000);
  documentOutputSweep?.unref();
  const documentCacheForContext = (
    context: McpRequestContext,
  ) => {
    if (!config.documentCacheEdgeEnabled) return documentCache;
    if (config.internalSigningSecret === undefined) {
      throw new Error("Document cache edge mode requires an internal signing secret");
    }
    return new RemoteDocumentCacheRuntime({
      signingSecret: config.internalSigningSecret,
      principal: context.principal,
      credentialBinding: context.credentialBinding,
      subtle: nodeDocumentCacheSubtle,
      clock: systemUtcClock(),
      validateData: isParsedDocumentContent,
      defaultTimeoutMs: config.requestTimeoutMs,
    });
  };
  const documentOutputForContext = (context: McpRequestContext) => {
    if (!config.documentOutputEdgeEnabled) return documentOutput;
    if (config.internalSigningSecret === undefined) throw new Error("Document output edge mode requires an internal signing secret");
    return new RemoteDocumentOutputRuntime({ signingSecret: config.internalSigningSecret,
      principal: context.principal, credentialBinding: context.credentialBinding,
      subtle: nodeDocumentCacheSubtle, timeoutMs: config.requestTimeoutMs });
  };
  const corpusRecordStore = config.corpusStatePath === undefined
    ? undefined
    : new SqliteDurableRecordStore(config.corpusStatePath, "corpora-v1");
  const corpusBlobStore = config.corpusStatePath === undefined
    ? undefined
    : new SqliteImmutableBlobStore(config.corpusStatePath, "corpus-source-blobs-v1");
  const corpusIndex = config.corpusStatePath === undefined
    ? undefined
    : new SqliteCorpusDerivedIndex(config.corpusStatePath, "corpus-index-v1");
  const corpusForContext = (context?: McpRequestContext) => corpusRecordStore === undefined || corpusBlobStore === undefined || corpusIndex === undefined
    ? undefined
    : new DurableCorpusRuntime({
        repository: new DurableCorpusRepository(corpusRecordStore),
        artifacts: new ImmutableBlobCorpusSourceArtifacts(corpusBlobStore),
        index: corpusIndex,
        maxSourceBytes: config.corpusMaxSourceBytes,
        cache: { revoke: async ({ corpusId, sourceId, contentHash, binding }) => {
          const cache = context === undefined ? documentCache : documentCacheForContext(context);
          await cache?.revokeAllSourceBindings({
            ownershipScope: binding.ownerId,
            sourceIdentity: documentCacheBindingIdentity(corpusDocumentCacheSource(corpusId, sourceId, contentHash, binding.tenantId), binding.credentialBinding),
            nowMs: Date.now(),
          });
        } },
      });
  const durableCorpus = corpusForContext();
  const asyncTaskStore = config.asyncTaskStatePath === undefined
    ? undefined
    : new SqliteDurableRecordStore(config.asyncTaskStatePath, "mcp-tasks-v1");
  const asyncLinkup = asyncTaskStore === undefined || config.providerKeys.linkup === undefined
    ? undefined
    : new LinkupResearchProvider({ apiKey: config.providerKeys.linkup });
  const asyncTaskRuntime = asyncTaskStore === undefined || asyncLinkup === undefined
    ? undefined
    : new DurableMcpTaskRuntime(
        asyncTaskStore,
        createLinkupResearchTaskProvider(asyncLinkup),
        5_000,
      );
  let documentCacheSweepInFlight = documentCache?.sweepExpired(Date.now()).catch(() => 0) ?? Promise.resolve(0);
  const documentCacheSweep = documentCache === undefined
    ? undefined
    : setInterval(() => {
        documentCacheSweepInFlight = documentCacheSweepInFlight
          .then(() => documentCache.sweepExpired(Date.now()))
          .catch(() => 0);
      }, 3_600_000);
  documentCacheSweep?.unref();
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
  const crawlJobManager = new CrawlJobManager();
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
    ...(durableCorpus === undefined
      ? [createCorpusToolsModule({
          store: new CorpusStore(new InMemoryCorpusBackend()),
          limiter,
          requestTimeoutMs: config.requestTimeoutMs,
          maxOutputChars: config.maxOutputChars,
        })]
      : []),
    createErrorLogModule({
      sink: getErrorLogSink() ?? new NoopErrorSink(),
      cloudflareQuery: undefined,
    }),
  ];

  return {
    parseResolvedDocument: (input, resolved, context, signal) => {
      const requestDocumentCache = documentCacheForContext(context);
      const requestDocumentOutput = documentOutputForContext(context);
      return runResolvedDocumentParse(input, resolved, {
        ...(requestDocumentOutput === undefined ? {} : { outputRuntime: requestDocumentOutput }),
        pipeline: fetchPipeline,
        caller: {
          ownerId: context.principal.principalId,
          credentialBinding: context.credentialBinding,
        },
        limiter,
        requestTimeoutMs: config.requestTimeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        maxOutputChars: config.maxOutputChars,
        ...(requestDocumentCache === undefined
          ? {}
          : {
              cache: requestDocumentCache,
              cacheConfig: {
                enabled: true,
                defaultTtlSeconds: config.documentCacheDefaultTtlSeconds,
                operatorMaxTtlSeconds: config.documentCacheMaxTtlSeconds,
              },
            }),
      }, signal);
    },
    registryFactory: async (context) => {
      if (context === undefined) {
        throw new Error("Authenticated MCP request context is required");
      }
      await documentCacheSweepInFlight;
      const requestCorpus = corpusForContext(context);
      const requestDocumentCache = documentCacheForContext(context);
      const requestDocumentOutput = documentOutputForContext(context);
      return createMcpRegistry([
        ...modules,
        createDocumentPolicyModule({
          limiter,
          requestTimeoutMs: config.requestTimeoutMs,
          requestState: context.requestState,
          runtime: {
            cacheEnabled: documentCacheEnabled,
            uploadAvailable: config.artifactEdgeEnabled,
            artifactSourceAvailable: config.artifactEdgeEnabled,
            durableCorporaAvailable: durableCorpus !== undefined,
          },
          bounds: {
            cache: {
              defaultTtlSeconds: config.documentCacheDefaultTtlSeconds,
              minTtlSeconds: 60,
              maxTtlSeconds: config.documentCacheMaxTtlSeconds,
            },
            upload: artifactRetention.upload,
            artifact: artifactRetention.artifact,
          },
        }),
        createDocumentParseModule({
          pipeline: fetchPipeline,
          ...(requestCorpus === undefined ? {} : { corpusReader: { readSource: (corpusId: string, sourceId: string) => requestCorpus.readSource(corpusId, sourceId, {
            tenantId: config.corpusTenantId, ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding, roles: context.principal.scopes,
          }) } }),
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
          limiter,
          requestTimeoutMs: config.requestTimeoutMs,
          maxResponseBytes: config.maxResponseBytes,
          maxOutputChars: config.maxOutputChars,
          ...(requestDocumentOutput === undefined ? {} : { outputRuntime: requestDocumentOutput }),
          ...(requestDocumentCache === undefined
            ? {}
            : {
                cache: requestDocumentCache,
                cacheConfig: {
                  enabled: true,
                  defaultTtlSeconds: config.documentCacheDefaultTtlSeconds,
                  operatorMaxTtlSeconds: config.documentCacheMaxTtlSeconds,
                },
              }),
        }),
        createDocumentUploadModule({
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
        }),
        createDocumentJobModule({ caller: { ownerId: context.principal.principalId, credentialBinding: context.credentialBinding } }),
        ...(requestDocumentOutput === undefined ? [] : [createDocumentResultModule(requestDocumentOutput, {
          ownerId: context.principal.principalId, credentialBinding: context.credentialBinding,
        }, { limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars })]),
        ...(requestCorpus === undefined
          ? []
          : [createCorpusToolsModule({
              runtime: requestCorpus,
              caller: {
                tenantId: config.corpusTenantId,
                ownerId: context.principal.principalId,
                credentialBinding: context.credentialBinding,
                roles: context.principal.scopes,
              },
              limiter,
              requestTimeoutMs: config.requestTimeoutMs,
              maxOutputChars: config.maxOutputChars,
            })]),
        createCrawlJobsModule({
          manager: crawlJobManager,
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
          limiter,
          requestTimeoutMs: config.requestTimeoutMs,
          maxOutputChars: config.maxOutputChars,
        }),
        createAsyncResearchModule({
          ...(asyncTaskRuntime === undefined ? {} : { runtime: asyncTaskRuntime }),
          advertiseTasks: asyncTaskRuntime !== undefined || config.asyncTaskEdgeEnabled,
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
        }),
      ]);
    },
    async close(): Promise<void> {
      if (documentOutputSweep !== undefined) clearInterval(documentOutputSweep);
      await documentOutputSweepInFlight;
      documentOutputStore?.close();
      documentOutputIntents?.close();
      documentOutputBlobs?.close();
      if (documentCacheSweep !== undefined) clearInterval(documentCacheSweep);
      await documentCacheSweepInFlight;
      documentCacheStore?.close();
      documentCachePayloads?.close();
      corpusRecordStore?.close();
      corpusBlobStore?.close();
      corpusIndex?.close();
      asyncTaskStore?.close();
      await browser.close?.();
    },
  };
}
