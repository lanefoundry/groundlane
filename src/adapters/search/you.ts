import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchResultItem,
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

const YOU_SEARCH_URL = "https://ydc-index.io/v1/search";

interface YouOptions {
  apiKey: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
}

export class YouSearchProvider implements SearchProvider {
  readonly id = "you" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(private readonly options: YouOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
  }

  supports(request: SearchRequest): boolean {
    return !(
      this.options.apiKey.length === 0 ||
      (request.domains?.length && request.excludeDomains?.length)
    );
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const includeDomains = cleanDomains(request.domains);
    const excludeDomains = cleanDomains(request.excludeDomains);
    const raw = await providerJson(
      this.fetcher,
      YOU_SEARCH_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: request.query,
          count: request.maxResults,
          ...(request.timeRange === undefined ? {} : { freshness: request.timeRange }),
          ...(includeDomains === undefined ? {} : { include_domains: includeDomains }),
          ...(excludeDomains === undefined ? {} : { exclude_domains: excludeDomains }),
        }),
      },
      signal,
    );
    const results =
      raw && typeof raw === "object" &&
      (raw as { results?: unknown }).results &&
      typeof (raw as { results?: unknown }).results === "object"
        ? ((raw as { results: Record<string, unknown> }).results)
        : undefined;
    if (results === undefined || (!Array.isArray(results.web) && !Array.isArray(results.news))) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "You.com returned a malformed response",
        true,
      );
    }
    const webValues: unknown[] = Array.isArray(results.web)
      ? (results.web as unknown[])
      : [];
    const newsValues: unknown[] = Array.isArray(results.news)
      ? (results.news as unknown[])
      : [];
    const values: unknown[] = [...webValues, ...newsValues];
    const items: SearchResultItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.url !== "string") return [];
      const snippets = Array.isArray(item.snippets)
        ? item.snippets.filter((entry): entry is string => typeof entry === "string")
        : [];
      const snippet =
        snippets.length > 0
          ? snippets.join("\n")
          : typeof item.description === "string"
            ? item.description
            : "";
      return [
        {
          title: item.title,
          url: item.url,
          snippet,
          ...(typeof item.page_age === "string" ? { publishedAt: item.page_age } : {}),
          provider: this.id,
        },
      ];
    });
    return {
      query: request.query,
      provider: this.id,
      results: await validateItems(items, this.validateUrl),
      durationMs: Math.round(performance.now() - started),
      warnings: [],
    };
  }
}
