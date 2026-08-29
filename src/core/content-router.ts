import type {
  ContentProvider,
  ContentProviderId,
  ContentProviderResult,
  ContentRequest,
  ContentResult,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";
import { resolvePublicUrl } from "./url-policy.js";

export const CONTENT_PROVIDER_IDS = [
  "linkup",
  "you",
  "exa",
  "tavily",
  "firecrawl",
  "keenable",
] as const satisfies readonly ContentProviderId[];

interface ContentOutcome {
  provider: ContentProvider;
  result?: ContentProviderResult;
  warning?: string;
}

export class ContentRouter {
  private readonly providers: ReadonlyMap<ContentProviderId, ContentProvider>;

  constructor(
    providers: readonly ContentProvider[],
    private readonly order: readonly ContentProviderId[] = CONTENT_PROVIDER_IDS,
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
        try {
          return { provider, result: await provider.fetchContent(request, signal) };
        } catch (error) {
          toGroundlaneError(error, "web_content");
          return { provider, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_content", "The request was cancelled");
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
      );
    }
    return {
      url: request.url,
      strategy: "parallel",
      providersSelected: providers.map((provider) => provider.id),
      providersAttempted: providers.map((provider) => provider.id),
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
