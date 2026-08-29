import type { NewsItem, NewsProvider, NewsProviderResult, NewsRequest, SearchTimeRange } from "../../core/contracts.js";
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

interface BraveNewsOptions {
  apiKey: string;
  fetch?: NewsFetchLike;
  validateUrl?: NewsUrlValidator;
}

const freshness: Record<SearchTimeRange, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

export class BraveNewsProvider implements NewsProvider {
  readonly id = "brave" as const;
  private readonly fetcher: NewsFetchLike;
  private readonly validateUrl: NewsUrlValidator;

  constructor(private readonly options: BraveNewsOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultNewsUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async news(request: NewsRequest, signal: AbortSignal): Promise<NewsProviderResult> {
    const started = performance.now();
    const url = new URL("https://api.search.brave.com/res/v1/news/search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(request.maxResults));
    url.searchParams.set("country", request.country?.toUpperCase() ?? "US");
    url.searchParams.set("search_lang", request.language?.toLowerCase() ?? "en");
    if (request.timeRange !== undefined) url.searchParams.set("freshness", freshness[request.timeRange]);
    const raw = await newsProviderJson(
      this.fetcher,
      url.href,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": this.options.apiKey,
        },
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_news", "Brave returned a malformed news response", true);
    }
    const items: NewsItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const urlValue = optionalString(item.url);
      const title = optionalString(item.title);
      if (urlValue === undefined || title === undefined) return [];
      const newsItem: NewsItem = {
        title,
        url: urlValue,
        snippet: optionalString(item.description) ?? "",
        provider: this.id,
      };
      const publishedAt = optionalString(item.age);
      if (publishedAt !== undefined) newsItem.publishedAt = publishedAt;
      return [newsItem];
    });
    return newsResult(
      this.id,
      request.query,
      await normalizeNewsItems(this.id, items, this.validateUrl),
      started,
    );
  }
}
