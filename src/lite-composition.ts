import { DisabledBrowserBackend } from "./adapters/browser/disabled.js";
import { CfBrowserRenderingBackend } from "./adapters/browser/cf-browser-rendering.js";
import { WorkersFetcher } from "./adapters/http/workers-fetcher.js";
import { D1CorpusDerivedIndex } from "./adapters/state/d1-corpus-index.js";
import { D1DurableRecordStore } from "./worker/d1-durable-store.js";
import { R2ImmutableBlobStore } from "./worker/r2-immutable-blob.js";
import { DurableArtifactRepository } from "./core/durable-artifacts.js";
import { DurableDocumentOutputRuntime } from "./core/durable-document-output.js";
import { DurableDocumentCacheRepository } from "./core/durable-document-cache.js";
import { DurableMcpTaskRuntime } from "./core/durable-mcp-tasks.js";
import { LinkupResearchProvider } from "./adapters/research/linkup.js";
import {
  DurableCorpusRuntime,
  ImmutableBlobCorpusSourceArtifacts,
  corpusDocumentCacheSource,
} from "./core/durable-corpus-runtime.js";
import { DurableCorpusRepository } from "./core/durable-corpora.js";
import { FetchPipeline } from "./core/fetch-pipeline.js";
import { ConcurrencyLimiter } from "./core/limits.js";
import { DynamicPenaltyHealthTracker } from "./core/provider-health.js";
import { ProviderBalanceRegistry } from "./core/provider-balance.js";
import { SourceAwareDocsResolver } from "./core/source-aware-docs.js";
import { CorpusStore, InMemoryCorpusBackend } from "./core/corpus-runtime.js";
import { AnswerRouter } from "./core/answer-router.js";
import { ContentRouter } from "./core/content-router.js";
import { CrawlRouter } from "./core/crawl-router.js";
import { ImagesRouter } from "./core/images-router.js";
import { MapRouter } from "./core/map-router.js";
import { NewsRouter } from "./core/news-router.js";
import { ResearchRouter } from "./core/research-router.js";
import { SearchRouter } from "./core/search-router.js";
import { CompositeSearchBudget, DailySearchBudget, MinuteRateLimiter, MonthlySearchBudget } from "./core/search-budget.js";
import { CrawlJobManager } from "./core/crawl-jobs.js";
import { NoopErrorSink } from "./core/error-log.js";
import { createArtifactRetentionPolicy } from "./core/artifact-retention-policy.js";
import { documentCacheBindingIdentity } from "./core/document-cache-contract.js";
import { createMcpRegistry, type McpRegistryFactory } from "./mcp/registry.js";
import type { McpRequestContext } from "./mcp/registry.js";
import type { GroundlaneConfig } from "./config.js";
import type { BrowserBackend } from "./core/contracts.js";
import type { D1DatabaseLike } from "./worker/d1-managed-store.js";
import type { R2BucketLike } from "./worker/r2-immutable-blob.js";
import {
  createSearchProviders,
  createAnswerProviders,
  createResearchProviders,
  createContentProviders,
  createMapProviders,
  createCrawlProviders,
  createNewsProviders,
  createImagesProviders,
  type GroundlaneServices,
} from "./provider-factories.js";
import { createDocumentResultModule } from "./tools/document-result.js";
import { createCrawlJobsModule } from "./tools/crawl-jobs.js";
import { createCorpusToolsModule } from "./tools/corpus-tools.js";
import { createDocumentPolicyModule } from "./tools/document-policy.js";
import {
  createDocumentParseModule,
  isParsedDocumentContent,
  runResolvedDocumentParse,
} from "./tools/document-parse.js";
import { createDocumentUploadModule } from "./tools/document-upload.js";
import { createDocumentJobModule } from "./tools/document-job.js";
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
import { createDocumentArchiveExtractModule } from "./tools/document-archive-extract.js";
import { createDocumentConvertModule } from "./tools/document-convert.js";
import { createDocumentEmailExtractModule } from "./tools/document-email-extract.js";
import { createDocumentTableExtractModule } from "./tools/document-table-extract.js";
import { createDocumentOcrModule } from "./tools/document-ocr.js";
import { createDocumentTranscribeModule } from "./tools/document-transcribe.js";
import { createErrorLogModule } from "./tools/error-log.js";
import { createPaperSearchModule } from "./tools/paper-search.js";
import {
  createAsyncResearchModule,
  createLinkupResearchTaskProvider,
} from "./tools/async-research.js";
import { CloudConvertProvider } from "./adapters/document/cloudconvert.js";
import { OcrSpaceProvider } from "./adapters/document/ocr-space.js";
import { WorkersAiWhisperProvider } from "./adapters/document/workers-ai-whisper.js";
import { LinkupBalanceChecker } from "./adapters/balance/linkup.js";
import { FirecrawlBalanceChecker } from "./adapters/balance/firecrawl.js";
import { SerpApiBalanceChecker } from "./adapters/balance/serpapi.js";
import { YouBalanceChecker } from "./adapters/balance/you.js";

export interface LiteEnvBindings {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
}

export function createLiteGroundlaneServices(
  config: GroundlaneConfig,
  bindings: LiteEnvBindings,
): GroundlaneServices {
  const artifactRetention = createArtifactRetentionPolicy({
    uploadMaxTtlSeconds: config.documentUploadMaxTtlSeconds,
    artifactMaxTtlSeconds: config.documentArtifactMaxTtlSeconds,
  });

  const browser: BrowserBackend =
    config.browserBackend === "cf-rendering" &&
    config.cfBrowserAccountId !== undefined &&
    config.cfBrowserApiToken !== undefined
      ? new CfBrowserRenderingBackend({
          accountId: config.cfBrowserAccountId,
          apiToken: config.cfBrowserApiToken,
          ...(config.cfBrowserDailyBudgetMs !== undefined
            ? { dailyBudgetMs: config.cfBrowserDailyBudgetMs }
            : {}),
        })
      : new DisabledBrowserBackend();

  const backendBudget = new CompositeSearchBudget([
    new MinuteRateLimiter({ jina: config.jinaReaderRpm }),
  ]);
  const httpFetcher = new WorkersFetcher();
  const fetchPipeline = new FetchPipeline(
    httpFetcher,
    browser,
    undefined,
    backendBudget,
    new SourceAwareDocsResolver(httpFetcher),
  );

  const documentCacheStore = new D1DurableRecordStore(bindings.d1, "document-cache");
  const documentCachePayloads = new R2ImmutableBlobStore(bindings.r2);
  const documentCache = new DurableDocumentCacheRepository(documentCacheStore, { payloads: documentCachePayloads });

  const documentOutputStore = new D1DurableRecordStore(bindings.d1, "document-output-v1");
  const documentOutputBlobs = new R2ImmutableBlobStore(bindings.r2);
  const documentOutputIntents = new D1DurableRecordStore(bindings.d1, "document-output-intents-v1");
  const documentOutputRepository = new DurableArtifactRepository(documentOutputStore, documentOutputBlobs);
  const documentOutput = new DurableDocumentOutputRuntime(
    documentOutputRepository,
    Math.min(86_400, config.documentArtifactMaxTtlSeconds),
    Date.now,
    undefined,
    documentOutputIntents,
  );

  const corpusRecordStore = new D1DurableRecordStore(bindings.d1, "corpora-v1");
  const corpusBlobStore = new R2ImmutableBlobStore(bindings.r2);
  const corpusIndex = new D1CorpusDerivedIndex(bindings.d1, "corpus-index-v1");

  const corpusForContext = (context?: McpRequestContext) =>
    new DurableCorpusRuntime({
      repository: new DurableCorpusRepository(corpusRecordStore),
      artifacts: new ImmutableBlobCorpusSourceArtifacts(corpusBlobStore),
      index: corpusIndex,
      maxSourceBytes: config.corpusMaxSourceBytes,
      cache: {
        revoke: async ({ corpusId, sourceId, contentHash, binding }) => {
          await documentCache.revokeAllSourceBindings({
            ownershipScope: binding.ownerId,
            sourceIdentity: documentCacheBindingIdentity(
              corpusDocumentCacheSource(corpusId, sourceId, contentHash, binding.tenantId),
              binding.credentialBinding,
            ),
            nowMs: Date.now(),
          });
        },
      },
    });

  const asyncLinkup = config.providerKeys.linkup === undefined
    ? undefined
    : new LinkupResearchProvider({ apiKey: config.providerKeys.linkup });
  const asyncTaskStore = new D1DurableRecordStore(bindings.d1, "mcp-tasks-v1");
  const asyncTaskRuntime = asyncLinkup === undefined
    ? undefined
    : new DurableMcpTaskRuntime(asyncTaskStore, createLinkupResearchTaskProvider(asyncLinkup), 5_000);

  const providers = createSearchProviders(config);
  const healthTracker = new DynamicPenaltyHealthTracker();
  const searchBudget = new CompositeSearchBudget([
    new MonthlySearchBudget(config.searchMonthlyRequestBudgets),
    new DailySearchBudget(config.searchDailyRequestBudgets),
  ]);
  const searchRouter = new SearchRouter(providers, config.searchProviderOrder, healthTracker, searchBudget);
  const answerRouter = new AnswerRouter(createAnswerProviders(config), undefined, searchBudget);
  const researchRouter = new ResearchRouter(createResearchProviders(config), undefined, searchBudget);
  const contentRouter = new ContentRouter(createContentProviders(config), undefined, searchBudget);
  const mapRouter = new MapRouter(createMapProviders(config), undefined, searchBudget);
  const crawlRouter = new CrawlRouter(createCrawlProviders(config), undefined, searchBudget);
  const newsRouter = new NewsRouter(createNewsProviders(config), undefined, searchBudget);
  const imagesRouter = new ImagesRouter(createImagesProviders(config), undefined, searchBudget);
  const providerBalanceRegistry = new ProviderBalanceRegistry({
    supportedProviders: config.searchProviderOrder,
    configuredProviders: Object.keys(config.providerKeys),
    checkers: [
      new LinkupBalanceChecker(config.providerKeys.linkup === undefined ? {} : { apiKey: config.providerKeys.linkup }),
      new FirecrawlBalanceChecker(config.providerKeys.firecrawl === undefined ? {} : { apiKey: config.providerKeys.firecrawl }),
      new SerpApiBalanceChecker(config.providerKeys.serpapi === undefined ? {} : { apiKey: config.providerKeys.serpapi }),
      new YouBalanceChecker(config.providerKeys.you === undefined ? {} : { apiKey: config.providerKeys.you }),
    ],
  });
  const limiter = new ConcurrencyLimiter(config.maxConcurrency, config.maxQueue);
  const crawlJobManager = new CrawlJobManager();

  const modules = [
    createProviderCapabilitiesModule(),
    createProviderBalanceModule({ registry: providerBalanceRegistry, limiter, requestTimeoutMs: config.requestTimeoutMs }),
    createProviderQuotaModule({ balanceRegistry: providerBalanceRegistry, budget: searchBudget, limiter, requestTimeoutMs: config.requestTimeoutMs }),
    createSearchBudgetStatusModule({ budget: searchBudget }),
    createWebAnswerModule({ router: answerRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebResearchModule({ router: researchRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebContentModule({ router: contentRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebMapModule({ router: mapRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebCrawlModule({ router: crawlRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebNewsModule({ router: newsRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebImagesModule({ router: imagesRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebFetchModule({ pipeline: fetchPipeline, limiter, requestTimeoutMs: config.requestTimeoutMs, maxResponseBytes: config.maxResponseBytes, maxOutputChars: config.maxOutputChars }),
    createWebSearchModule({ router: searchRouter, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createWebExtractModule({ pipeline: fetchPipeline, limiter, requestTimeoutMs: config.requestTimeoutMs, maxResponseBytes: config.maxResponseBytes, maxOutputChars: config.maxOutputChars }),
    createParseModule({ pipeline: fetchPipeline, limiter, requestTimeoutMs: config.requestTimeoutMs, maxResponseBytes: config.maxResponseBytes, maxOutputChars: config.maxOutputChars }),
    createWebExtractSchemaModule({ providers: [], benchmarkReport: null, limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
    createDocumentOcrModule({
      provider: config.ocrSpaceApiKey === undefined ? undefined : new OcrSpaceProvider({ apiKey: config.ocrSpaceApiKey }),
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createDocumentTranscribeModule({
      provider: config.cfBrowserAccountId === undefined || config.cfBrowserApiToken === undefined
        ? undefined
        : new WorkersAiWhisperProvider({ accountId: config.cfBrowserAccountId, apiToken: config.cfBrowserApiToken }),
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createDocumentConvertModule({
      provider: config.cloudConvertApiKey === undefined ? undefined : new CloudConvertProvider({ apiKey: config.cloudConvertApiKey }),
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createDocumentTableExtractModule({
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createDocumentArchiveExtractModule({
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createDocumentEmailExtractModule({
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createPaperSearchModule({
      limiter,
      requestTimeoutMs: config.requestTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    }),
    createErrorLogModule({ sink: new NoopErrorSink(), cloudflareQuery: undefined }),
  ];

  return {
    parseResolvedDocument: (input, resolved, context, signal) => {
      return runResolvedDocumentParse(input, resolved, {
        outputRuntime: documentOutput,
        pipeline: fetchPipeline,
        caller: {
          ownerId: context.principal.principalId,
          credentialBinding: context.credentialBinding,
        },
        limiter,
        requestTimeoutMs: config.requestTimeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        maxOutputChars: config.maxOutputChars,
        cache: documentCache,
        cacheConfig: {
          enabled: true,
          defaultTtlSeconds: config.documentCacheDefaultTtlSeconds,
          operatorMaxTtlSeconds: config.documentCacheMaxTtlSeconds,
        },
      }, signal);
    },
    registryFactory: async (context) => {
      if (context === undefined) {
        throw new Error("Authenticated MCP request context is required");
      }
      const requestCorpus = corpusForContext(context);
      return createMcpRegistry([
        ...modules,
        createDocumentPolicyModule({
          limiter,
          requestTimeoutMs: config.requestTimeoutMs,
          requestState: context.requestState,
          runtime: {
            cacheEnabled: true,
            uploadAvailable: config.artifactEdgeEnabled,
            artifactSourceAvailable: config.artifactEdgeEnabled,
            durableCorporaAvailable: true,
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
          corpusReader: {
            readSource: (corpusId: string, sourceId: string) =>
              requestCorpus.readSource(corpusId, sourceId, {
                tenantId: config.corpusTenantId,
                ownerId: context.principal.principalId,
                credentialBinding: context.credentialBinding,
                roles: context.principal.scopes,
              }),
          },
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
          limiter,
          requestTimeoutMs: config.requestTimeoutMs,
          maxResponseBytes: config.maxResponseBytes,
          maxOutputChars: config.maxOutputChars,
          outputRuntime: documentOutput,
          cache: documentCache,
          cacheConfig: {
            enabled: true,
            defaultTtlSeconds: config.documentCacheDefaultTtlSeconds,
            operatorMaxTtlSeconds: config.documentCacheMaxTtlSeconds,
          },
        }),
        createDocumentUploadModule({
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
        }),
        createDocumentJobModule({
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
        }),
        createDocumentResultModule(documentOutput, {
          ownerId: context.principal.principalId,
          credentialBinding: context.credentialBinding,
        }, { limiter, requestTimeoutMs: config.requestTimeoutMs, maxOutputChars: config.maxOutputChars }),
        createCorpusToolsModule({
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
        }),
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
          advertiseTasks: asyncTaskRuntime !== undefined,
          caller: {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          },
        }),
      ]);
    },
    async close() {
      await browser.close?.();
    },
  };
}
