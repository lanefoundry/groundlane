import type { SearchProvider, SearchRequest, SearchResult, SearchResultItem } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { assertSearchRequest, cleanDomains, defaultUrlValidator, providerJson, validateItems, type FetchLike, type UrlValidator } from "./common.js";

interface ExaOptions { apiKey: string; fetch?: FetchLike; validateUrl?: UrlValidator }
export class ExaSearchProvider implements SearchProvider {
  readonly id = "exa" as const; private readonly fetcher: FetchLike; private readonly validateUrl: UrlValidator;
  constructor(private readonly options: ExaOptions) { this.fetcher = options.fetch ?? globalThis.fetch; this.validateUrl = options.validateUrl ?? defaultUrlValidator; }
  supports(request: SearchRequest): boolean { return this.options.apiKey.length > 0 && !request.excludeDomains?.length && !request.timeRange; }
  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request); const started = performance.now();
    const raw = await providerJson(this.fetcher, "https://api.exa.ai/search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.options.apiKey }, body: JSON.stringify({ query: request.query, numResults: request.maxResults, includeDomains: cleanDomains(request.domains), contents: { text: { maxCharacters: 1_000 } } }) }, signal);
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) throw new GroundlaneError("UPSTREAM_ERROR", "search", "Exa returned a malformed response", true);
    const items: SearchResultItem[] = (raw as { results: unknown[] }).results.flatMap((value) => { if (!value || typeof value !== "object") return []; const item = value as Record<string, unknown>; return typeof item.title === "string" && typeof item.url === "string" ? [{ title: item.title, url: item.url, snippet: typeof item.text === "string" ? item.text : "", ...(typeof item.publishedDate === "string" ? { publishedAt: item.publishedDate } : {}), ...(typeof item.score === "number" ? { score: item.score } : {}), provider: this.id }] : []; });
    return { query: request.query, provider: this.id, results: await validateItems(items, this.validateUrl, signal), durationMs: Math.round(performance.now() - started), warnings: [] };
  }
}
export { ExaSearchProvider as ExaProvider };
