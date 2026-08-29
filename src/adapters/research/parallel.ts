import type {
  ResearchCitation,
  ResearchProvider,
  ResearchProviderResult,
  ResearchRequest,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  defaultResearchUrlValidator,
  researchProviderJson,
  validateResearchCitations,
  type ResearchFetchLike,
  type ResearchUrlValidator,
} from "./common.js";

const PARALLEL_RESPONSES_URL = "https://api.parallel.ai/v1/responses";

interface ParallelResearchOptions {
  apiKey: string;
  fetch?: ResearchFetchLike;
  validateUrl?: ResearchUrlValidator;
}

const parallelEffort = {
  lite: "low",
  standard: "medium",
  deep: "high",
} as const;

function parallelResearchBody(request: ResearchRequest): Record<string, unknown> {
  return {
    model: "parallel",
    input: request.query,
    reasoning: { effort: parallelEffort[request.effort] },
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function outputText(raw: Record<string, unknown>): string | undefined {
  const direct = raw.output_text;
  if (typeof direct === "string") return direct;
  const output = raw.output;
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      const text = firstString(partRecord.text, partRecord.output_text);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function citationsFromAnnotations(raw: Record<string, unknown>, report: string): ResearchCitation[] {
  const output = raw.output;
  if (!Array.isArray(output)) return [];
  const citations: ResearchCitation[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const annotations = (part as Record<string, unknown>).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== "object") continue;
        const value = annotation as Record<string, unknown>;
        const type = value.type;
        const url = value.url;
        if (typeof url !== "string" || (type !== undefined && type !== "url_citation")) continue;
        const start = typeof value.start_index === "number" ? value.start_index : undefined;
        const end = typeof value.end_index === "number" ? value.end_index : undefined;
        const excerpts =
          start !== undefined && end !== undefined && start >= 0 && end > start
            ? [Array.from(report).slice(start, end).join("")]
            : [];
        citations.push({
          url,
          ...(typeof value.title === "string" ? { title: value.title } : {}),
          excerpts,
        });
      }
    }
  }
  return citations;
}

export class ParallelResearchProvider implements ResearchProvider {
  readonly id = "parallel" as const;
  private readonly fetcher: ResearchFetchLike;
  private readonly validateUrl: ResearchUrlValidator;

  constructor(private readonly options: ParallelResearchOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultResearchUrlValidator;
  }

  supports(request: ResearchRequest): boolean {
    return this.options.apiKey.trim().length > 0 &&
      request.domains === undefined &&
      request.excludeDomains === undefined &&
      request.timeRange === undefined &&
      request.country === undefined;
  }

  async research(request: ResearchRequest, signal: AbortSignal): Promise<ResearchProviderResult> {
    const started = performance.now();
    const raw = await researchProviderJson(
      this.fetcher,
      PARALLEL_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(parallelResearchBody(request)),
      },
      signal,
    );
    if (!raw || typeof raw !== "object") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_research",
        "Parallel returned a malformed research response",
        true,
      );
    }
    const value = raw as Record<string, unknown>;
    const report = outputText(value);
    if (report === undefined) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_research",
        "Parallel returned a malformed research report",
        true,
      );
    }
    return {
      provider: this.id,
      report,
      citations: await validateResearchCitations(citationsFromAnnotations(value, report), this.validateUrl),
      durationMs: Math.round(performance.now() - started),
      warnings: [],
    };
  }
}
