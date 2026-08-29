import type {
  NewsItem,
  NewsProvider,
  NewsProviderId,
  NewsProviderResult,
  NewsRequest,
  NewsResult,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";
import { consumeProviderAttemptBudget, type ProviderAttemptBudgetTracker } from "./search-budget.js";

export const NEWS_PROVIDER_IDS = ["brave", "serper", "serpapi"] as const satisfies readonly NewsProviderId[];

interface NewsOutcome {
  provider: NewsProvider;
  attempted: boolean;
  result?: NewsProviderResult;
  warning?: string;
}

export class NewsRouter {
  private readonly providers: ReadonlyMap<NewsProviderId, NewsProvider>;

  constructor(
    providers: readonly NewsProvider[],
    private readonly order: readonly NewsProviderId[] = NEWS_PROVIDER_IDS,
    private readonly budget?: ProviderAttemptBudgetTracker,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async news(request: NewsRequest, signal: AbortSignal): Promise<NewsResult> {
    this.validateRequest(request);
    const startedAt = Date.now();
    const selected = this.resolveProviders(request);
    if (selected.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_news",
        "No configured news provider supports this request",
        true,
      );
    }
    const strategy =
      request.provider !== undefined && request.provider !== "auto"
        ? "fallback"
        : (request.strategy ?? "parallel");
    return strategy === "fallback"
      ? this.newsWithFallback(request, selected, startedAt, signal)
      : this.newsInParallel(request, selected, startedAt, signal);
  }

  private validateRequest(request: NewsRequest): void {
    if (
      !request.query.trim() ||
      request.query.length > 2_000 ||
      !Number.isInteger(request.maxResults) ||
      request.maxResults < 1 ||
      request.maxResults > 50 ||
      (request.country !== undefined && !/^[a-z]{2}$/iu.test(request.country)) ||
      (request.language !== undefined && !/^[a-z]{2}$/iu.test(request.language)) ||
      (request.providers !== undefined && request.providers.length === 0) ||
      (request.provider !== undefined &&
        request.provider !== "auto" &&
        request.providers !== undefined)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "web_news",
        "News query, limits, locale, or provider selection is invalid",
      );
    }
  }

  private resolveProviders(request: NewsRequest): NewsProvider[] {
    const requested =
      request.provider !== undefined && request.provider !== "auto"
        ? [request.provider]
        : (request.providers ?? this.order);
    const resolved: NewsProvider[] = [];
    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (provider !== undefined && provider.supports(request)) resolved.push(provider);
    }
    return resolved;
  }

  private async newsWithFallback(
    request: NewsRequest,
    providers: readonly NewsProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<NewsResult> {
    const warnings: string[] = [];
    const attempted: NewsProviderId[] = [];
    for (const provider of providers) {
      const budgetWarning = consumeProviderAttemptBudget(
        this.budget,
        provider.id,
        "provider-budget",
        providers.length === 1,
      );
      if (budgetWarning !== undefined) {
        warnings.push(budgetWarning);
        continue;
      }
      attempted.push(provider.id);
      try {
        const result = await provider.news(request, signal);
        return this.toResult(request, "fallback", providers, attempted, [result], startedAt, warnings);
      } catch (error) {
        const safe = toGroundlaneError(error, "web_news");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "web_news",
      "All selected news providers were unavailable",
      true,
    );
  }

  private async newsInParallel(
    request: NewsRequest,
    providers: readonly NewsProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<NewsResult> {
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<NewsOutcome> => {
        const budgetWarning = consumeProviderAttemptBudget(
          this.budget,
          provider.id,
          "provider-budget",
          false,
        );
        if (budgetWarning !== undefined) {
          return { provider, attempted: false, warning: budgetWarning };
        }
        try {
          return { provider, attempted: true, result: await provider.news(request, signal) };
        } catch (error) {
          toGroundlaneError(error, "web_news");
          return { provider, attempted: true, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_news", "The request was cancelled");
    }
    const results = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is NewsProviderResult => result !== undefined);
    if (results.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_news",
        "All selected news providers were unavailable",
        true,
      );
    }
    return this.toResult(
      request,
      "parallel",
      providers,
      outcomes
        .filter((outcome) => outcome.attempted)
        .map((outcome) => outcome.provider.id),
      results,
      startedAt,
      outcomes.flatMap((outcome) => outcome.warning === undefined ? [] : [outcome.warning]),
    );
  }

  private toResult(
    request: NewsRequest,
    strategy: "fallback" | "parallel",
    selected: readonly NewsProvider[],
    attempted: readonly NewsProviderId[],
    providerResults: readonly NewsProviderResult[],
    startedAt: number,
    warnings: readonly string[],
  ): NewsResult {
    return {
      query: request.query,
      strategy,
      providersSelected: selected.map((provider) => provider.id),
      providersAttempted: attempted,
      providersSucceeded: providerResults.map((result) => result.provider),
      results: dedupeNews(providerResults.flatMap((result) => result.results)).slice(0, request.maxResults),
      providerResults,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...warnings,
        ...providerResults.flatMap((result) => result.warnings),
      ],
    };
  }
}

function dedupeNews(items: readonly NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const deduped: NewsItem[] = [];
  for (const item of items) {
    const key = item.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
