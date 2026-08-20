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

interface ParallelOptions {
  apiKey: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
}

export class ParallelSearchProvider implements SearchProvider {
  readonly id = "parallel" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;

  constructor(private readonly options: ParallelOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
  }

  supports(request: SearchRequest): boolean {
    return this.options.apiKey.length > 0 && request.timeRange === undefined;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const includeDomains = cleanDomains(request.domains);
    const excludeDomains = cleanDomains(request.excludeDomains);
    const sourcePolicy = {
      ...(includeDomains === undefined ? {} : { include_domains: includeDomains }),
      ...(excludeDomains === undefined ? {} : { exclude_domains: excludeDomains }),
    };
    const raw = await providerJson(
      this.fetcher,
      "https://api.parallel.ai/v1/search",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
        },
        body: JSON.stringify({
          objective: request.query,
          search_queries: [request.query],
          mode: "turbo",
          advanced_settings: {
            max_results: request.maxResults,
            ...(Object.keys(sourcePolicy).length === 0 ? {} : { source_policy: sourcePolicy }),
          },
        }),
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "search", "Parallel returned a malformed response", true);
    }
    const items: SearchResultItem[] = values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.url !== "string") return [];
      const excerpts = Array.isArray(item.excerpts)
        ? item.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
        : [];
      return [{
        title: item.title,
        url: item.url,
        snippet: excerpts.join("\n\n"),
        ...(typeof item.publish_date === "string" ? { publishedAt: item.publish_date } : {}),
        provider: this.id,
      }];
    });
    const warnings =
      raw && typeof raw === "object" && Array.isArray((raw as { warnings?: unknown }).warnings)
        ? (raw as { warnings: unknown[] }).warnings.filter(
            (warning): warning is string => typeof warning === "string",
          )
        : [];
    return {
      query: request.query,
      provider: this.id,
      results: await validateItems(items, this.validateUrl),
      durationMs: Math.round(performance.now() - started),
      warnings,
    };
  }
}

export { ParallelSearchProvider as ParallelProvider };
