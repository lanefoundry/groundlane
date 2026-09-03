import type {
  ProviderDetail,
  SearchProvider,
  SearchProviderId,
  SearchRequest,
  SearchResult,
  SearchStrategy,
} from "./contracts.js";
import {
  type DomainFilterValidationOptions,
  validateDomainFiltersForRequest,
} from "./domain-filter-validation.js";
import { GroundlaneError, hint, toGroundlaneError } from "./errors.js";
import { fuseSearchResults } from "./search-fusion.js";
import type { SearchBudgetTracker } from "./search-budget.js";
import type { ProviderHealthTracker } from "./provider-health.js";
import { searchProviderWeight } from "./search-provider-profile.js";
import { selectSearchProviders } from "./search-selector.js";

interface ResolvedProviders {
  providers: SearchProvider[];
  warnings: string[];
}

interface ProviderOutcome {
  provider: SearchProvider;
  attempted: boolean;
  result?: SearchResult;
  warning?: string;
}

export class SearchRouter {
  private readonly providers: ReadonlyMap<SearchProviderId, SearchProvider>;

  constructor(
    providers: readonly SearchProvider[],
    private readonly order: readonly SearchProviderId[],
    private readonly health?: ProviderHealthTracker,
    private readonly budget?: SearchBudgetTracker,
    private readonly filterOptions?: DomainFilterValidationOptions,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  private static builtInDetail(id: SearchProviderId): ProviderDetail {
    return {
      providerId: id,
      backend: "api",
      ownership: "built-in",
      protocolVersion: "1",
    };
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    this.validateRequest(request);
    const explicitProvider =
      request.provider !== undefined && request.provider !== "auto"
        ? request.provider
        : undefined;

    const candidateIds = explicitProvider === undefined
      ? (request.providers ?? this.order)
      : [explicitProvider];
    validateDomainFiltersForRequest(
      request,
      explicitProvider,
      candidateIds,
      this.filterOptions,
    );

    const strategy: SearchStrategy = explicitProvider === undefined
      ? (request.strategy ?? "balanced")
      : "fallback";
    const resolved = this.resolveProviders(request, explicitProvider);
    const selected =
      strategy === "fallback"
        ? resolved.providers
        : this.selectProviderBatch(resolved.providers, strategy);

    if (selected.length === 0) {
      if (explicitProvider !== undefined && this.budget?.remaining(explicitProvider) === 0) {
        throw new GroundlaneError(
          "PROVIDER_UNAVAILABLE",
          "search-budget",
          `${explicitProvider} request budget is exhausted`,
          true,
          undefined,
          hint("search_budget.exhausted", "The per-provider request budget is empty for the selected provider. Wait for the next reset window, raise SEARCH_*_REQUEST_BUDGETS in the operator config, or omit the explicit provider to let the router pick one with remaining quota."),
        );
      }
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "search",
        "No configured provider supports this request",
        true,
        undefined,
        hint("search.no_provider", "No configured search provider matched the request. Verify SEARCH_PROVIDER_ORDER, API keys, and that the requested capabilities (news, images, etc.) are exposed by at least one provider."),
      );
    }

    return strategy === "fallback"
      ? this.searchWithFallback(
        request,
        selected,
        resolved.warnings,
        explicitProvider !== undefined,
        signal,
      )
      : this.searchFederated(request, strategy, resolved.providers, resolved.warnings, signal);
  }

  private validateRequest(request: SearchRequest): void {
    if (
      !request.query.trim() ||
      !Number.isInteger(request.maxResults) ||
      request.maxResults < 1 ||
      request.maxResults > 50 ||
      (request.providers !== undefined && request.providers.length === 0) ||
      (request.provider !== undefined &&
        request.provider !== "auto" &&
        request.providers !== undefined)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "search",
        "Search query, result limit, or provider selection is invalid",
        false,
        undefined,
        hint("search.invalid_input", "Provide a non-empty query, set maxResults between 1 and 50, and choose either provider OR providers (not both)."),
      );
    }
  }

  private resolveProviders(
    request: SearchRequest,
    explicitProvider: SearchProviderId | undefined,
  ): ResolvedProviders {
    const requested = explicitProvider === undefined
      ? (request.providers ?? this.order)
      : [explicitProvider];
    const providers: SearchProvider[] = [];
    const warnings: string[] = [];

    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (
        provider === undefined ||
        (this.health !== undefined && !this.health.isHealthy(provider.id)) ||
        !provider.supports(request)
      ) {
        continue;
      }
      if (this.budget?.remaining(provider.id) === 0) {
        warnings.push(`${provider.id} budget exhausted`);
        continue;
      }
      providers.push(provider);
    }
    return { providers, warnings };
  }

  private normalizeProviderResult(
    provider: SearchProvider,
    result: SearchResult,
    maxResults: number,
  ): SearchResult {
    return {
      ...result,
      provider: provider.id,
      results: result.results.slice(0, maxResults).map((item) => ({
        ...item,
        provider: provider.id,
      })),
    };
  }

  private selectProviderBatch(
    providers: readonly SearchProvider[],
    strategy: Exclude<SearchStrategy, "fallback">,
  ): SearchProvider[] {
    const selectedIds = selectSearchProviders(
      providers.map((provider) => provider.id),
      strategy,
    );
    return selectedIds
      .map((id) => this.providers.get(id))
      .filter((provider): provider is SearchProvider => provider !== undefined);
  }

  private async searchWithFallback(
    request: SearchRequest,
    providers: readonly SearchProvider[],
    initialWarnings: readonly string[],
    explicitProvider: boolean,
    signal: AbortSignal,
  ): Promise<SearchResult> {
    const warnings = [...initialWarnings];
    const attempted: SearchProviderId[] = [];

    for (const provider of providers) {
      if (this.budget !== undefined && !this.budget.tryConsume(provider.id)) {
        if (providers.length === 1) {
          throw new GroundlaneError(
            "PROVIDER_UNAVAILABLE",
            "search-budget",
            `${provider.id} request budget is exhausted`,
            true,
            undefined,
            hint("search_budget.exhausted", "The per-provider request budget is empty for the selected provider. Wait for the next reset window, raise SEARCH_*_REQUEST_BUDGETS in the operator config, or omit the explicit provider to let the router pick one with remaining quota."),
          );
        }
        warnings.push(`${provider.id} budget exhausted`);
        continue;
      }
      attempted.push(provider.id);
      try {
        const normalized = this.normalizeProviderResult(
          provider,
          await provider.search(request, signal),
          request.maxResults,
        );
        this.health?.recordSuccess(provider.id);
        return {
          ...normalized,
          strategy: "fallback",
          providersSelected: providers.map((item) => item.id),
          providersAttempted: attempted,
          providersSucceeded: [provider.id],
          warnings: [...warnings, ...normalized.warnings],
          providerDetails: [SearchRouter.builtInDetail(provider.id)],
        };
      } catch (error) {
        const safe = toGroundlaneError(error, "search");
        this.health?.recordFailure(provider.id);
        if (explicitProvider || (providers.length === 1 && !safe.retryable)) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }

    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "search",
      "All matching search providers were unavailable",
      true,
      undefined,
      hint("search.all_providers_failed", "Every selected provider errored or returned no results. Check provider health, retry once, or fall back to web_fetch on a known URL."),
    );
  }

  private effectiveWeights(
    successes: readonly SearchResult[],
  ): Partial<Record<SearchProviderId, number>> {
    const weights: Partial<Record<SearchProviderId, number>> = {};
    for (const result of successes) {
      const base = searchProviderWeight(result.provider);
      const penalty = this.health?.penalty(result.provider) ?? 0;
      weights[result.provider] = base / (1 + penalty * 0.1);
    }
    return weights;
  }

  private async searchFederated(
    request: SearchRequest,
    strategy: Exclude<SearchStrategy, "fallback">,
    providers: readonly SearchProvider[],
    initialWarnings: readonly string[],
    signal: AbortSignal,
  ): Promise<SearchResult> {
    const startedAt = Date.now();
    const warnings = [...initialWarnings];
    const selectedIds: SearchProviderId[] = [];
    const attemptedIds: SearchProviderId[] = [];
    const remaining = [...providers];

    while (remaining.length > 0) {
      const batch = this.selectProviderBatch(remaining, strategy);
      if (batch.length === 0) break;
      selectedIds.push(...batch.map((provider) => provider.id));
      const selected = new Set(batch.map((provider) => provider.id));
      for (let index = remaining.length - 1; index >= 0; index--) {
        const provider = remaining[index];
        if (provider !== undefined && selected.has(provider.id)) remaining.splice(index, 1);
      }

      const outcomes = await Promise.all(
        batch.map(async (provider): Promise<ProviderOutcome> => {
          if (this.budget !== undefined && !this.budget.tryConsume(provider.id)) {
            return {
              provider,
              attempted: false,
              warning: `${provider.id} budget exhausted`,
            };
          }
          try {
            const result = this.normalizeProviderResult(
              provider,
              await provider.search(request, signal),
              request.maxResults,
            );
            this.health?.recordSuccess(provider.id);
            return { provider, attempted: true, result };
          } catch (error) {
            toGroundlaneError(error, "search");
            this.health?.recordFailure(provider.id);
            return { provider, attempted: true, warning: `${provider.id} unavailable` };
          }
        }),
      );
      if (signal.aborted) {
        if (signal.reason instanceof GroundlaneError) throw signal.reason;
        throw new GroundlaneError("CANCELLED", "search", "The request was cancelled");
      }

      attemptedIds.push(
        ...outcomes
          .filter((outcome) => outcome.attempted)
          .map((outcome) => outcome.provider.id),
      );
      warnings.push(
        ...outcomes.flatMap((outcome) => outcome.warning === undefined ? [] : [outcome.warning]),
      );

      const successes = outcomes
        .map((outcome) => outcome.result)
        .filter((result): result is SearchResult => result !== undefined);
      if (successes.length > 0) {
        warnings.push(...successes.flatMap((result) => result.warnings));
        return {
          query: request.query,
          provider: successes.length > 1 ? "federated" : successes[0]?.provider ?? "federated",
          results: fuseSearchResults(successes, request.maxResults, this.effectiveWeights(successes)),
          durationMs: Date.now() - startedAt,
          warnings,
          strategy,
          providersSelected: selectedIds,
          providersAttempted: attemptedIds,
          providersSucceeded: successes.map((result) => result.provider),
          providerDetails: successes.map((result) => SearchRouter.builtInDetail(result.provider)),
        };
      }
    }

    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "search",
      "All selected search providers were unavailable",
      true,
    );
  }
}
