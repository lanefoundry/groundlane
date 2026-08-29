import type {
  ResearchCitation,
  ResearchEffort,
  ResearchProvider,
  ResearchProviderResult,
  ResearchRequest,
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

const LINKUP_RESEARCH_URL = "https://api.linkup.so/v1/research";
const POLL_INTERVAL_MS = 2_000;

interface LinkupResearchOptions {
  apiKey: string;
  fetch?: ResearchFetchLike;
  validateUrl?: ResearchUrlValidator;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const reasoningDepthByEffort: Readonly<Record<ResearchEffort, string>> = {
  lite: "S",
  standard: "M",
  deep: "L",
};

function linkupResearchBody(request: ResearchRequest): Record<string, unknown> {
  const includeDomains = cleanDomains(request.domains);
  const excludeDomains = cleanDomains(request.excludeDomains);
  return {
    q: request.query,
    outputType: "sourcedAnswer",
    mode: request.effort === "deep" ? "research" : "investigate",
    reasoningDepth: reasoningDepthByEffort[request.effort],
    ...(includeDomains === undefined ? {} : { includeDomains }),
    ...(excludeDomains === undefined ? {} : { excludeDomains }),
    ...(request.timeRange === undefined ? {} : { freshness: request.timeRange }),
    ...(request.country === undefined ? {} : { country: request.country.toUpperCase() }),
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new GroundlaneError("CANCELLED", "web_research", "Research request was cancelled"));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new GroundlaneError("CANCELLED", "web_research", "Research request was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function taskId(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_research",
      "Linkup returned a malformed research task",
      true,
    );
  }
  const id = stringValue((raw as Record<string, unknown>).id);
  if (id === undefined) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_research",
      "Linkup returned a malformed research task",
      true,
    );
  }
  return id;
}

function status(raw: Record<string, unknown>): string {
  return stringValue(raw.status) ?? "unknown";
}

function citationsFromOutput(output: Record<string, unknown>): ResearchCitation[] {
  const sources = Array.isArray(output.sources) ? output.sources : [];
  return sources.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Record<string, unknown>;
    const url = stringValue(source.url);
    if (url === undefined) return [];
    return [
      {
        url,
        ...(typeof source.name === "string" ? { title: source.name } : {}),
        excerpts: typeof source.snippet === "string" ? [source.snippet] : [],
      },
    ];
  });
}

export class LinkupResearchProvider implements ResearchProvider {
  readonly id = "linkup" as const;
  private readonly fetcher: ResearchFetchLike;
  private readonly validateUrl: ResearchUrlValidator;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: LinkupResearchOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultResearchUrlValidator;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? POLL_INTERVAL_MS, 1_000);
  }

  supports(request: ResearchRequest): boolean {
    return this.options.apiKey.trim().length > 0 &&
      !(request.domains?.length && request.excludeDomains?.length);
  }

  async research(request: ResearchRequest, signal: AbortSignal): Promise<ResearchProviderResult> {
    const started = performance.now();
    const createRaw = await researchProviderJson(
      this.fetcher,
      LINKUP_RESEARCH_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(linkupResearchBody(request)),
      },
      signal,
    );
    const id = taskId(createRaw);

    while (true) {
      const raw = await researchProviderJson(
        this.fetcher,
        `${LINKUP_RESEARCH_URL}/${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
          },
        },
        signal,
      );
      if (!raw || typeof raw !== "object") {
        throw new GroundlaneError(
          "UPSTREAM_ERROR",
          "web_research",
          "Linkup returned a malformed research result",
          true,
        );
      }
      const value = raw as Record<string, unknown>;
      const currentStatus = status(value);
      if (currentStatus === "failed") {
        throw new GroundlaneError(
          "UPSTREAM_ERROR",
          "web_research",
          "Linkup research task failed",
          true,
        );
      }
      if (currentStatus === "completed") {
        const output = value.output;
        if (!output || typeof output !== "object") {
          throw new GroundlaneError(
            "UPSTREAM_ERROR",
            "web_research",
            "Linkup returned a malformed research output",
            true,
          );
        }
        const outputValue = output as Record<string, unknown>;
        const report = stringValue(outputValue.answer);
        if (report === undefined) {
          throw new GroundlaneError(
            "UPSTREAM_ERROR",
            "web_research",
            "Linkup returned a malformed research report",
            true,
          );
        }
        return {
          provider: this.id,
          report,
          citations: await validateResearchCitations(citationsFromOutput(outputValue), this.validateUrl),
          durationMs: Math.round(performance.now() - started),
          warnings: [
            "linkup research is asynchronous upstream; Groundlane polled within the request deadline",
          ],
        };
      }
      await this.sleep(this.pollIntervalMs, signal);
    }
  }
}
