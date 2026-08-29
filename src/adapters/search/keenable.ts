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

const KEENABLE_KEYED_SEARCH_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
const KEENABLE_PUBLIC_TITLE = "Groundlane";
const SNIPPET_MAX_LENGTH = 1_000;

const publishedAfterByRange: Readonly<Record<SearchTimeRange, string>> = {
  day: "1d",
  week: "7d",
  month: "30d",
  year: "1y",
};

interface KeenableOptions {
  apiKey?: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
  publicTitle?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export class KeenableSearchProvider implements SearchProvider {
  readonly id = "keenable" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;
  private readonly publicTitle: string;

  constructor(private readonly options: KeenableOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
    this.publicTitle = options.publicTitle ?? KEENABLE_PUBLIC_TITLE;
  }

  supports(request: SearchRequest): boolean {
    return !request.excludeDomains?.length && (request.domains?.length ?? 0) <= 1;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const includeDomains = cleanDomains(request.domains);
    const apiKey = this.options.apiKey?.trim();
    const keyed = apiKey !== undefined && apiKey.length > 0;
    const raw = await providerJson(
      this.fetcher,
      keyed ? KEENABLE_KEYED_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(keyed
            ? { "x-api-key": apiKey }
            : { "x-keenable-title": this.publicTitle }),
        },
        body: JSON.stringify({
          query: request.query,
          max_results: request.maxResults,
          snippet_max_length: SNIPPET_MAX_LENGTH,
          ...(includeDomains?.[0] === undefined ? {} : { site: includeDomains[0] }),
          ...(request.timeRange === undefined
            ? {}
            : { published_after: publishedAfterByRange[request.timeRange] }),
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "Keenable returned a malformed response",
        true,
      );
    }
    const items: SearchResultItem[] = (raw as { results: unknown[] }).results.flatMap(
      (value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const title = optionalString(item.title);
        const url = optionalString(item.url);
        const publishedAt = optionalString(item.published_at);
        if (title === undefined || url === undefined) return [];
        return [
          {
            title,
            url,
            snippet: optionalString(item.snippet) ?? optionalString(item.description) ?? "",
            ...(publishedAt === undefined ? {} : { publishedAt }),
            provider: this.id,
          },
        ];
      },
    );
    return {
      query: request.query,
      provider: this.id,
      results: await validateItems(items, this.validateUrl),
      durationMs: Math.round(performance.now() - started),
      warnings: keyed ? [] : ["keenable public endpoint used"],
    };
  }
}
