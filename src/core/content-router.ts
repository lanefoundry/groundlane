import type {
  ContentProvider,
  ContentProviderId,
  ContentProviderResult,
  ContentRequest,
  ContentResult,
} from "./contracts.js";
import { GroundlaneError, hint, toGroundlaneError } from "./errors.js";
import { consumeProviderAttemptBudget, type ProviderAttemptBudgetTracker } from "./search-budget.js";
import { resolvePublicUrl } from "./url-policy.js";

export const CONTENT_PROVIDER_IDS = [
  "linkup",
  "you",
  "exa",
  "tavily",
  "firecrawl",
  "tinyfish",
  "keenable",
] as const satisfies readonly ContentProviderId[];

interface ContentOutcome {
  provider: ContentProvider;
  attempted: boolean;
  result?: ContentProviderResult;
  warning?: string;
}

export class ContentRouter {
  private readonly providers: ReadonlyMap<ContentProviderId, ContentProvider>;

  constructor(
    providers: readonly ContentProvider[],
    private readonly order: readonly ContentProviderId[] = CONTENT_PROVIDER_IDS,
    private readonly budget?: ProviderAttemptBudgetTracker,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async fetchContent(request: ContentRequest, signal: AbortSignal): Promise<ContentResult> {
    await this.validateRequest(request);
    const startedAt = Date.now();
    const selected = this.resolveProviders(request);
    if (selected.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_content",
        "No configured content provider supports this request",
        true,
        undefined,
        hint("web_content.no_provider", "No configured content provider matched the request. Check provider_quota to see which adapters are enabled, and ensure at least one of them is keyed or in the auto pool."),
      );
    }
    const strategy =
      request.provider !== undefined && request.provider !== "auto"
        ? "fallback"
        : (request.strategy ?? "parallel");
    return strategy === "fallback"
      ? this.fetchWithFallback(request, selected, startedAt, signal)
      : this.fetchInParallel(request, selected, startedAt, signal);
  }

  private async validateRequest(request: ContentRequest): Promise<void> {
    if (
      !request.url.trim() ||
      !Number.isInteger(request.maxContentChars) ||
      request.maxContentChars < 1 ||
      request.maxContentChars > 200_000 ||
      (request.providers !== undefined && request.providers.length === 0) ||
      (request.provider !== undefined &&
        request.provider !== "auto" &&
        request.providers !== undefined)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "web_content",
        "Content URL, output limit, or provider selection is invalid",
        false,
        undefined,
        hint("web_content.invalid_input", "Check the request: url must be a non-empty public http(s) URL, maxContentChars must be 1-200000, and provider/providers must be specified at most once."),
      );
    }
    await resolvePublicUrl(request.url);
  }

  private resolveProviders(request: ContentRequest): ContentProvider[] {
    const requested =
      request.provider !== undefined && request.provider !== "auto"
        ? [request.provider]
        : (request.providers ?? this.order);
    const resolved: ContentProvider[] = [];
    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (provider !== undefined && provider.supports(request)) {
        resolved.push(provider);
      }
    }
    return resolved;
  }

  private async fetchWithFallback(
    request: ContentRequest,
    providers: readonly ContentProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<ContentResult> {
    const warnings: string[] = [];
    const attempted: ContentProviderId[] = [];
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
        const result = await provider.fetchContent(request, signal);
        return {
          url: request.url,
          strategy: "fallback",
          providersSelected: providers.map((item) => item.id),
          providersAttempted: attempted,
          providersSucceeded: [provider.id],
          contents: [result],
          durationMs: Date.now() - startedAt,
          warnings: [...warnings, ...result.warnings],
        };
      } catch (error) {
        const safe = toGroundlaneError(error, "web_content");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "web_content",
      "All selected content providers were unavailable",
      true,
      undefined,
      hint("web_content.all_providers_failed", "Every selected provider errored. Inspect the warnings field for per-provider failure reasons. Try a different provider, add credentials, or wait for upstream to recover."),
    );
  }

  private async fetchInParallel(
    request: ContentRequest,
    providers: readonly ContentProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<ContentResult> {
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<ContentOutcome> => {
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
          return { provider, attempted: true, result: await provider.fetchContent(request, signal) };
        } catch (error) {
          toGroundlaneError(error, "web_content");
          return { provider, attempted: true, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_content", "The request was cancelled", false, undefined, hint("web_content.cancelled", "The caller aborted the request before any provider returned. Issue a fresh call if you still need this content."));
    }
    const contents = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is ContentProviderResult => result !== undefined);
    if (contents.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_content",
        "All selected content providers were unavailable",
        true,
        undefined,
        hint("web_content.all_providers_failed", "Every selected provider errored. Inspect the warnings field for per-provider failure reasons. Try a different provider, add credentials, or wait for upstream to recover."),
      );
    }
    return {
      url: request.url,
      strategy: "parallel",
      providersSelected: providers.map((provider) => provider.id),
      providersAttempted: outcomes
        .filter((outcome) => outcome.attempted)
        .map((outcome) => outcome.provider.id),
      providersSucceeded: contents.map((content) => content.provider),
      contents,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...outcomes.flatMap((outcome) =>
          outcome.warning === undefined ? [] : [outcome.warning],
        ),
        ...contents.flatMap((content) => content.warnings),
      ],
    };
  }
}