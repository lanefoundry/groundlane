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

const SERPER_NEWS_URL = "https://google.serper.dev/news";

interface SerperNewsOptions {
  apiKey: string;
  fetch?: NewsFetchLike;
  validateUrl?: NewsUrlValidator;
}

export class SerperNewsProvider implements NewsProvider {
  readonly id = "serper" as const;
  private readonly fetcher: NewsFetchLike;
  private readonly validateUrl: NewsUrlValidator;

  constructor(private readonly options: SerperNewsOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultNewsUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async news(request: NewsRequest, signal: AbortSignal): Promise<NewsProviderResult> {
    const started = performance.now();
    const raw = await newsProviderJson(
      this.fetcher,
      SERPER_NEWS_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          q: request.query,
          num: request.maxResults,
          gl: request.country?.toLowerCase() ?? "us",
          hl: request.language?.toLowerCase() ?? "en",
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { news?: unknown }).news)) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_news", "Serper returned a malformed news response", true);
    }
    const items: NewsItem[] = (raw as { news: unknown[] }).news.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const url = optionalString(item.link);
      const title = optionalString(item.title);
      if (url === undefined || title === undefined) return [];
      const newsItem: NewsItem = {
        title,
        url,
        snippet: optionalString(item.snippet) ?? "",
        provider: this.id,
      };
      const source = optionalString(item.source);
      const publishedAt = optionalString(item.date);
      const thumbnailUrl = optionalString(item.imageUrl);
      if (source !== undefined) newsItem.source = source;
      if (publishedAt !== undefined) newsItem.publishedAt = publishedAt;
      if (thumbnailUrl !== undefined) newsItem.thumbnailUrl = thumbnailUrl;
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
