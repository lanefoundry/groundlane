import type {
  AnswerCitation,
  AnswerProvider,
  AnswerProviderResult,
  AnswerRequest,
  AnswerResultItem,
  SearchTimeRange,
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

const LINKUP_SEARCH_URL = "https://api.linkup.so/v1/search";

interface LinkupAnswerOptions {
  apiKey: string;
  fetch?: AnswerFetchLike;
  validateUrl?: AnswerUrlValidator;
  now?: () => Date;
}

const rangeDays: Readonly<Record<SearchTimeRange, number>> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateRange(request: AnswerRequest, now: () => Date): Record<string, string> {
  if (request.timeRange === undefined) return {};
  const current = now();
  return {
    fromDate: isoDate(new Date(current.getTime() - rangeDays[request.timeRange] * 86_400_000)),
    toDate: isoDate(current),
  };
}

export class LinkupAnswerProvider implements AnswerProvider {
  readonly id = "linkup" as const;
  private readonly fetcher: AnswerFetchLike;
  private readonly validateUrl: AnswerUrlValidator;
  private readonly now: () => Date;

  constructor(private readonly options: LinkupAnswerOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultAnswerUrlValidator;
    this.now = options.now ?? (() => new Date());
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async answer(request: AnswerRequest, signal: AbortSignal): Promise<AnswerProviderResult> {
    const started = performance.now();
    const includeDomains = cleanDomains(request.domains);
    const excludeDomains = cleanDomains(request.excludeDomains);
    const raw = await answerProviderJson(
      this.fetcher,
      LINKUP_SEARCH_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          q: request.query,
          depth: "standard",
          outputType: "sourcedAnswer",
          includeInlineCitations: true,
          maxResults: request.maxResults,
          ...(includeDomains === undefined ? {} : { includeDomains }),
          ...(excludeDomains === undefined ? {} : { excludeDomains }),
          ...dateRange(request, this.now),
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || typeof (raw as { answer?: unknown }).answer !== "string") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_answer",
        "Linkup returned a malformed sourced answer response",
        true,
      );
    }
    const value = raw as Record<string, unknown>;
    const answer = value.answer as string;
    const sources = Array.isArray(value.sources) ? value.sources : [];
    const citations: AnswerCitation[] = sources.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const source = entry as Record<string, unknown>;
      if (typeof source.url !== "string") return [];
      return [
        {
          url: source.url,
          ...(typeof source.name === "string" ? { title: source.name } : {}),
          excerpts:
            typeof source.snippet === "string"
              ? [source.snippet]
              : typeof source.content === "string"
                ? [source.content]
                : [],
        },
      ];
    });
    const results: AnswerResultItem[] = sources.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const source = entry as Record<string, unknown>;
      if (typeof source.url !== "string") return [];
      return [
        {
          title: typeof source.name === "string" ? source.name : source.url,
          url: source.url,
          snippet:
            typeof source.snippet === "string"
              ? source.snippet
              : typeof source.content === "string"
                ? source.content
                : "",
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
