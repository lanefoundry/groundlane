import type { SearchProvider, SearchRequest, SearchResult, SearchResultItem } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { assertSearchRequest, cleanDomains, defaultUrlValidator, providerJson, validateItems, type FetchLike, type UrlValidator } from "./common.js";

interface TavilyOptions { apiKey: string; fetch?: FetchLike; validateUrl?: UrlValidator }
export class TavilySearchProvider implements SearchProvider {
  readonly id = "tavily" as const;
  private readonly fetcher: FetchLike; private readonly validateUrl: UrlValidator;
  constructor(private readonly options: TavilyOptions) { this.fetcher = options.fetch ?? globalThis.fetch; this.validateUrl = options.validateUrl ?? defaultUrlValidator; }
  supports(): boolean { return this.options.apiKey.length > 0; }
  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request); const started = performance.now();
    const raw = await providerJson(this.fetcher, "https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` }, body: JSON.stringify({ query: request.query, max_results: request.maxResults, include_domains: cleanDomains(request.domains), exclude_domains: cleanDomains(request.excludeDomains), time_range: request.timeRange }) }, signal);
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) throw new GroundlaneError("UPSTREAM_ERROR", "search", "Tavily returned a malformed response", true);
    const items: SearchResultItem[] = (raw as { results: unknown[] }).results.flatMap((value) => { if (!value || typeof value !== "object") return []; const item = value as Record<string, unknown>; return typeof item.title === "string" && typeof item.url === "string" && typeof item.content === "string" ? [{ title: item.title, url: item.url, snippet: item.content, ...(typeof item.published_date === "string" ? { publishedAt: item.published_date } : {}), ...(typeof item.score === "number" ? { score: item.score } : {}), provider: this.id }] : []; });
    return { query: request.query, provider: this.id, results: await validateItems(items, this.validateUrl, signal), durationMs: Math.round(performance.now() - started), warnings: [] };
  }
}
export { TavilySearchProvider as TavilyProvider };
