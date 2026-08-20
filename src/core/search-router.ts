import type { SearchProvider, SearchProviderId, SearchRequest, SearchResult } from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";
import type { SearchBudgetTracker } from "./search-budget.js";

export class SearchRouter {
  private readonly providers: ReadonlyMap<SearchProviderId, SearchProvider>;
  constructor(
    providers: readonly SearchProvider[],
    private readonly order: readonly SearchProviderId[],
    private readonly isHealthy: (id: SearchProviderId) => boolean = () => true,
    private readonly budget?: SearchBudgetTracker,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    if (!request.query.trim() || !Number.isInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > 50) throw new GroundlaneError("INVALID_INPUT", "search", "Search query or result limit is invalid");
    const requested = request.provider && request.provider !== "auto" ? [request.provider] : this.order;
    const candidates = requested.map((id) => this.providers.get(id)).filter((provider): provider is SearchProvider => provider !== undefined && this.isHealthy(provider.id) && provider.supports(request));
    if (candidates.length === 0) throw new GroundlaneError("PROVIDER_UNAVAILABLE", "search", "No configured provider supports this request", true);
    const failures: string[] = [];
    for (const provider of candidates) {
      if (this.budget !== undefined && !this.budget.tryConsume(provider.id)) {
        if (requested.length === 1) {
          throw new GroundlaneError(
            "PROVIDER_UNAVAILABLE",
            "search-budget",
            `${provider.id} monthly request budget is exhausted`,
            true,
          );
        }
        failures.push(`${provider.id} monthly budget exhausted`);
        continue;
      }
      try {
        const result = await provider.search(request, signal);
        return { ...result, results: result.results.slice(0, request.maxResults).map((item) => ({ ...item, provider: provider.id })), warnings: [...failures, ...result.warnings] };
      } catch (error) {
        const safe = toGroundlaneError(error, "search");
        if (requested.length === 1 || !safe.retryable) throw safe;
        failures.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError("PROVIDER_UNAVAILABLE", "search", "All matching search providers were unavailable", true);
  }
}
