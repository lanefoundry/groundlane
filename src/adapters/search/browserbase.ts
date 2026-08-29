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

interface BrowserbaseOptions {
  apiKey: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
}

export class BrowserbaseSearchProvider implements SearchProvider {
  readonly id = "browserbase" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(private readonly options: BrowserbaseOptions) {
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
      "https://api.browserbase.com/v1/search",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-bb-api-key": this.options.apiKey,
        },
        body: JSON.stringify({ query: request.query, numResults: request.maxResults }),
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "search", "Browserbase returned a malformed response", true);
    }
    const items: SearchResultItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.url !== "string") return [];
      return [{
        title: item.title,
        url: item.url,
        snippet: "",
        ...(typeof item.publishedDate === "string" ? { publishedAt: item.publishedDate } : {}),
        provider: this.id,
      }];
    });
    return {
      query: request.query,
      provider: this.id,
      results: await validateItems(items, this.validateUrl, signal),
      durationMs: Math.round(performance.now() - started),
      warnings: [],
    };
  }
}

export { BrowserbaseSearchProvider as BrowserbaseProvider };
