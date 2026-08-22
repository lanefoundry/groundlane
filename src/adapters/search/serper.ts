import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchResultItem,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  assertSearchRequest,
  defaultUrlValidator,
  providerJson,
  validateItems,
  type FetchLike,
  type UrlValidator,
} from "./common.js";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";

interface SerperOptions {
  apiKey: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
}

export class SerperSearchProvider implements SearchProvider {
  readonly id = "serper" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(private readonly options: SerperOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
  }

  supports(request: SearchRequest): boolean {
    return (
      this.options.apiKey.length > 0 &&
      !request.domains?.length &&
      !request.excludeDomains?.length &&
      request.timeRange === undefined
    );
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const raw = await providerJson(
      this.fetcher,
      SERPER_SEARCH_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ q: request.query, num: request.maxResults }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { organic?: unknown }).organic)) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "Serper returned a malformed response",
        true,
      );
    }
    const items: SearchResultItem[] = (raw as { organic: unknown[] }).organic.flatMap(
      (value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        return typeof item.title === "string" &&
          typeof item.link === "string" &&
          typeof item.snippet === "string"
          ? [
              {
                title: item.title,
                url: item.link,
                snippet: item.snippet,
                ...(typeof item.date === "string" ? { publishedAt: item.date } : {}),
                provider: this.id,
              },
            ]
          : [];
      },
    );
    return {
      query: request.query,
      provider: this.id,
      results: await validateItems(items, this.validateUrl),
      durationMs: Math.round(performance.now() - started),
      warnings: [],
    };
  }
}
