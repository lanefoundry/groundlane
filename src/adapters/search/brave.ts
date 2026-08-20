import type { SearchProvider, SearchRequest, SearchResult, SearchResultItem } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { assertSearchRequest, defaultUrlValidator, providerJson, validateItems, type FetchLike, type UrlValidator } from "./common.js";

interface BraveOptions { apiKey: string; fetch?: FetchLike; validateUrl?: UrlValidator }
export class BraveSearchProvider implements SearchProvider {
  readonly id = "brave" as const; private readonly fetcher: FetchLike; private readonly validateUrl: UrlValidator;
  constructor(private readonly options: BraveOptions) { this.fetcher = options.fetch ?? globalThis.fetch; this.validateUrl = options.validateUrl ?? defaultUrlValidator; }
  supports(request: SearchRequest): boolean { return this.options.apiKey.length > 0 && !request.domains?.length && !request.excludeDomains?.length; }
  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request); const started = performance.now();
    const url = new URL("https://api.search.brave.com/res/v1/web/search"); url.searchParams.set("q", request.query); url.searchParams.set("count", String(request.maxResults)); if (request.timeRange) url.searchParams.set("freshness", request.timeRange === "day" ? "pd" : request.timeRange === "week" ? "pw" : request.timeRange === "month" ? "pm" : "py");
    const raw = await providerJson(this.fetcher, url.href, { method: "GET", headers: { accept: "application/json", "x-subscription-token": this.options.apiKey } }, signal);
    const values = raw && typeof raw === "object" && (raw as { web?: unknown }).web && typeof (raw as { web: unknown }).web === "object" ? (raw as { web: { results?: unknown } }).web.results : undefined;
    if (!Array.isArray(values)) throw new GroundlaneError("UPSTREAM_ERROR", "search", "Brave returned a malformed response", true);
    const items: SearchResultItem[] = values.flatMap((value) => { if (!value || typeof value !== "object") return []; const item = value as Record<string, unknown>; return typeof item.title === "string" && typeof item.url === "string" ? [{ title: item.title, url: item.url, snippet: typeof item.description === "string" ? item.description : "", ...(typeof item.age === "string" ? { publishedAt: item.age } : {}), provider: this.id }] : []; });
    return { query: request.query, provider: this.id, results: await validateItems(items, this.validateUrl), durationMs: Math.round(performance.now() - started), warnings: [] };
  }
}
export { BraveSearchProvider as BraveProvider };
