import type { NewsItem, NewsProvider, NewsProviderResult, NewsRequest } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  defaultNewsUrlValidator,
  newsProviderJson,
  newsResult,
  normalizeNewsItems,
  optionalString,
  type NewsFetchLike,
  type NewsUrlValidator,
} from "./common.js";

interface SerpApiNewsOptions {
  apiKey: string;
  fetch?: NewsFetchLike;
  validateUrl?: NewsUrlValidator;
}

export class SerpApiNewsProvider implements NewsProvider {
  readonly id = "serpapi" as const;
  private readonly fetcher: NewsFetchLike;
  private readonly validateUrl: NewsUrlValidator;

  constructor(private readonly options: SerpApiNewsOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultNewsUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async news(request: NewsRequest, signal: AbortSignal): Promise<NewsProviderResult> {
    const started = performance.now();
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_news");
    url.searchParams.set("q", request.query);
    url.searchParams.set("api_key", this.options.apiKey);
    url.searchParams.set("gl", request.country?.toLowerCase() ?? "us");
    url.searchParams.set("hl", request.language?.toLowerCase() ?? "en");
    if (request.timeRange === "day") url.searchParams.set("when", "1d");
    if (request.timeRange === "week") url.searchParams.set("when", "7d");
    if (request.timeRange === "month") url.searchParams.set("when", "1m");
    if (request.timeRange === "year") url.searchParams.set("when", "1y");

    const raw = await newsProviderJson(
      this.fetcher,
      url.href,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    if (raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string") {
      const message = (raw as { error: string }).error;
      if (/rate|limit|credit|searches/iu.test(message)) {
        throw new GroundlaneError("RATE_LIMITED", "web_news", "SerpApi quota or rate limit reached", true);
      }
      throw new GroundlaneError("UPSTREAM_ERROR", "web_news", "SerpApi rejected the news request");
    }
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { news_results?: unknown }).news_results)
        ? (raw as { news_results: unknown[] }).news_results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_news", "SerpApi returned a malformed news response", true);
    }
    const items = flattenNews(this.id, values).slice(0, request.maxResults);
    return newsResult(
      this.id,
      request.query,
      await normalizeNewsItems(this.id, items, this.validateUrl, signal),
      started,
    );
  }

}

function itemFromRecord(provider: "serpapi", item: Record<string, unknown>): NewsItem | undefined {
  const url = optionalString(item.link);
  const title = optionalString(item.title);
  if (url === undefined || title === undefined) return undefined;
  const result: NewsItem = {
    title,
    url,
    snippet: optionalString(item.snippet) ?? "",
    provider,
  };
  const sourceValue = item.source;
  const source =
    sourceValue && typeof sourceValue === "object"
      ? optionalString((sourceValue as Record<string, unknown>).name)
      : undefined;
  const publishedAt = optionalString(item.iso_date) ?? optionalString(item.date);
  const thumbnailUrl = optionalString(item.thumbnail);
  if (source !== undefined) result.source = source;
  if (publishedAt !== undefined) result.publishedAt = publishedAt;
  if (thumbnailUrl !== undefined) result.thumbnailUrl = thumbnailUrl;
  return result;
}

function flattenNews(provider: "serpapi", values: readonly unknown[]): NewsItem[] {
  const items: NewsItem[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const direct = itemFromRecord(provider, record);
    if (direct !== undefined) items.push(direct);
    const highlight = record.highlight;
    if (highlight && typeof highlight === "object") {
      const highlighted = itemFromRecord(provider, highlight as Record<string, unknown>);
      if (highlighted !== undefined) items.push(highlighted);
    }
    if (Array.isArray(record.stories)) {
      for (const story of record.stories) {
        if (!story || typeof story !== "object") continue;
        const nested = itemFromRecord(provider, story as Record<string, unknown>);
        if (nested !== undefined) items.push(nested);
      }
    }
  }
  return items;
}
