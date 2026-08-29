import type {
  AnswerCitation,
  AnswerProvider,
  AnswerProviderResult,
  AnswerRequest,
  AnswerResultItem,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { cleanDomains } from "../search/common.js";
import {
  answerProviderJson,
  defaultAnswerUrlValidator,
  validateAnswerCitations,
  validateAnswerItems,
  type AnswerFetchLike,
  type AnswerUrlValidator,
} from "./common.js";

const YOU_ANSWER_URL = "https://api.you.com/v1/answer";

interface YouAnswerOptions {
  apiKey?: string;
  fetch?: AnswerFetchLike;
  validateUrl?: AnswerUrlValidator;
}

function youAnswerBody(request: AnswerRequest): Record<string, unknown> {
  const includeDomains = cleanDomains(request.domains);
  const excludeDomains = cleanDomains(request.excludeDomains);
  return {
    query: request.query,
    ...(request.timeRange === undefined ? {} : { freshness: request.timeRange }),
    ...(includeDomains === undefined ? {} : { include_domains: includeDomains }),
    ...(excludeDomains === undefined ? {} : { exclude_domains: excludeDomains }),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export class YouAnswerProvider implements AnswerProvider {
  readonly id = "you" as const;
  private readonly fetcher: AnswerFetchLike;
  private readonly validateUrl: AnswerUrlValidator;

  constructor(private readonly options: YouAnswerOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultAnswerUrlValidator;
  }

  supports(request: AnswerRequest): boolean {
    const apiKey = this.options.apiKey?.trim();
    return apiKey !== undefined &&
      apiKey.length > 0 &&
      !(request.domains?.length && request.excludeDomains?.length);
  }

  async answer(request: AnswerRequest, signal: AbortSignal): Promise<AnswerProviderResult> {
    const apiKey = this.options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_answer",
        "You.com Answer requires a configured API key",
        true,
      );
    }
    const started = performance.now();
    const raw = await answerProviderJson(
      this.fetcher,
      YOU_ANSWER_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(youAnswerBody(request)),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || typeof (raw as { answer?: unknown }).answer !== "string") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_answer",
        "You.com returned a malformed answer response",
        true,
      );
    }
    const value = raw as Record<string, unknown>;
    const answer = value.answer as string;
    const citations: AnswerCitation[] = Array.isArray(value.citations)
      ? value.citations.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const citation = entry as Record<string, unknown>;
          if (typeof citation.source !== "string") return [];
          return [
            {
              url: citation.source,
              excerpts: stringArray(citation.excerpts),
            },
          ];
        })
      : [];
    const webResults =
      value.results && typeof value.results === "object" && Array.isArray((value.results as { web?: unknown }).web)
        ? ((value.results as { web: unknown[] }).web)
        : [];
    const results: AnswerResultItem[] = webResults.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.url !== "string") return [];
      const snippets = stringArray(item.snippets);
      return [
        {
          title: item.title,
          url: item.url,
          snippet: snippets.length > 0
            ? snippets.join("\n")
            : typeof item.description === "string"
              ? item.description
              : "",
          ...(typeof item.page_age === "string" ? { publishedAt: item.page_age } : {}),
          provider: this.id,
        },
      ];
    });
    return {
      provider: this.id,
      answer,
      citations: await validateAnswerCitations(citations.slice(0, request.maxResults), this.validateUrl, signal),
      results: await validateAnswerItems(results.slice(0, request.maxResults), this.validateUrl, signal),
      durationMs: Math.round(performance.now() - started),
      warnings: [],
    };
  }
}
