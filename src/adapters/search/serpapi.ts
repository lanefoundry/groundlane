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

interface SerpApiOptions {
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

function queryWithDomains(request: SearchRequest): string {
  const included = cleanDomains(request.domains);
  const excluded = cleanDomains(request.excludeDomains);
  const clauses = [request.query];
  if (included?.length) {
    clauses.push(`(${included.map((domain) => `site:${domain}`).join(" OR ")})`);
  }
  if (excluded?.length) {
    clauses.push(...excluded.map((domain) => `-site:${domain}`));
  }
  return clauses.join(" ");
}

export class SerpApiSearchProvider implements SearchProvider {
  readonly id = "serpapi" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(private readonly options: SerpApiOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.length > 0;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", queryWithDomains(request));
    url.searchParams.set("num", String(request.maxResults));
    url.searchParams.set("api_key", this.options.apiKey);
    if (request.timeRange !== undefined) {
      url.searchParams.set("tbs", timeRange[request.timeRange]);
    }

    const raw = await providerJson(
      this.fetcher,
      url.href,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    if (raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string") {
      const message = (raw as { error: string }).error;
      if (/rate|limit|credit|searches/iu.test(message)) {
        throw new GroundlaneError("RATE_LIMITED", "search", "SerpApi quota or rate limit reached", true);
      }
      throw new GroundlaneError("UPSTREAM_ERROR", "search", "SerpApi rejected the request");
    }
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { organic_results?: unknown }).organic_results)
        ? (raw as { organic_results: unknown[] }).organic_results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "search", "SerpApi returned a malformed response", true);
    }
    const items: SearchResultItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.link !== "string") return [];
      return [
        {
          title: item.title,
          url: item.link,
          snippet: typeof item.snippet === "string" ? item.snippet : "",
          ...(typeof item.date === "string" ? { publishedAt: item.date } : {}),
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

export { SerpApiSearchProvider as SerpApiProvider };
