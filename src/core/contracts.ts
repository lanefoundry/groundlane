import type { Deadline } from "./limits.js";
import type { KnownSearchProviderId } from "./search-provider-catalog.js";

export type FetchFormat = "html" | "text" | "markdown";
export type RenderMode = "auto" | "never" | "always";
export type Engine = "http" | "reader" | "browser";

export interface RawDocument {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  contentType: string;
  body: Uint8Array;
  engine: Engine;
  backend: string;
  blockedSubrequests?: number;
}

export interface HttpFetchRequest {
  url: string;
  maxBytes: number;
  maxRedirects: number;
  deadline: Deadline;
  headers?: Readonly<Record<string, string>>;
}

export interface HttpFetcher {
  fetch(request: HttpFetchRequest, signal?: AbortSignal): Promise<RawDocument>;
}

export interface ReaderFetchRequest {
  url: string;
  maxBytes: number;
  deadline: Deadline;
}

export interface ReaderBackend {
  fetch(request: ReaderFetchRequest, signal?: AbortSignal): Promise<RawDocument>;
  ready(): Promise<boolean>;
}

export interface BrowserFetchRequest {
  url: string;
  waitFor?: string;
  selector?: string;
  maxBytes: number;
  deadline: Deadline;
}

export interface BrowserBackend {
  fetch(request: BrowserFetchRequest, signal?: AbortSignal): Promise<RawDocument>;
  ready(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface CachedDocument { document: RawDocument; expiresAt: number }
export interface DocumentCache {
  get(key: string): Promise<CachedDocument | null>;
  put(key: string, value: CachedDocument, ttlSeconds: number): Promise<void>;
}

export interface NormalizedDocument {
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  content: string;
  format: FetchFormat;
  truncated: boolean;
  bytes: number;
  warnings: string[];
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  content: string;
  engine: Engine;
  backend: string;
  cached: boolean;
  truncated: boolean;
  bytes: number;
  durationMs: number;
  warnings: string[];
}

export type SearchProviderId = KnownSearchProviderId | (string & {});
export type SearchTimeRange = "day" | "week" | "month" | "year";
export type SearchStrategy = "fallback" | "balanced" | "deep";
export type AnswerProviderId = Extract<KnownSearchProviderId, "linkup" | "you">;
export type AnswerStrategy = "fallback" | "parallel";
export type ResearchProviderId = Extract<KnownSearchProviderId, "linkup" | "parallel" | "you">;
export type ResearchStrategy = "fallback" | "parallel";
export type ResearchEffort = "lite" | "standard" | "deep";
export type ContentProviderId = Extract<
  KnownSearchProviderId,
  "exa" | "firecrawl" | "keenable" | "linkup" | "tavily" | "you"
>;
export type ContentStrategy = "fallback" | "parallel";
export type MapProviderId = Extract<KnownSearchProviderId, "firecrawl" | "tavily">;
export type MapStrategy = "fallback" | "parallel";
export type CrawlProviderId = Extract<KnownSearchProviderId, "firecrawl" | "tavily">;
export type CrawlStrategy = "fallback" | "parallel";
export type NewsProviderId = Extract<KnownSearchProviderId, "brave" | "serpapi" | "serper">;
export type NewsStrategy = "fallback" | "parallel";
export type ImagesProviderId = Extract<KnownSearchProviderId, "brave" | "serpapi" | "serper">;
export type ImagesStrategy = "fallback" | "parallel";

export interface SearchRequest {
  query: string;
  maxResults: number;
  domains?: readonly string[];
  excludeDomains?: readonly string[];
  timeRange?: SearchTimeRange;
  provider?: "auto" | SearchProviderId;
  providers?: readonly SearchProviderId[];
  strategy?: SearchStrategy;
}

export interface SearchResultSource {
  provider: SearchProviderId;
  rank: number;
  rawScore?: number;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
  provider: SearchProviderId;
  fusionScore?: number;
  sources?: readonly SearchResultSource[];
}

export interface SearchResult {
  query: string;
  provider: SearchProviderId;
  results: SearchResultItem[];
  durationMs: number;
  warnings: string[];
  strategy?: SearchStrategy;
  providersSelected?: readonly SearchProviderId[];
  providersAttempted?: readonly SearchProviderId[];
  providersSucceeded?: readonly SearchProviderId[];
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  supports(request: SearchRequest): boolean;
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult>;
}

export interface AnswerRequest {
  query: string;
  maxResults: number;
  domains?: readonly string[];
  excludeDomains?: readonly string[];
  timeRange?: SearchTimeRange;
  provider?: "auto" | AnswerProviderId;
  providers?: readonly AnswerProviderId[];
  strategy?: AnswerStrategy;
}

export interface AnswerCitation {
  url: string;
  title?: string;
  excerpts: readonly string[];
}

export interface AnswerResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  provider: AnswerProviderId;
}

export interface AnswerProviderResult {
  provider: AnswerProviderId;
  answer: string;
  citations: readonly AnswerCitation[];
  results: readonly AnswerResultItem[];
  durationMs: number;
  warnings: readonly string[];
}

export interface AnswerResult {
  query: string;
  strategy: AnswerStrategy;
  providersSelected: readonly AnswerProviderId[];
  providersAttempted: readonly AnswerProviderId[];
  providersSucceeded: readonly AnswerProviderId[];
  answers: readonly AnswerProviderResult[];
  durationMs: number;
  warnings: readonly string[];
}

export interface AnswerProvider {
  readonly id: AnswerProviderId;
  supports(request: AnswerRequest): boolean;
  answer(request: AnswerRequest, signal: AbortSignal): Promise<AnswerProviderResult>;
}

export interface ResearchRequest {
  query: string;
  effort: ResearchEffort;
  domains?: readonly string[];
  excludeDomains?: readonly string[];
  timeRange?: SearchTimeRange;
  country?: string;
  provider?: "auto" | ResearchProviderId;
  providers?: readonly ResearchProviderId[];
  strategy?: ResearchStrategy;
}

export interface ResearchCitation {
  url: string;
  title?: string;
  excerpts: readonly string[];
}

export interface ResearchProviderResult {
  provider: ResearchProviderId;
  report: string;
  citations: readonly ResearchCitation[];
  durationMs: number;
  warnings: readonly string[];
}

export interface ResearchResult {
  query: string;
  effort: ResearchEffort;
  strategy: ResearchStrategy;
  providersSelected: readonly ResearchProviderId[];
  providersAttempted: readonly ResearchProviderId[];
  providersSucceeded: readonly ResearchProviderId[];
  reports: readonly ResearchProviderResult[];
  durationMs: number;
  warnings: readonly string[];
}

export interface ResearchProvider {
  readonly id: ResearchProviderId;
  supports(request: ResearchRequest): boolean;
  research(request: ResearchRequest, signal: AbortSignal): Promise<ResearchProviderResult>;
}

export interface ContentRequest {
  url: string;
  maxContentChars: number;
  provider?: "auto" | ContentProviderId;
  providers?: readonly ContentProviderId[];
  strategy?: ContentStrategy;
  live?: boolean;
}

export interface ContentProviderResult {
  provider: ContentProviderId;
  url: string;
  finalUrl: string;
  title?: string;
  content: string;
  format: "markdown" | "text";
  truncated: boolean;
  durationMs: number;
  warnings: readonly string[];
}

export interface ContentResult {
  url: string;
  strategy: ContentStrategy;
  providersSelected: readonly ContentProviderId[];
  providersAttempted: readonly ContentProviderId[];
  providersSucceeded: readonly ContentProviderId[];
  contents: readonly ContentProviderResult[];
  durationMs: number;
  warnings: readonly string[];
}

export interface ContentProvider {
  readonly id: ContentProviderId;
  supports(request: ContentRequest): boolean;
  fetchContent(request: ContentRequest, signal: AbortSignal): Promise<ContentProviderResult>;
}

export interface MapRequest {
  url: string;
  maxLinks: number;
  provider?: "auto" | MapProviderId;
  providers?: readonly MapProviderId[];
  strategy?: MapStrategy;
  search?: string;
  includeSubdomains?: boolean;
  ignoreCache?: boolean;
  maxDepth?: number;
  maxBreadth?: number;
}

export interface MapLink {
  url: string;
  title?: string;
  description?: string;
  provider: MapProviderId;
}

export interface MapProviderResult {
  provider: MapProviderId;
  url: string;
  links: readonly MapLink[];
  durationMs: number;
  warnings: readonly string[];
}

export interface MapResult {
  url: string;
  strategy: MapStrategy;
  providersSelected: readonly MapProviderId[];
  providersAttempted: readonly MapProviderId[];
  providersSucceeded: readonly MapProviderId[];
  links: readonly MapLink[];
  providerResults: readonly MapProviderResult[];
  durationMs: number;
  warnings: readonly string[];
}

export interface MapProvider {
  readonly id: MapProviderId;
  supports(request: MapRequest): boolean;
  map(request: MapRequest, signal: AbortSignal): Promise<MapProviderResult>;
}

export interface CrawlRequest {
  url: string;
  maxPages: number;
  maxContentChars: number;
  provider?: "auto" | CrawlProviderId;
  providers?: readonly CrawlProviderId[];
  strategy?: CrawlStrategy;
  instructions?: string;
  includeSubdomains?: boolean;
  ignoreCache?: boolean;
  maxDepth?: number;
  maxBreadth?: number;
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface CrawlPage {
  url: string;
  title?: string;
  description?: string;
  content?: string;
  contentChars: number;
  truncated: boolean;
  provider: CrawlProviderId;
}

export interface CrawlProviderResult {
  provider: CrawlProviderId;
  url: string;
  status: "completed" | "running" | "failed" | "unknown";
  jobId?: string;
  total?: number;
  completed?: number;
  creditsUsed?: number;
  pages: readonly CrawlPage[];
  durationMs: number;
  warnings: readonly string[];
}

export interface CrawlResult {
  url: string;
  strategy: CrawlStrategy;
  providersSelected: readonly CrawlProviderId[];
  providersAttempted: readonly CrawlProviderId[];
  providersSucceeded: readonly CrawlProviderId[];
  pages: readonly CrawlPage[];
  providerResults: readonly CrawlProviderResult[];
  durationMs: number;
  warnings: readonly string[];
}

export interface CrawlProvider {
  readonly id: CrawlProviderId;
  supports(request: CrawlRequest): boolean;
  crawl(request: CrawlRequest, signal: AbortSignal): Promise<CrawlProviderResult>;
}

export interface NewsRequest {
  query: string;
  maxResults: number;
  provider?: "auto" | NewsProviderId;
  providers?: readonly NewsProviderId[];
  strategy?: NewsStrategy;
  timeRange?: SearchTimeRange;
  country?: string;
  language?: string;
}

export interface NewsItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
  thumbnailUrl?: string;
  provider: NewsProviderId;
}

export interface NewsProviderResult {
  provider: NewsProviderId;
  query: string;
  results: readonly NewsItem[];
  durationMs: number;
  warnings: readonly string[];
}

export interface NewsResult {
  query: string;
  strategy: NewsStrategy;
  providersSelected: readonly NewsProviderId[];
  providersAttempted: readonly NewsProviderId[];
  providersSucceeded: readonly NewsProviderId[];
  results: readonly NewsItem[];
  providerResults: readonly NewsProviderResult[];
  durationMs: number;
  warnings: readonly string[];
}

export interface NewsProvider {
  readonly id: NewsProviderId;
  supports(request: NewsRequest): boolean;
  news(request: NewsRequest, signal: AbortSignal): Promise<NewsProviderResult>;
}

export interface ImagesRequest {
  query: string;
  maxResults: number;
  provider?: "auto" | ImagesProviderId;
  providers?: readonly ImagesProviderId[];
  strategy?: ImagesStrategy;
  country?: string;
  language?: string;
  safeSearch?: "off" | "moderate" | "strict";
}

export interface ImageItem {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  source?: string;
  width?: number;
  height?: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  provider: ImagesProviderId;
}

export interface ImagesProviderResult {
  provider: ImagesProviderId;
  query: string;
  results: readonly ImageItem[];
  durationMs: number;
  warnings: readonly string[];
}

export interface ImagesResult {
  query: string;
  strategy: ImagesStrategy;
  providersSelected: readonly ImagesProviderId[];
  providersAttempted: readonly ImagesProviderId[];
  providersSucceeded: readonly ImagesProviderId[];
  results: readonly ImageItem[];
  providerResults: readonly ImagesProviderResult[];
  durationMs: number;
  warnings: readonly string[];
}

export interface ImagesProvider {
  readonly id: ImagesProviderId;
  supports(request: ImagesRequest): boolean;
  images(request: ImagesRequest, signal: AbortSignal): Promise<ImagesProviderResult>;
}

export type ProviderBalanceStatus =
  | "available"
  | "not_configured"
  | "unsupported"
  | "unknown";

export interface ProviderBalanceResult {
  provider: SearchProviderId;
  configured: boolean;
  status: ProviderBalanceStatus;
  source: "api" | "configuration" | "not_configured" | "not_implemented";
  balance?: number;
  currency?: string;
  unit?: "credits" | "cents" | "requests";
  warnings: string[];
}

export interface ProviderBalanceChecker {
  readonly id: SearchProviderId;
  configured(): boolean;
  getBalance(signal: AbortSignal): Promise<ProviderBalanceResult>;
}

export interface ExtractionField {
  name: string;
  selector: string;
  value: "text" | "html" | "attribute";
  attribute?: string;
  many?: boolean;
}

export type ExtractedValue = string | string[] | null;

export interface WebExtractResult {
  url: string;
  finalUrl: string;
  data: Record<string, ExtractedValue>;
  engine: Engine;
  backend: string;
  missingFields: string[];
  truncated: boolean;
  bytes: number;
  blockedSubrequests?: number;
  durationMs: number;
  warnings: string[];
  fallbackReason?: string;
}
