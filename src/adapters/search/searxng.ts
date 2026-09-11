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

interface SearXNGOptions {
  baseUrl: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export class SearXNGSearchProvider implements SearchProvider {
  readonly id = "searxng" as const;
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(options: SearXNGOptions) {
    const trimmed = options.baseUrl.trim().replace(/\/+$/u, "");
    if (!trimmed) {
      throw new GroundlaneError("INVALID_INPUT", "search", "SearXNG requires a base URL");
    }
    this.baseUrl = trimmed;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
  }

  supports(_request: SearchRequest): boolean {
    void _request;
    return true;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();

    const params = new URLSearchParams({
      q: request.query,
      format: "json",
      categories: "general",
    });

    if (request.timeRange !== undefined) {
      const rangeMap: Record<string, string> = {
        day: "day",
        week: "week",
        month: "month",
        year: "year",
      };
      params.set("time_range", rangeMap[request.timeRange] ?? "");
    }

    const url = `${this.baseUrl}/search?${params.toString()}`;

    const raw = await providerJson(
      this.fetcher,
      url,
      { method: "GET" },
      signal,
    );

    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "SearXNG returned a malformed response",
        true,
      );
    }

    const items: SearchResultItem[] = (raw as { results: unknown[] }).results
      .slice(0, request.maxResults)
      .flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const title = optionalString(item.title);
        const url = optionalString(item.url);
        if (title === undefined || url === undefined) return [];
        return [
          {
            title,
            url,
            snippet: optionalString(item.content) ?? "",
            ...(optionalString(item.publishedDate) !== undefined
              ? { publishedAt: item.publishedDate as string }
              : {}),
            provider: this.id,
          },
        ];
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
