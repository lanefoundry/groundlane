import type {
  CrawlPage,
  CrawlProvider,
  CrawlProviderId,
  CrawlProviderResult,
  CrawlRequest,
  CrawlResult,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";
import { consumeProviderAttemptBudget, type ProviderAttemptBudgetTracker } from "./search-budget.js";
import { resolvePublicUrl } from "./url-policy.js";

export const CRAWL_PROVIDER_IDS = ["firecrawl", "tavily"] as const satisfies readonly CrawlProviderId[];

interface CrawlOutcome {
  provider: CrawlProvider;
  attempted: boolean;
  result?: CrawlProviderResult;
  warning?: string;
}

export class CrawlRouter {
  private readonly providers: ReadonlyMap<CrawlProviderId, CrawlProvider>;

  constructor(
    providers: readonly CrawlProvider[],
    private readonly order: readonly CrawlProviderId[] = CRAWL_PROVIDER_IDS,
    private readonly budget?: ProviderAttemptBudgetTracker,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async crawl(request: CrawlRequest, signal: AbortSignal): Promise<CrawlResult> {
    await this.validateRequest(request);
    const startedAt = Date.now();
    const selected = this.resolveProviders(request);
    if (selected.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_crawl",
        "No configured crawl provider supports this request",
        true,
      );
    }
    const strategy =
      request.provider !== undefined && request.provider !== "auto"
        ? "fallback"
        : (request.strategy ?? "parallel");
    return strategy === "fallback"
      ? this.crawlWithFallback(request, selected, startedAt, signal)
      : this.crawlInParallel(request, selected, startedAt, signal);
  }

  private async validateRequest(request: CrawlRequest): Promise<void> {
    if (
      !request.url.trim() ||
      !Number.isInteger(request.maxPages) ||
      request.maxPages < 1 ||
      request.maxPages > 100 ||
      !Number.isInteger(request.maxContentChars) ||
      request.maxContentChars < 0 ||
      request.maxContentChars > 20_000 ||
      (request.instructions !== undefined && request.instructions.trim().length === 0) ||
      (request.instructions !== undefined && request.instructions.length > 500) ||
      (request.maxDepth !== undefined &&
        (!Number.isInteger(request.maxDepth) || request.maxDepth < 1 || request.maxDepth > 5)) ||
      (request.maxBreadth !== undefined &&
        (!Number.isInteger(request.maxBreadth) || request.maxBreadth < 1 || request.maxBreadth > 500)) ||
      (request.maxPolls !== undefined &&
        (!Number.isInteger(request.maxPolls) || request.maxPolls < 1 || request.maxPolls > 5)) ||
      (request.pollIntervalMs !== undefined &&
        (!Number.isInteger(request.pollIntervalMs) || request.pollIntervalMs < 250 || request.pollIntervalMs > 5_000)) ||
      (request.providers !== undefined && request.providers.length === 0) ||
      (request.provider !== undefined &&
        request.provider !== "auto" &&
        request.providers !== undefined)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "web_crawl",
        "Crawl URL, limits, instructions, polling, or provider selection is invalid",
      );
    }
    await resolvePublicUrl(request.url);
  }

  private resolveProviders(request: CrawlRequest): CrawlProvider[] {
    const requested =
      request.provider !== undefined && request.provider !== "auto"
        ? [request.provider]
        : (request.providers ?? this.order);
    const resolved: CrawlProvider[] = [];
    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (provider !== undefined && provider.supports(request)) resolved.push(provider);
    }
    return resolved;
  }

  private async crawlWithFallback(
    request: CrawlRequest,
    providers: readonly CrawlProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<CrawlResult> {
    const warnings: string[] = [];
    const attempted: CrawlProviderId[] = [];
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
        const result = await provider.crawl(request, signal);
        return this.toResult(request, "fallback", providers, attempted, [result], startedAt, warnings);
      } catch (error) {
        const safe = toGroundlaneError(error, "web_crawl");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "web_crawl",
      "All selected crawl providers were unavailable",
      true,
    );
  }

  private async crawlInParallel(
    request: CrawlRequest,
    providers: readonly CrawlProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<CrawlResult> {
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<CrawlOutcome> => {
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
          return { provider, attempted: true, result: await provider.crawl(request, signal) };
        } catch (error) {
          toGroundlaneError(error, "web_crawl");
          return { provider, attempted: true, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_crawl", "The request was cancelled");
    }
    const results = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is CrawlProviderResult => result !== undefined);
    if (results.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_crawl",
        "All selected crawl providers were unavailable",
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
    request: CrawlRequest,
    strategy: "fallback" | "parallel",
    selected: readonly CrawlProvider[],
    attempted: readonly CrawlProviderId[],
    providerResults: readonly CrawlProviderResult[],
    startedAt: number,
    warnings: readonly string[],
  ): CrawlResult {
    return {
      url: request.url,
      strategy,
      providersSelected: selected.map((provider) => provider.id),
      providersAttempted: attempted,
      providersSucceeded: providerResults.map((result) => result.provider),
      pages: dedupePages(providerResults.flatMap((result) => result.pages)).slice(0, request.maxPages),
      providerResults,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...warnings,
        ...providerResults.flatMap((result) => result.warnings),
      ],
    };
  }
}

function dedupePages(pages: readonly CrawlPage[]): CrawlPage[] {
  const seen = new Set<string>();
  const deduped: CrawlPage[] = [];
  for (const page of pages) {
    const key = page.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(page);
  }
  return deduped;
}
