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

interface FirecrawlOptions {
  apiKey: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
}

const timeRange: Record<SearchTimeRange, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

export class FirecrawlSearchProvider implements SearchProvider {
  readonly id = "firecrawl" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(private readonly options: FirecrawlOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
  }

  supports(request: SearchRequest): boolean {
    return (
      this.options.apiKey.length > 0 &&
      !(request.domains?.length && request.excludeDomains?.length)
    );
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const raw = await providerJson(
      this.fetcher,
      "https://api.firecrawl.dev/v2/search",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: request.query,
          limit: request.maxResults,
          sources: ["web"],
          includeDomains: cleanDomains(request.domains),
          excludeDomains: cleanDomains(request.excludeDomains),
          tbs: request.timeRange === undefined ? undefined : timeRange[request.timeRange],
          highlights: false,
        }),
      },
      signal,
    );
    const data =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>).data : undefined;
    const values =
      data && typeof data === "object" && Array.isArray((data as { web?: unknown }).web)
        ? (data as { web: unknown[] }).web
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "Firecrawl returned a malformed response",
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
          snippet:
            typeof item.description === "string"
              ? item.description
              : typeof item.snippet === "string"
                ? item.snippet
                : "",
          ...(typeof item.date === "string" ? { publishedAt: item.date } : {}),
          provider: this.id,
        },
      ];
    });
    const warning =
      raw && typeof raw === "object" && typeof (raw as { warning?: unknown }).warning === "string"
        ? (raw as { warning: string }).warning
        : undefined;
    return {
      query: request.query,
      provider: this.id,
      results: await validateItems(items, this.validateUrl, signal),
      durationMs: Math.round(performance.now() - started),
      warnings: warning === undefined ? [] : [warning],
    };
  }
}

export { FirecrawlSearchProvider as FirecrawlProvider };
