import type {
  ResearchProvider,
  ResearchProviderId,
  ResearchProviderResult,
  ResearchRequest,
  ResearchResult,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";

export const RESEARCH_PROVIDER_IDS = ["you", "parallel"] as const satisfies readonly ResearchProviderId[];

interface ResearchOutcome {
  provider: ResearchProvider;
  result?: ResearchProviderResult;
  warning?: string;
}

export class ResearchRouter {
  private readonly providers: ReadonlyMap<ResearchProviderId, ResearchProvider>;

  constructor(
    providers: readonly ResearchProvider[],
    private readonly order: readonly ResearchProviderId[] = RESEARCH_PROVIDER_IDS,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async research(request: ResearchRequest, signal: AbortSignal): Promise<ResearchResult> {
    this.validateRequest(request);
    const startedAt = Date.now();
    const selected = this.resolveProviders(request);
    if (selected.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_research",
        "No configured research provider supports this request",
        true,
      );
    }

    const strategy =
      request.provider !== undefined && request.provider !== "auto"
        ? "fallback"
        : (request.strategy ?? "parallel");
    return strategy === "fallback"
      ? this.researchWithFallback(request, selected, startedAt, signal)
      : this.researchInParallel(request, selected, startedAt, signal);
  }

  private validateRequest(request: ResearchRequest): void {
    if (
      !request.query.trim() ||
      !["lite", "standard", "deep"].includes(request.effort) ||
      (request.providers !== undefined && request.providers.length === 0) ||
      (request.provider !== undefined &&
        request.provider !== "auto" &&
        request.providers !== undefined) ||
      (request.domains !== undefined && request.excludeDomains !== undefined)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "web_research",
        "Research query, effort, or provider selection is invalid",
      );
    }
  }

  private resolveProviders(request: ResearchRequest): ResearchProvider[] {
    const requested =
      request.provider !== undefined && request.provider !== "auto"
        ? [request.provider]
        : (request.providers ?? this.order);
    const resolved: ResearchProvider[] = [];
    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (provider !== undefined && provider.supports(request)) {
        resolved.push(provider);
      }
    }
    return resolved;
  }

  private async researchWithFallback(
    request: ResearchRequest,
    providers: readonly ResearchProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<ResearchResult> {
    const warnings: string[] = [];
    const attempted: ResearchProviderId[] = [];
    for (const provider of providers) {
      attempted.push(provider.id);
      try {
        const result = await provider.research(request, signal);
        return {
          query: request.query,
          effort: request.effort,
          strategy: "fallback",
          providersSelected: providers.map((item) => item.id),
          providersAttempted: attempted,
          providersSucceeded: [provider.id],
          reports: [result],
          durationMs: Date.now() - startedAt,
          warnings: [...warnings, ...result.warnings],
        };
      } catch (error) {
        const safe = toGroundlaneError(error, "web_research");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "web_research",
      "All selected research providers were unavailable",
      true,
    );
  }

  private async researchInParallel(
    request: ResearchRequest,
    providers: readonly ResearchProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<ResearchResult> {
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<ResearchOutcome> => {
        try {
          return { provider, result: await provider.research(request, signal) };
        } catch (error) {
          toGroundlaneError(error, "web_research");
          return { provider, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_research", "The request was cancelled");
    }

    const reports = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is ResearchProviderResult => result !== undefined);
    if (reports.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_research",
        "All selected research providers were unavailable",
        true,
      );
    }

    return {
      query: request.query,
      effort: request.effort,
      strategy: "parallel",
      providersSelected: providers.map((provider) => provider.id),
      providersAttempted: providers.map((provider) => provider.id),
      providersSucceeded: reports.map((report) => report.provider),
      reports,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...outcomes.flatMap((outcome) =>
          outcome.warning === undefined ? [] : [outcome.warning],
        ),
        ...reports.flatMap((report) => report.warnings),
      ],
    };
  }
}
