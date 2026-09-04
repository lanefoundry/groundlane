// ---------------------------------------------------------------------------
// Durable crawl job runtime (PRD 644 + PRD 722 idempotency part)
// ---------------------------------------------------------------------------
//
// Provider-neutral create/status/result/cancel over an in-memory
// deterministic store. Contract validators are reused from
// `src/core/async-lifecycle.ts`; the provider job ID lives only in
// `InternalCrawlJobState` and never in `PublicCrawlJob`.
//
// Port boundary: `CrawlJobStorePort` is the seam where a future durable
// backend (D1/DO/Workflow) replaces `InMemoryCrawlJobStore`;
// `CrawlProviderPort` is where a real crawl provider adapter plugs in.
// No live bindings, no network, no clock beyond injectable `now`.
//
// Accounting note: upstream crawl adapters report per-page `contentChars`.
// `totalBytes` accumulates those chars as a bounded proxy; byte-exact
// transfer accounting stays in the fetch pipeline. Result pagination uses
// Groundlane-generated `page:<offset>` cursors; the provider's own cursor
// is opaque internal resume state and is never exposed.

import {
  assertPublicHttpUrl,
  sanitizeUpstreamError,
  validateCrawlBudgets,
  validateCrawlCancelResult,
  validateCrawlJobNotExpired,
  validateCrawlJobOwnership,
} from "./async-lifecycle.js";
import type {
  BillingProvenance,
  CrawlBudgets,
  CrawlCancelResult,
  CrawlJobStatus,
  CrawlPartialResult,
  DurableCrawlJob,
  ProviderCancelAcknowledgment,
} from "./async-lifecycle.js";
import { GroundlaneError } from "./errors.js";

export const CRAWL_JOB_ID_PREFIX = "gl-crawl-";
export const MAX_CRAWL_JOBS = 1000;
export const MAX_CRAWL_PARTIALS = 1000;
export const MAX_CRAWL_PAGE_SIZE = 100;
export const DEFAULT_CRAWL_PAGE_SIZE = 20;

const CRAWL_TERMINAL_STATUSES: ReadonlySet<CrawlJobStatus> = new Set([
  "completed",
  "failed",
  "cancelled_by_caller",
  "cancelled_by_groundlane",
  "cancelled_by_upstream",
]);

const CRAWL_STATUS_ORDER: Record<CrawlJobStatus, number> = {
  created: 0,
  crawling: 1,
  completed: 2,
  failed: 2,
  cancelled_by_caller: 2,
  cancelled_by_groundlane: 2,
  cancelled_by_upstream: 2,
};

function validateCrawlStatusTransition(from: CrawlJobStatus, to: CrawlJobStatus): void {
  if (from === to) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      `Status is already "${from}"; no transition needed`,
    );
  }
  if (CRAWL_TERMINAL_STATUSES.has(from)) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      `Cannot transition from terminal status "${from}" to "${to}"`,
    );
  }
  const fromOrder = CRAWL_STATUS_ORDER[from];
  const toOrder = CRAWL_STATUS_ORDER[to];
  if (toOrder < fromOrder) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      `Non-monotonic crawl status transition: "${from}" -> "${to}"`,
    );
  }
}

export interface CrawlJobCaller {
  readonly ownerId: string;
  readonly credentialBinding: string;
}

export interface CreateCrawlJobInput {
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly seedUrl: string;
  readonly budgets: CrawlBudgets;
  readonly ttlSeconds: number;
  readonly providerId?: string;
  readonly idempotencyKey?: string;
  readonly now?: Date;
}

/** Public view: Groundlane-generated IDs and totals only. */
export interface PublicCrawlJob {
  readonly groundlaneJobId: string;
  readonly ownerId: string;
  readonly status: CrawlJobStatus;
  readonly expiresAt: string;
  readonly budgets: CrawlBudgets;
  readonly createdAt: string;
  readonly paginationCursor: string | null;
  readonly partialResults: readonly CrawlPartialResult[];
  readonly totalPages: number;
  readonly totalBytes: number;
  readonly totalOutputChars: number;
  readonly droppedUpstreamUrls: number;
  readonly callerCancelled: boolean;
  readonly groundlanePollingCancelled: boolean;
  readonly upstreamCancelRequested: boolean;
  readonly upstreamCancelled: boolean;
  readonly billingProvenance: BillingProvenance;
  readonly sanitizedError: string | null;
}

export interface CrawlJobCreateResult {
  readonly job: PublicCrawlJob;
  readonly reused: boolean;
}

export interface CrawlUpstreamCancelOutcome {
  readonly job: PublicCrawlJob;
  readonly cancelResult: CrawlCancelResult;
}

export interface CrawlResultPageOptions {
  readonly cursor?: string | null;
  readonly pageSize?: number;
}

export interface CrawlResultPage {
  readonly job: PublicCrawlJob;
  readonly items: readonly CrawlPartialResult[];
  readonly nextCursor: string | null;
}

export interface UpstreamCrawlPage {
  readonly url: string;
  readonly contentChars: number;
  readonly fetchedAt: string;
}

export interface UpstreamCrawlPageBatch {
  readonly pages: readonly UpstreamCrawlPage[];
  readonly nextCursor: string | null;
}

/** Provider-adapter port: Firecrawl/Tavily crawl adapters plug in here. */
export interface CrawlProviderPort {
  startCrawl(seedUrl: string): string;
  fetchUpstreamPages(providerJobId: string, cursor: string | null): UpstreamCrawlPageBatch;
  cancelUpstream(providerJobId: string): ProviderCancelAcknowledgment | null;
}

/** Internal-only state. Must never be returned from a public method. */
export interface InternalCrawlJobState {
  readonly groundlaneJobId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly providerId: string;
  readonly providerJobId: string;
  readonly status: CrawlJobStatus;
  readonly budgets: CrawlBudgets;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly partials: readonly CrawlPartialResult[];
  readonly providerCursor: string | null;
  readonly callerCancelled: boolean;
  readonly groundlanePollingCancelled: boolean;
  readonly upstreamCancelRequested: boolean;
  readonly upstreamAcknowledgment: ProviderCancelAcknowledgment | null;
  readonly droppedUpstreamUrls: number;
  readonly billedAt: string | null;
  readonly sanitizedError: string | null;
  readonly idempotencyKey: string | null;
}

/** Durable-backend port: D1/DO/Workflow snapshots plug in here. */
export interface CrawlJobStorePort {
  get(groundlaneJobId: string): InternalCrawlJobState | undefined;
  set(state: InternalCrawlJobState): void;
  getByIdempotencyKey(key: string): InternalCrawlJobState | undefined;
  size(): number;
}

export class InMemoryCrawlJobStore implements CrawlJobStorePort {
  private readonly jobs = new Map<string, InternalCrawlJobState>();
  private readonly byIdempotency = new Map<string, string>();

  get(groundlaneJobId: string): InternalCrawlJobState | undefined {
    return this.jobs.get(groundlaneJobId);
  }

  set(state: InternalCrawlJobState): void {
    this.jobs.set(state.groundlaneJobId, state);
    if (state.idempotencyKey !== null) {
      this.byIdempotency.set(state.idempotencyKey, state.groundlaneJobId);
    }
  }

  getByIdempotencyKey(key: string): InternalCrawlJobState | undefined {
    const jobId = this.byIdempotency.get(key);
    if (jobId === undefined) {
      return undefined;
    }
    return this.jobs.get(jobId);
  }

  size(): number {
    return this.jobs.size;
  }
}

export interface CrawlJobManagerOptions {
  readonly store?: CrawlJobStorePort;
  readonly provider?: CrawlProviderPort;
  readonly maxJobs?: number;
  readonly jobIdPrefix?: string;
}

function toDurableView(state: InternalCrawlJobState): DurableCrawlJob {
  const shared = {
    groundlaneJobId: state.groundlaneJobId,
    ownerId: state.ownerId,
    expiresAt: state.expiresAt,
    status: state.status,
    budgets: state.budgets,
    createdAt: state.createdAt,
    partialResults: state.partials,
  };
  if (state.partials.length === 0) {
    return shared;
  }
  return {
    ...shared,
    paginationCursor: `groundlane:pages:${String(state.partials.length)}`,
  };
}

function totalsOf(partials: readonly CrawlPartialResult[]): {
  totalPages: number;
  totalBytes: number;
  totalOutputChars: number;
} {
  let totalBytes = 0;
  let totalOutputChars = 0;
  for (const page of partials) {
    totalBytes += page.contentChars;
    totalOutputChars += page.contentChars;
  }
  return { totalPages: partials.length, totalBytes, totalOutputChars };
}

function toPublicCrawlJob(state: InternalCrawlJobState): PublicCrawlJob {
  const totals = totalsOf(state.partials);
  return {
    groundlaneJobId: state.groundlaneJobId,
    ownerId: state.ownerId,
    status: state.status,
    expiresAt: state.expiresAt,
    budgets: state.budgets,
    createdAt: state.createdAt,
    paginationCursor:
      state.partials.length === 0 ? null : `groundlane:pages:${String(state.partials.length)}`,
    partialResults: state.partials,
    totalPages: totals.totalPages,
    totalBytes: totals.totalBytes,
    totalOutputChars: totals.totalOutputChars,
    droppedUpstreamUrls: state.droppedUpstreamUrls,
    callerCancelled: state.callerCancelled,
    groundlanePollingCancelled: state.groundlanePollingCancelled,
    upstreamCancelRequested: state.upstreamCancelRequested,
    upstreamCancelled: state.upstreamAcknowledgment !== null,
    billingProvenance: {
      providerId: state.providerId,
      inputUnits: totals.totalPages,
      outputUnits: totals.totalOutputChars,
      billedAt: state.billedAt,
    },
    sanitizedError: state.sanitizedError,
  };
}

function parseResultCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null) {
    return 0;
  }
  const match = /^page:(\d+)$/.exec(cursor);
  if (match === null || match[1] === undefined) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      `Invalid result cursor "${cursor}"; expected "page:<offset>"`,
    );
  }
  const offset = Number(match[1]);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      `Invalid result cursor "${cursor}"; expected "page:<offset>"`,
    );
  }
  return offset;
}

/**
 * In-memory deterministic durable crawl job runtime (PRD 644 + PRD 722
 * idempotency part). All time flows through injectable `now`.
 */
export class CrawlJobManager {
  private readonly store: CrawlJobStorePort;
  private readonly provider: CrawlProviderPort | null;
  private readonly maxJobs: number;
  private readonly jobIdPrefix: string;
  private nextId = 1;

  constructor(options: CrawlJobManagerOptions = {}) {
    this.store = options.store ?? new InMemoryCrawlJobStore();
    this.provider = options.provider ?? null;
    this.maxJobs = options.maxJobs ?? MAX_CRAWL_JOBS;
    this.jobIdPrefix = options.jobIdPrefix ?? CRAWL_JOB_ID_PREFIX;
  }

  create(input: CreateCrawlJobInput): CrawlJobCreateResult {
    if (input.ownerId === "") {
      throw new GroundlaneError("INVALID_INPUT", "crawl-jobs", "ownerId is required");
    }
    if (input.credentialBinding === "") {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        "credentialBinding is required for crawl jobs",
      );
    }
    const seedUrl = assertPublicHttpUrl(input.seedUrl, "seedUrl");
    validateBudgets(input.budgets);
    if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        "ttlSeconds must be a positive number",
      );
    }
    const now = input.now ?? new Date();

    if (input.idempotencyKey !== undefined) {
      const key = buildCrawlIdempotencyKey(input.ownerId, input.idempotencyKey);
      const existing = this.store.getByIdempotencyKey(key);
      if (existing !== undefined) {
        return { job: toPublicCrawlJob(existing), reused: true };
      }
    }
    if (this.store.size() >= this.maxJobs) {
      throw new GroundlaneError(
        "CONCURRENCY_LIMIT",
        "crawl-jobs",
        "The crawl job store is full",
        true,
      );
    }

    const groundlaneJobId = `${this.jobIdPrefix}${String(this.nextId).padStart(6, "0")}`;
    this.nextId += 1;
    // Provider task starts only after all validation above (PRD 722: no
    // billable work before commit).
    const providerJobId =
      this.provider === null ? `deferred:${groundlaneJobId}` : this.provider.startCrawl(seedUrl);
    const state: InternalCrawlJobState = {
      groundlaneJobId,
      ownerId: input.ownerId,
      credentialBinding: input.credentialBinding,
      providerId: input.providerId ?? "crawl",
      providerJobId,
      status: "created",
      budgets: input.budgets,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
      partials: [],
      providerCursor: null,
      callerCancelled: false,
      groundlanePollingCancelled: false,
      upstreamCancelRequested: false,
      upstreamAcknowledgment: null,
      droppedUpstreamUrls: 0,
      billedAt: null,
      sanitizedError: null,
      idempotencyKey:
        input.idempotencyKey === undefined
          ? null
          : buildCrawlIdempotencyKey(input.ownerId, input.idempotencyKey),
    };
    // Contract conformance: the public view must satisfy the durable crawl
    // validators and must not leak the provider job ID.
    const view = toDurableView(state);
    validateCrawlJobOwnership(view, input.ownerId);
    validateCrawlJobNotExpired(view, now);
    this.store.set(state);
    return { job: toPublicCrawlJob(state), reused: false };
  }

  status(
    groundlaneJobId: string,
    caller: CrawlJobCaller,
    now: Date = new Date(),
  ): PublicCrawlJob {
    return toPublicCrawlJob(this.resolve(groundlaneJobId, caller, now));
  }

  /**
   * Paginated read over accumulated partial results. Read-only: paging
   * through results never mutates budgets, totals, or lifecycle.
   */
  result(
    groundlaneJobId: string,
    caller: CrawlJobCaller,
    options: CrawlResultPageOptions = {},
    now: Date = new Date(),
  ): CrawlResultPage {
    const state = this.resolve(groundlaneJobId, caller, now);
    const pageSize = options.pageSize ?? DEFAULT_CRAWL_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_CRAWL_PAGE_SIZE) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        `pageSize must be an integer between 1 and ${String(MAX_CRAWL_PAGE_SIZE)}`,
      );
    }
    const offset = parseResultCursor(options.cursor ?? null);
    const items = state.partials.slice(offset, offset + pageSize);
    const end = offset + pageSize;
    return {
      job: toPublicCrawlJob(state),
      items,
      nextCursor: end < state.partials.length ? `page:${String(end)}` : null,
    };
  }

  /**
   * Pulls one upstream batch into the job. Enforces total page/byte/output
   * budgets; on breach the job fails with a sanitized error while already
   * ingested partials are preserved.
   */
  ingestUpstream(
    groundlaneJobId: string,
    caller: CrawlJobCaller,
    now: Date = new Date(),
  ): PublicCrawlJob {
    const state = this.resolve(groundlaneJobId, caller, now);
    if (CRAWL_TERMINAL_STATUSES.has(state.status)) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        `Cannot transition from terminal status "${state.status}"`,
      );
    }
    let batch: UpstreamCrawlPageBatch;
    try {
      if (this.provider === null) {
        batch = { pages: [], nextCursor: null };
      } else {
        batch = this.provider.fetchUpstreamPages(state.providerJobId, state.providerCursor);
      }
    } catch (error) {
      return this.fail(state, error, now);
    }

    const kept: CrawlPartialResult[] = [];
    let dropped = state.droppedUpstreamUrls;
    for (const page of batch.pages) {
      try {
        const safeUrl = assertPublicHttpUrl(page.url, "upstream page url");
        if (!Number.isInteger(page.contentChars) || page.contentChars < 0) {
          dropped += 1;
          continue;
        }
        kept.push({ url: safeUrl, contentChars: page.contentChars, fetchedAt: page.fetchedAt });
      } catch {
        // Provider-returned URLs are untrusted: drop the candidate and keep
        // crawling instead of failing the whole job on one bad URL.
        dropped += 1;
      }
    }

    const merged = [...state.partials, ...kept];
    if (merged.length > MAX_CRAWL_PARTIALS) {
      // Over-cap batches are never retained: keeping them would defeat the
      // bound. Only pre-breach partials survive alongside the failure.
      return this.fail(
        { ...state, droppedUpstreamUrls: dropped },
        new Error(
          `Partial result cap exceeded: ${String(merged.length)} > ${String(MAX_CRAWL_PARTIALS)}`,
        ),
        now,
        "OUTPUT_LIMIT",
      );
    }
    const totals = totalsOf(merged);
    try {
      validateCrawlBudgets(state.budgets, totals.totalPages, totals.totalBytes, totals.totalOutputChars);
    } catch (error) {
      return this.fail(
        { ...state, droppedUpstreamUrls: dropped },
        error,
        now,
        "OUTPUT_LIMIT",
      );
    }

    // Empty drained batch completes the job; otherwise it is (still) crawling.
    const drained = batch.pages.length === 0 && batch.nextCursor === null;
    const status: CrawlJobStatus = drained ? "completed" : "crawling";
    if (state.status === status) {
      const next: InternalCrawlJobState = {
        ...state,
        partials: merged,
        providerCursor: batch.nextCursor,
        droppedUpstreamUrls: dropped,
        billedAt: drained ? now.toISOString() : state.billedAt,
      };
      this.store.set(next);
      return toPublicCrawlJob(next);
    }
    validateCrawlStatusTransition(state.status, status);
    const next: InternalCrawlJobState = {
      ...state,
      status,
      partials: merged,
      providerCursor: batch.nextCursor,
      droppedUpstreamUrls: dropped,
      billedAt: drained ? now.toISOString() : state.billedAt,
    };
    this.store.set(next);
    return toPublicCrawlJob(next);
  }

  /** Cancel kind 1: the caller stops waiting. Needs no provider ack. */
  cancelCallerWait(
    groundlaneJobId: string,
    caller: CrawlJobCaller,
    now: Date = new Date(),
  ): PublicCrawlJob {
    const state = this.resolve(groundlaneJobId, caller, now);
    validateCrawlStatusTransition(state.status, "cancelled_by_caller");
    const next: InternalCrawlJobState = { ...state, status: "cancelled_by_caller", callerCancelled: true };
    this.store.set(next);
    return toPublicCrawlJob(next);
  }

  /** Cancel kind 2: Groundlane stops polling/dispatch. Needs no provider ack. */
  cancelGroundlanePolling(
    groundlaneJobId: string,
    caller: CrawlJobCaller,
    now: Date = new Date(),
  ): PublicCrawlJob {
    const state = this.resolve(groundlaneJobId, caller, now);
    validateCrawlStatusTransition(state.status, "cancelled_by_groundlane");
    const next: InternalCrawlJobState = {
      ...state,
      status: "cancelled_by_groundlane",
      groundlanePollingCancelled: true,
    };
    this.store.set(next);
    return toPublicCrawlJob(next);
  }

  /**
   * Cancel kind 3: request a real upstream cancel. Without provider
   * acknowledgment the job keeps its status and only
   * `upstreamCancelRequested` is recorded.
   */
  requestUpstreamCancel(
    groundlaneJobId: string,
    caller: CrawlJobCaller,
    now: Date = new Date(),
  ): CrawlUpstreamCancelOutcome {
    const state = this.resolve(groundlaneJobId, caller, now);
    if (CRAWL_TERMINAL_STATUSES.has(state.status)) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        `Cannot transition from terminal status "${state.status}"`,
      );
    }
    const acknowledgment =
      this.provider === null ? null : this.provider.cancelUpstream(state.providerJobId);
    if (acknowledgment === null) {
      const next: InternalCrawlJobState = { ...state, upstreamCancelRequested: true };
      this.store.set(next);
      const cancelResult: CrawlCancelResult = {
        callerCancelled: next.callerCancelled,
        groundlanePollingCancelled: next.groundlanePollingCancelled,
        upstreamCancelled: false,
      };
      validateCrawlCancelResult(cancelResult);
      return { job: toPublicCrawlJob(next), cancelResult };
    }
    validateCrawlStatusTransition(state.status, "cancelled_by_upstream");
    const next: InternalCrawlJobState = {
      ...state,
      status: "cancelled_by_upstream",
      upstreamCancelRequested: true,
      upstreamAcknowledgment: acknowledgment,
    };
    this.store.set(next);
    const cancelResult: CrawlCancelResult = {
      callerCancelled: next.callerCancelled,
      groundlanePollingCancelled: next.groundlanePollingCancelled,
      upstreamCancelled: true,
      providerAcknowledgment: acknowledgment,
    };
    validateCrawlCancelResult(cancelResult);
    return { job: toPublicCrawlJob(next), cancelResult };
  }

  private fail(
    state: InternalCrawlJobState,
    error: unknown,
    now: Date,
    code: "UPSTREAM_ERROR" | "OUTPUT_LIMIT" = "UPSTREAM_ERROR",
  ): PublicCrawlJob {
    const message =
      code === "UPSTREAM_ERROR"
        ? `Upstream crawl fetch failed: ${sanitizeUpstreamError(error, "crawl-jobs")}`
        : sanitizeUpstreamError(error, "crawl-jobs");
    const failed: InternalCrawlJobState = {
      ...state,
      status: "failed",
      sanitizedError: message,
      billedAt: state.billedAt ?? now.toISOString(),
    };
    this.store.set(failed);
    throw new GroundlaneError(code, "crawl-jobs", message, code === "UPSTREAM_ERROR");
  }

  private resolve(
    groundlaneJobId: string,
    caller: CrawlJobCaller,
    now: Date,
  ): InternalCrawlJobState {
    const state = this.store.get(groundlaneJobId);
    if (state === undefined) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        `Unknown crawl job "${groundlaneJobId}"`,
      );
    }
    const view = toDurableView(state);
    try {
      validateCrawlJobOwnership(view, caller.ownerId);
    } catch (error) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        error instanceof Error ? error.message : "Owner mismatch",
      );
    }
    if (state.credentialBinding !== caller.credentialBinding) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "crawl-jobs",
        "Credential binding mismatch: caller credential does not match this crawl job",
      );
    }
    try {
      validateCrawlJobNotExpired(view, now);
    } catch (error) {
      throw new GroundlaneError(
        "DEADLINE_EXCEEDED",
        "crawl-jobs",
        error instanceof Error ? error.message : "Crawl job has expired",
      );
    }
    return state;
  }
}

export function buildCrawlIdempotencyKey(ownerId: string, idempotencyKey: string): string {
  if (ownerId === "") {
    throw new GroundlaneError("INVALID_INPUT", "crawl-jobs", "ownerId is required");
  }
  if (idempotencyKey === "") {
    throw new GroundlaneError("INVALID_INPUT", "crawl-jobs", "idempotencyKey must be non-empty");
  }
  return `${ownerId}:${idempotencyKey}`;
}

function validateBudgets(budgets: CrawlBudgets): void {
  if (!Number.isInteger(budgets.maxPages) || budgets.maxPages < 1) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      "budgets.maxPages must be a positive integer",
    );
  }
  if (!Number.isInteger(budgets.maxBytes) || budgets.maxBytes < 1) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      "budgets.maxBytes must be a positive integer",
    );
  }
  if (!Number.isInteger(budgets.maxOutputChars) || budgets.maxOutputChars < 1) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "crawl-jobs",
      "budgets.maxOutputChars must be a positive integer",
    );
  }
}
