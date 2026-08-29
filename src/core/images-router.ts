import type {
  ImageItem,
  ImagesProvider,
  ImagesProviderId,
  ImagesProviderResult,
  ImagesRequest,
  ImagesResult,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";
import { consumeProviderAttemptBudget, type ProviderAttemptBudgetTracker } from "./search-budget.js";

export const IMAGES_PROVIDER_IDS = ["brave", "serper", "serpapi"] as const satisfies readonly ImagesProviderId[];

interface ImagesOutcome {
  provider: ImagesProvider;
  attempted: boolean;
  result?: ImagesProviderResult;
  warning?: string;
}

export class ImagesRouter {
  private readonly providers: ReadonlyMap<ImagesProviderId, ImagesProvider>;

  constructor(
    providers: readonly ImagesProvider[],
    private readonly order: readonly ImagesProviderId[] = IMAGES_PROVIDER_IDS,
    private readonly budget?: ProviderAttemptBudgetTracker,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async images(request: ImagesRequest, signal: AbortSignal): Promise<ImagesResult> {
    this.validateRequest(request);
    const startedAt = Date.now();
    const selected = this.resolveProviders(request);
    if (selected.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_images",
        "No configured images provider supports this request",
        true,
      );
    }
    const strategy =
      request.provider !== undefined && request.provider !== "auto"
        ? "fallback"
        : (request.strategy ?? "parallel");
    return strategy === "fallback"
      ? this.imagesWithFallback(request, selected, startedAt, signal)
      : this.imagesInParallel(request, selected, startedAt, signal);
  }

  private validateRequest(request: ImagesRequest): void {
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
        "web_images",
        "Images query, limits, locale, or provider selection is invalid",
      );
    }
  }

  private resolveProviders(request: ImagesRequest): ImagesProvider[] {
    const requested =
      request.provider !== undefined && request.provider !== "auto"
        ? [request.provider]
        : (request.providers ?? this.order);
    const resolved: ImagesProvider[] = [];
    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (provider !== undefined && provider.supports(request)) resolved.push(provider);
    }
    return resolved;
  }

  private async imagesWithFallback(
    request: ImagesRequest,
    providers: readonly ImagesProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<ImagesResult> {
    const warnings: string[] = [];
    const attempted: ImagesProviderId[] = [];
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
        const result = await provider.images(request, signal);
        return this.toResult(request, "fallback", providers, attempted, [result], startedAt, warnings);
      } catch (error) {
        const safe = toGroundlaneError(error, "web_images");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "web_images",
      "All selected images providers were unavailable",
      true,
    );
  }

  private async imagesInParallel(
    request: ImagesRequest,
    providers: readonly ImagesProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<ImagesResult> {
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<ImagesOutcome> => {
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
          return { provider, attempted: true, result: await provider.images(request, signal) };
        } catch {
          return { provider, attempted: true, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_images", "The request was cancelled");
    }
    const results = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is ImagesProviderResult => result !== undefined);
    if (results.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_images",
        "All selected images providers were unavailable",
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
    request: ImagesRequest,
    strategy: "fallback" | "parallel",
    selected: readonly ImagesProvider[],
    attempted: readonly ImagesProviderId[],
    providerResults: readonly ImagesProviderResult[],
    startedAt: number,
    warnings: readonly string[],
  ): ImagesResult {
    return {
      query: request.query,
      strategy,
      providersSelected: selected.map((provider) => provider.id),
      providersAttempted: attempted,
      providersSucceeded: providerResults.map((result) => result.provider),
      results: dedupeImages(providerResults.flatMap((result) => result.results)).slice(0, request.maxResults),
      providerResults,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...warnings,
        ...providerResults.flatMap((result) => result.warnings),
      ],
    };
  }
}

function dedupeImages(items: readonly ImageItem[]): ImageItem[] {
  const seen = new Set<string>();
  const deduped: ImageItem[] = [];
  for (const item of items) {
    const key = item.imageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
