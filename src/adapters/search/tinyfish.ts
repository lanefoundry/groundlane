import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchResultItem,
  SearchTimeRange,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  assertSearchRequest,
  cleanDomains,
  defaultUrlValidator,
  providerJson,
  validateItems,
  type FetchLike,
  type UrlValidator,
} from "./common.js";

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";

const recencyMinutes: Record<SearchTimeRange, number> = {
  day: 1_440,
  week: 10_080,
  month: 43_200,
  year: 525_600,
};

interface TinyFishSearchOptions {
  apiKey: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
}

export class TinyFishSearchProvider implements SearchProvider {
  readonly id = "tinyfish" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(private readonly options: TinyFishSearchOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
  }

  supports(request?: SearchRequest): boolean {
    void request;
    return this.options.apiKey.trim().length > 0;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const url = new URL(TINYFISH_SEARCH_URL);
    url.searchParams.set("query", request.query);
    const included = cleanDomains(request.domains);
    const excluded = cleanDomains(request.excludeDomains);
    if (included !== undefined) url.searchParams.set("include_domains", included.join(","));
    if (excluded !== undefined) url.searchParams.set("exclude_domains", excluded.join(","));
    if (request.timeRange !== undefined) {
      url.searchParams.set("recency_minutes", String(recencyMinutes[request.timeRange]));
    }

    const raw = await providerJson(
      this.fetcher,
      url.href,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": this.options.apiKey,
        },
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "TinyFish returned a malformed response",
        true,
      );
    }

    const items: SearchResultItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.url !== "string") return [];
      return [
        {
          title: item.title,
          url: item.url,
          snippet: typeof item.snippet === "string" ? item.snippet : "",
          ...(typeof item.date === "string" ? { publishedAt: item.date } : {}),
          ...(typeof item.position === "number" ? { score: 1 / item.position } : {}),
          provider: this.id,
        },
      ];
    });

    return {
      query: request.query,
      provider: this.id,
      results: (await validateItems(items, this.validateUrl, signal)).slice(0, request.maxResults),
      durationMs: Math.round(performance.now() - started),
      warnings: [],
    };
  }
}
