import { LinkupAnswerProvider } from "./adapters/answer/linkup.js";
import { YouAnswerProvider } from "./adapters/answer/you.js";
import { Crawl4AIContentProvider } from "./adapters/content/crawl4ai.js";
import { ExaContentProvider } from "./adapters/content/exa.js";
import { FirecrawlContentProvider } from "./adapters/content/firecrawl.js";
import { KeenableContentProvider } from "./adapters/content/keenable.js";
import { LinkupContentProvider } from "./adapters/content/linkup.js";
import { TavilyContentProvider } from "./adapters/content/tavily.js";
import { TinyFishContentProvider } from "./adapters/content/tinyfish.js";
import { YouContentProvider } from "./adapters/content/you.js";
import { FirecrawlCrawlProvider } from "./adapters/crawl/firecrawl.js";
import { TavilyCrawlProvider } from "./adapters/crawl/tavily.js";
import { BraveImagesProvider } from "./adapters/images/brave.js";
import { SerperImagesProvider } from "./adapters/images/serper.js";
import { SerpApiImagesProvider } from "./adapters/images/serpapi.js";
import { FirecrawlMapProvider } from "./adapters/map/firecrawl.js";
import { TavilyMapProvider } from "./adapters/map/tavily.js";
import { BraveNewsProvider } from "./adapters/news/brave.js";
import { SerperNewsProvider } from "./adapters/news/serper.js";
import { SerpApiNewsProvider } from "./adapters/news/serpapi.js";
import { LinkupResearchProvider } from "./adapters/research/linkup.js";
import { ParallelResearchProvider } from "./adapters/research/parallel.js";
import { YouResearchProvider } from "./adapters/research/you.js";
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
import { SearXNGSearchProvider } from "./adapters/search/searxng.js";
import { YouSearchProvider } from "./adapters/search/you.js";
import type { GroundlaneConfig } from "./config.js";
import type {
  AnswerProvider,
  ContentProvider,
  CrawlProvider,
  ImagesProvider,
  MapProvider,
  NewsProvider,
  ResearchProvider,
  SearchProvider,
} from "./core/contracts.js";
import { builtInRegistry, type ProviderCapabilities } from "./core/provider-registry.js";
import type { McpRegistryFactory } from "./mcp/registry.js";
import type { McpRequestContext } from "./mcp/registry.js";
import type { DocumentParseInput, ResolvedDocumentSource } from "./tools/document-parse.js";

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
  { providerId: "searxng", create: (key) => new SearXNGSearchProvider({ baseUrl: key! }), requiresKey: true },
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
  const providers = buildProviders("content", CONTENT_ADAPTERS, config);
  if (config.crawl4aiBaseUrl !== undefined) {
    providers.push(new Crawl4AIContentProvider({ baseUrl: config.crawl4aiBaseUrl }));
  }
  return providers;
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
