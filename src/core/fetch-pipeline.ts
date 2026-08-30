import type { BrowserBackend, FetchFormat, HttpFetcher, NormalizedDocument, RawDocument, ReaderBackend, RenderMode } from "./contracts.js";
import { detectChallenge } from "./browser-policy.js";
import { GroundlaneError } from "./errors.js";
import { normalizeDocument } from "./normalize-document.js";
import type { Deadline } from "./limits.js";
import type { SearchBudgetTracker } from "./search-budget.js";
import { canUseSourceAwareDocs, isLikelyDocumentationUrl, type SourceResolver } from "./source-aware-docs.js";

export interface FetchPipelineRequest { url: string; format: FetchFormat; render: RenderMode; selector?: string; waitFor?: string; maxBytes: number; maxOutputChars: number; maxRedirects: number; deadline: Deadline }
export interface FetchPipelineResult extends NormalizedDocument { raw: RawDocument; fallbackReason?: string }

export function validateFetchPipelineRequest(request: FetchPipelineRequest): void {
  if (!Number.isInteger(request.maxBytes) || request.maxBytes < 1 || !Number.isInteger(request.maxOutputChars) || request.maxOutputChars < 1 || !Number.isInteger(request.maxRedirects) || request.maxRedirects < 0 || request.maxRedirects > 20) {
    throw new GroundlaneError("INVALID_INPUT", "fetch", "Fetch limits are outside the allowed range");
  }
  if (request.selector !== undefined && (request.selector.trim().length === 0 || request.selector.length > 500)) throw new GroundlaneError("INVALID_INPUT", "selector", "Selector is outside the allowed range");
  if (request.waitFor !== undefined && (request.waitFor.trim().length === 0 || request.waitFor.length > 500)) throw new GroundlaneError("INVALID_INPUT", "selector", "Wait selector is outside the allowed range");
}

function fallbackReason(raw: RawDocument, normalized: NormalizedDocument, request: FetchPipelineRequest): string | undefined {
  const source = new TextDecoder().decode(raw.body);
  if (
    [403, 429, 503].includes(raw.status) &&
    detectChallenge(
      normalized.title ?? "",
      `${normalized.content.slice(0, 1_000)}\n${source.slice(0, 4_000)}`,
    )
  ) return "challenge_response";
  if (request.waitFor || request.selector) return undefined;
  if (raw.contentType.includes("html") && normalized.content.trim().length < 80 && /<script\b/i.test(source)) return "js_empty_document";
  return undefined;
}

export class FetchPipeline {
  constructor(
    private readonly http: HttpFetcher,
    private readonly browser: BrowserBackend,
    private readonly reader?: ReaderBackend,
    private readonly backendBudget?: SearchBudgetTracker,
    private readonly sourceResolver?: SourceResolver,
  ) {}
  async fetch(request: FetchPipelineRequest, signal?: AbortSignal): Promise<FetchPipelineResult> {
    validateFetchPipelineRequest(request);
    if (request.render === "always") return this.browserFetch(request, signal);
    const triedProactiveSource =
      this.sourceResolver?.resolveProactively !== undefined &&
      canUseSourceAwareDocs(request) &&
      isLikelyDocumentationUrl(request.url);
    const proactiveSource = await this.sourceResolver?.resolveProactively?.(request, signal);
    if (proactiveSource !== undefined) {
      return {
        ...normalizeDocument(proactiveSource.raw, request.format, request.maxOutputChars),
        raw: proactiveSource.raw,
        fallbackReason: proactiveSource.reason,
      };
    }
    let raw: RawDocument;
    try {
      raw = await this.http.fetch({ url: request.url, maxBytes: request.maxBytes, maxRedirects: request.maxRedirects, deadline: request.deadline }, signal);
    } catch (error) {
      if (error instanceof GroundlaneError && error.code === "OUTPUT_LIMIT") {
        const sourceAware = triedProactiveSource && this.sourceResolver?.resolveManifests !== undefined
          ? await this.sourceResolver.resolveManifests(request, signal)
          : await this.sourceResolver?.resolve(request, signal);
        if (sourceAware !== undefined) {
          return {
            ...normalizeDocument(sourceAware.raw, request.format, request.maxOutputChars),
            raw: sourceAware.raw,
            fallbackReason: sourceAware.reason,
          };
        }
      }
      if (request.render !== "auto" || !this.isRetryableRetrievalFailure(error)) throw error;
      if (this.canUseReader(request)) {
        try {
          return await this.readerFetch(request, signal, "http_upstream_failure");
        } catch (readerError) {
          if (!this.isRetryableRetrievalFailure(readerError)) throw readerError;
        }
      }
      return this.browserFetch(request, signal, "http_upstream_failure");
    }
    let normalized: NormalizedDocument;
    try { normalized = normalizeDocument(raw, request.format, request.maxOutputChars, request.selector); }
    catch (error) {
      if (request.render === "auto" && error instanceof GroundlaneError && error.stage === "selector") return this.browserFetch(request, signal, "selector_unmet");
      throw error;
    }
    const reason = fallbackReason(raw, normalized, request);
    if (request.render === "auto" && (reason || request.waitFor)) {
      const cause = reason ?? "wait_condition";
      if (this.canUseReader(request)) {
        try {
          return await this.readerFetch(request, signal, cause);
        } catch (error) {
          if (!this.isRetryableRetrievalFailure(error)) throw error;
        }
      }
      return this.browserFetch(request, signal, cause);
    }
    return { ...normalized, raw };
  }

  private canUseReader(request: FetchPipelineRequest): boolean {
    return (
      this.reader !== undefined &&
      request.format === "markdown" &&
      request.selector === undefined &&
      request.waitFor === undefined &&
      this.backendBudget?.remaining("jina") !== 0
    );
  }

  private isRetryableRetrievalFailure(error: unknown): boolean {
    return (
      error instanceof GroundlaneError &&
      ["PROVIDER_UNAVAILABLE", "RATE_LIMITED", "UPSTREAM_ERROR"].includes(error.code)
    );
  }

  private async readerFetch(
    request: FetchPipelineRequest,
    signal: AbortSignal | undefined,
    reason: string,
  ): Promise<FetchPipelineResult> {
    if (this.reader === undefined) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "reader",
        "Reader backend is disabled",
      );
    }
    const raw = await this.reader.fetch(
      {
        url: request.url,
        maxBytes: request.maxBytes,
        deadline: request.deadline,
      },
      signal,
    );
    this.backendBudget?.tryConsume("jina");
    return {
      ...normalizeDocument(raw, request.format, request.maxOutputChars),
      raw,
      fallbackReason: reason,
    };
  }
  private async browserFetch(request: FetchPipelineRequest, signal?: AbortSignal, reason?: string): Promise<FetchPipelineResult> {
    if (this.backendBudget?.remaining("browserless") === 0) {
      throw new GroundlaneError(
        "RATE_LIMITED",
        "browser-budget",
        "Browserless monthly unit budget is exhausted",
        true,
      );
    }
    const raw = await this.browser.fetch({ url: request.url, maxBytes: request.maxBytes, deadline: request.deadline, ...(request.selector ? { selector: request.selector } : {}), ...(request.waitFor ? { waitFor: request.waitFor } : {}) }, signal);
    this.backendBudget?.tryConsume("browserless");
    return { ...normalizeDocument(raw, request.format, request.maxOutputChars), raw, ...(reason ? { fallbackReason: reason } : {}) };
  }
}
