import type {
  AnswerProvider,
  AnswerProviderId,
  AnswerProviderResult,
  AnswerRequest,
  AnswerResult,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";

export const ANSWER_PROVIDER_IDS = ["linkup", "you"] as const satisfies readonly AnswerProviderId[];

interface AnswerOutcome {
  provider: AnswerProvider;
  result?: AnswerProviderResult;
  warning?: string;
}

export class AnswerRouter {
  private readonly providers: ReadonlyMap<AnswerProviderId, AnswerProvider>;

  constructor(
    providers: readonly AnswerProvider[],
    private readonly order: readonly AnswerProviderId[] = ANSWER_PROVIDER_IDS,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async answer(request: AnswerRequest, signal: AbortSignal): Promise<AnswerResult> {
    this.validateRequest(request);
    const startedAt = Date.now();
    const selected = this.resolveProviders(request);
    if (selected.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_answer",
        "No configured answer provider supports this request",
        true,
      );
    }

    const strategy =
      request.provider !== undefined && request.provider !== "auto"
        ? "fallback"
        : (request.strategy ?? "parallel");
    return strategy === "fallback"
      ? this.answerWithFallback(request, selected, startedAt, signal)
      : this.answerInParallel(request, selected, startedAt, signal);
  }

  private validateRequest(request: AnswerRequest): void {
    if (
      !request.query.trim() ||
      !Number.isInteger(request.maxResults) ||
      request.maxResults < 1 ||
      request.maxResults > 20 ||
      (request.providers !== undefined && request.providers.length === 0) ||
      (request.provider !== undefined &&
        request.provider !== "auto" &&
        request.providers !== undefined)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "web_answer",
        "Answer query, result limit, or provider selection is invalid",
      );
    }
  }

  private resolveProviders(request: AnswerRequest): AnswerProvider[] {
    const requested =
      request.provider !== undefined && request.provider !== "auto"
        ? [request.provider]
        : (request.providers ?? this.order);
    const resolved: AnswerProvider[] = [];
    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (provider !== undefined && provider.supports(request)) {
        resolved.push(provider);
      }
    }
    return resolved;
  }

  private async answerWithFallback(
    request: AnswerRequest,
    providers: readonly AnswerProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<AnswerResult> {
    const warnings: string[] = [];
    const attempted: AnswerProviderId[] = [];
    for (const provider of providers) {
      attempted.push(provider.id);
      try {
        const result = await provider.answer(request, signal);
        return {
          query: request.query,
          strategy: "fallback",
          providersSelected: providers.map((item) => item.id),
          providersAttempted: attempted,
          providersSucceeded: [provider.id],
          answers: [result],
          durationMs: Date.now() - startedAt,
          warnings: [...warnings, ...result.warnings],
        };
      } catch (error) {
        const safe = toGroundlaneError(error, "web_answer");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "web_answer",
      "All selected answer providers were unavailable",
      true,
    );
  }

  private async answerInParallel(
    request: AnswerRequest,
    providers: readonly AnswerProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<AnswerResult> {
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<AnswerOutcome> => {
        try {
          return { provider, result: await provider.answer(request, signal) };
        } catch (error) {
          toGroundlaneError(error, "web_answer");
          return { provider, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_answer", "The request was cancelled");
    }

    const answers = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is AnswerProviderResult => result !== undefined);
    if (answers.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_answer",
        "All selected answer providers were unavailable",
        true,
      );
    }

    return {
      query: request.query,
      strategy: "parallel",
      providersSelected: providers.map((provider) => provider.id),
      providersAttempted: providers.map((provider) => provider.id),
      providersSucceeded: answers.map((answer) => answer.provider),
      answers,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...outcomes.flatMap((outcome) =>
          outcome.warning === undefined ? [] : [outcome.warning],
        ),
        ...answers.flatMap((answer) => answer.warnings),
      ],
    };
  }
}
