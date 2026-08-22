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
  durationMs: number;
}
