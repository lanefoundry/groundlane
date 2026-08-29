import type {
  ResearchCitation,
  ResearchProvider,
  ResearchProviderResult,
  ResearchRequest,
  SearchTimeRange,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { cleanDomains } from "../search/common.js";
import {
  defaultResearchUrlValidator,
  researchProviderJson,
  validateResearchCitations,
  type ResearchFetchLike,
  type ResearchUrlValidator,
} from "./common.js";

const YOU_RESEARCH_URL = "https://api.you.com/v1/research";

interface YouResearchOptions {
  apiKey?: string;
  fetch?: ResearchFetchLike;
  validateUrl?: ResearchUrlValidator;
}

const freshnessByRange: Readonly<Record<SearchTimeRange, string>> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

function sourceControl(request: ResearchRequest): Record<string, unknown> | undefined {
  const includeDomains = cleanDomains(request.domains);
  const excludeDomains = cleanDomains(request.excludeDomains);
  const control = {
    ...(includeDomains === undefined ? {} : { include_domains: includeDomains }),
    ...(excludeDomains === undefined ? {} : { exclude_domains: excludeDomains }),
    ...(request.timeRange === undefined ? {} : { freshness: freshnessByRange[request.timeRange] }),
    ...(request.country === undefined ? {} : { country: request.country.toUpperCase() }),
  };
  return Object.keys(control).length === 0 ? undefined : control;
}

function youResearchBody(request: ResearchRequest): Record<string, unknown> {
  const control = sourceControl(request);
  return {
    input: request.query,
    research_effort: request.effort,
    ...(control === undefined ? {} : { source_control: control }),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export class YouResearchProvider implements ResearchProvider {
  readonly id = "you" as const;
  private readonly fetcher: ResearchFetchLike;
  private readonly validateUrl: ResearchUrlValidator;

  constructor(private readonly options: YouResearchOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultResearchUrlValidator;
  }

  supports(request: ResearchRequest): boolean {
    const apiKey = this.options.apiKey?.trim();
    return apiKey !== undefined &&
      apiKey.length > 0 &&
      !(request.domains?.length && request.excludeDomains?.length);
  }

  async research(request: ResearchRequest, signal: AbortSignal): Promise<ResearchProviderResult> {
    const apiKey = this.options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_research",
        "You.com Research requires a configured API key",
        true,
      );
    }
    const started = performance.now();
    const raw = await researchProviderJson(
      this.fetcher,
      YOU_RESEARCH_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(youResearchBody(request)),
      },
      signal,
    );
    if (!raw || typeof raw !== "object") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_research",
        "You.com returned a malformed research response",
        true,
      );
    }
    const output = (raw as Record<string, unknown>).output;
    if (!output || typeof output !== "object") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_research",
        "You.com returned a malformed research response",
        true,
      );
    }
    const value = output as Record<string, unknown>;
    if (typeof value.content !== "string") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_research",
        "You.com returned a malformed research report",
        true,
      );
    }
    const sources = Array.isArray(value.sources) ? value.sources : [];
    const citations: ResearchCitation[] = sources.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const source = entry as Record<string, unknown>;
      if (typeof source.url !== "string") return [];
      return [
        {
          url: source.url,
          ...(typeof source.title === "string" ? { title: source.title } : {}),
          excerpts: stringArray(source.snippets),
        },
      ];
    });
    return {
      provider: this.id,
      report: value.content,
      citations: await validateResearchCitations(citations, this.validateUrl),
      durationMs: Math.round(performance.now() - started),
      warnings: [],
    };
  }
}
