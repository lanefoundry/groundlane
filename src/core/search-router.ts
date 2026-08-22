import type {
  SearchProvider,
  SearchProviderId,
  SearchRequest,
  SearchResult,
  SearchStrategy,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";
import { fuseSearchResults } from "./search-fusion.js";
import type { SearchBudgetTracker } from "./search-budget.js";
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
    private readonly isHealthy: (id: SearchProviderId) => boolean = () => true,
    private readonly budget?: SearchBudgetTracker,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    this.validateRequest(request);
    const explicitProvider =
      request.provider !== undefined && request.provider !== "auto"
        ? request.provider
        : undefined;
    const strategy: SearchStrategy = explicitProvider === undefined
      ? (request.strategy ?? "balanced")
      : "fallback";
    const resolved = this.resolveProviders(request, explicitProvider);
    const selectedIds = selectSearchProviders(
      resolved.providers.map((provider) => provider.id),
      strategy,
    );
    const selected = selectedIds
      .map((id) => this.providers.get(id))
      .filter((provider): provider is SearchProvider => provider !== undefined);

    if (selected.length === 0) {
      if (explicitProvider !== undefined && this.budget?.remaining(explicitProvider) === 0) {
        throw new GroundlaneError(
          "PROVIDER_UNAVAILABLE",
          "search-budget",
          `${explicitProvider} monthly request budget is exhausted`,
          true,
        );
      }
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "search",
        "No configured provider supports this request",
        true,
      );
    }

    return strategy === "fallback"
      ? this.searchWithFallback(request, selected, resolved.warnings, signal)
      : this.searchFederated(request, strategy, selected, resolved.warnings, signal);
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
        !this.isHealthy(provider.id) ||
        !provider.supports(request)
      ) {
        continue;
      }
      if (this.budget?.remaining(provider.id) === 0) {
        warnings.push(`${provider.id} monthly budget exhausted`);
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

  private async searchWithFallback(
    request: SearchRequest,
    providers: readonly SearchProvider[],
    initialWarnings: readonly string[],
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
            `${provider.id} monthly request budget is exhausted`,
            true,
          );
        }
        warnings.push(`${provider.id} monthly budget exhausted`);
        continue;
      }
      attempted.push(provider.id);
      try {
        const normalized = this.normalizeProviderResult(
          provider,
          await provider.search(request, signal),
          request.maxResults,
        );
        return {
          ...normalized,
          strategy: "fallback",
          providersSelected: providers.map((item) => item.id),
          providersAttempted: attempted,
          providersSucceeded: [provider.id],
          warnings: [...warnings, ...normalized.warnings],
        };
      } catch (error) {
        const safe = toGroundlaneError(error, "search");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }

    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "search",
      "All matching search providers were unavailable",
      true,
    );
  }

  private async searchFederated(
    request: SearchRequest,
    strategy: Exclude<SearchStrategy, "fallback">,
    providers: readonly SearchProvider[],
    initialWarnings: readonly string[],
    signal: AbortSignal,
  ): Promise<SearchResult> {
    const startedAt = Date.now();
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<ProviderOutcome> => {
        if (this.budget !== undefined && !this.budget.tryConsume(provider.id)) {
          return {
            provider,
            attempted: false,
            warning: `${provider.id} monthly budget exhausted`,
          };
        }
        try {
          return {
            provider,
            attempted: true,
            result: this.normalizeProviderResult(
              provider,
              await provider.search(request, signal),
              request.maxResults,
            ),
          };
        } catch (error) {
          toGroundlaneError(error, "search");
          return { provider, attempted: true, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "search", "The request was cancelled");
    }
    const successes = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is SearchResult => result !== undefined);
    if (successes.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "search",
        "All matching search providers were unavailable",
        true,
      );
    }

    const warnings = [
      ...initialWarnings,
      ...outcomes.flatMap((outcome) => outcome.warning === undefined ? [] : [outcome.warning]),
      ...successes.flatMap((result) => result.warnings),
    ];
    return {
      query: request.query,
      provider: providers.length > 1 ? "federated" : successes[0]?.provider ?? "federated",
      results: fuseSearchResults(successes, request.maxResults),
      durationMs: Date.now() - startedAt,
      warnings,
      strategy,
      providersSelected: providers.map((provider) => provider.id),
      providersAttempted: outcomes
        .filter((outcome) => outcome.attempted)
        .map((outcome) => outcome.provider.id),
      providersSucceeded: successes.map((result) => result.provider),
    };
  }
}
