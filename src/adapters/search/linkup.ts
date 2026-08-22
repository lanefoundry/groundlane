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

const LINKUP_SEARCH_URL = "https://api.linkup.so/v1/search";

interface LinkupOptions {
  apiKey: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
  now?: () => Date;
}

const rangeDays: Readonly<Record<SearchTimeRange, number>> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class LinkupSearchProvider implements SearchProvider {
  readonly id = "linkup" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;
  private readonly now: () => Date;

  constructor(private readonly options: LinkupOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
    this.now = options.now ?? (() => new Date());
  }

  supports(): boolean {
    return this.options.apiKey.length > 0;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const includeDomains = cleanDomains(request.domains);
    const excludeDomains = cleanDomains(request.excludeDomains);
    const current = this.now();
    const dateRange =
      request.timeRange === undefined
        ? undefined
        : {
            fromDate: isoDate(
              new Date(current.getTime() - rangeDays[request.timeRange] * 86_400_000),
            ),
            toDate: isoDate(current),
          };
    const raw = await providerJson(
      this.fetcher,
      LINKUP_SEARCH_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          q: request.query,
          depth: "standard",
          outputType: "searchResults",
          maxResults: request.maxResults,
          ...(includeDomains === undefined ? {} : { includeDomains }),
          ...(excludeDomains === undefined ? {} : { excludeDomains }),
          ...dateRange,
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "Linkup returned a malformed response",
        true,
      );
    }
    const items: SearchResultItem[] = (raw as { results: unknown[] }).results.flatMap(
      (value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        return typeof item.name === "string" &&
          typeof item.url === "string" &&
          typeof item.content === "string"
          ? [
              {
                title: item.name,
                url: item.url,
                snippet: item.content,
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
