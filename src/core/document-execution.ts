// ---------------------------------------------------------------------------
// Document execution lifecycle contracts (PRD 685, 686, 687, 688)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { GroundlaneError } from "./errors.js";

// -- PRD 685: Dual-track execution -----------------------------------------

export type ExecutionTrack = "sync" | "async";

export type ExecutionMode = "sync" | "async";

export interface ExecutionLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxTimeMs: number;
  readonly maxMemoryMb: number;
  readonly allowedEngines: readonly string[];
}

/**
 * Base result type shared by both sync and async execution tracks.
 * PRD 685 requires both tracks produce the same schema family — there is
 * no separate async-only document schema.
 */
export interface ExecutionResult {
  readonly track: ExecutionTrack;
  readonly contentHash: string;
  readonly projections: readonly string[];
  readonly provenance: ResultProvenance;
  readonly cachedAt: string | null;
  readonly error: ExecutionError | null;
}

export interface ResultProvenance {
  readonly engine: string;
  readonly durationMs: number;
  readonly sourceId: string;
}

export interface ExecutionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ExecutionRequest {
  readonly inputBytes: number;
  readonly inputPages: number;
  readonly estimatedTimeMs: number;
  readonly estimatedMemoryMb: number;
  readonly engine: string;
  readonly mode: ExecutionMode;
}

/**
 * Selects the appropriate execution track based on whether the request
 * fits within synchronous limits.
 */
export function selectExecutionTrack(
  request: ExecutionRequest,
  limits: ExecutionLimits,
): ExecutionTrack {
  if (
    request.inputBytes <= limits.maxBytes &&
    request.inputPages <= limits.maxPages &&
    request.estimatedTimeMs <= limits.maxTimeMs &&
    request.estimatedMemoryMb <= limits.maxMemoryMb &&
    limits.allowedEngines.includes(request.engine)
  ) {
    return "sync";
  }
  return "async";
}

// -- PRD 686: Sync guard and async-required error --------------------------

export interface AsyncRequiredError {
  readonly code: "ASYNC_REQUIRED";
  readonly reason: string;
  readonly suggestedMode: "async";
}

export interface ArtifactRef {
  readonly refId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly expiresAt: string;
}

/**
 * Validates that a sync request genuinely fits within sync limits.
 * PRD 686: sync request must never silently convert to durable job.
 */
export function validateSyncExecutionGuard(
  request: ExecutionRequest,
  limits: ExecutionLimits,
): AsyncRequiredError | null {
  if (request.mode === "sync") {
    if (request.inputBytes > limits.maxBytes) {
      return {
        code: "ASYNC_REQUIRED",
        reason: `Input size ${String(request.inputBytes)} bytes exceeds sync limit ${String(limits.maxBytes)} bytes`,
        suggestedMode: "async",
      };
    }
    if (request.inputPages > limits.maxPages) {
      return {
        code: "ASYNC_REQUIRED",
        reason: `Input pages ${String(request.inputPages)} exceeds sync limit ${String(limits.maxPages)}`,
        suggestedMode: "async",
      };
    }
    if (request.estimatedTimeMs > limits.maxTimeMs) {
      return {
        code: "ASYNC_REQUIRED",
        reason: `Estimated time ${String(request.estimatedTimeMs)}ms exceeds sync limit ${String(limits.maxTimeMs)}ms`,
        suggestedMode: "async",
      };
    }
    if (!limits.allowedEngines.includes(request.engine)) {
      return {
        code: "ASYNC_REQUIRED",
        reason: `Engine "${request.engine}" is async-only`,
        suggestedMode: "async",
      };
    }
  }
  return null;
}

/**
 * PRD 686: execution=auto is not allowed in v1. Explicit opt-in required.
 */
export function validateExecutionMode(mode: string): void {
  if (mode === "auto") {
    throw new Error(
      'Execution mode "auto" is not supported in v1; use explicit "sync" or "async"',
    );
  }
  if (mode !== "sync" && mode !== "async") {
    throw new Error(
      `Unknown execution mode "${mode}"; expected "sync" or "async"`,
    );
  }
}

/**
 * PRD 686: Oversized output returns ArtifactRef but must not masquerade
 * as job creation or reset end-to-end deadline.
 */
export function handleOversizedOutput(
  contentHash: string,
  byteSize: number,
  expiresAt: string,
): { artifactRef: ArtifactRef; jobCreated: false } {
  return {
    artifactRef: {
      refId: createHash("sha256")
        .update(contentHash + String(byteSize))
        .digest("hex")
        .slice(0, 32),
      contentHash,
      byteSize,
      expiresAt,
    },
    jobCreated: false,
  };
}

// -- PRD 687: Async document job lifecycle ---------------------------------

export type AsyncDocumentJobStatus =
  | "created"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "deleted"
  | "expired";

export interface SourceSnapshot {
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export interface CredentialBinding {
  readonly credentialId: string;
  readonly boundAt: string;
}

export interface JobBillingProvenance {
  readonly providerId: string;
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly billedAt: string | null;
}

export interface AsyncDocumentJob {
  readonly jobId: string;
  readonly ownerId: string;
  readonly sourceSnapshot: SourceSnapshot;
  readonly status: AsyncDocumentJobStatus;
  readonly credentialBinding: CredentialBinding;
  readonly billingProvenance: JobBillingProvenance;
  readonly resultRef: ArtifactRef | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type CancelScope =
  | "caller_wait"
  | "groundlane_dispatch"
  | "upstream_cancel";

export interface McpTasksSupportEntry {
  readonly clientId: string;
  readonly supportsAsyncTasks: boolean;
  readonly supportsNotifications: boolean;
  readonly supportsPolling: boolean;
}

export interface McpTasksSupportMatrix {
  readonly entries: readonly McpTasksSupportEntry[];
}

const DOC_STATUS_ORDER: Record<AsyncDocumentJobStatus, number> = {
  created: 0,
  pending: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
  deleted: 3,
  expired: 3,
};

const DOC_TERMINAL_STATUSES = new Set<AsyncDocumentJobStatus>([
  "completed",
  "failed",
  "cancelled",
  "deleted",
  "expired",
]);

/**
 * PRD 687: Status transitions must be monotonic — status can only move
 * forward.  Terminal states cannot be left.
 */
export function validateDocumentJobStatusTransition(
  from: AsyncDocumentJobStatus,
  to: AsyncDocumentJobStatus,
): void {
  if (from === to) {
    throw new Error(
      `Status is already "${from}"; no transition needed`,
    );
  }
  if (DOC_TERMINAL_STATUSES.has(from)) {
    throw new Error(
      `Cannot transition from terminal status "${from}" to "${to}"`,
    );
  }
  const fromOrder = DOC_STATUS_ORDER[from];
  const toOrder = DOC_STATUS_ORDER[to];
  if (toOrder < fromOrder) {
    throw new Error(
      `Non-monotonic status transition: "${from}" (${String(fromOrder)}) -> "${to}" (${String(toOrder)})`,
    );
  }
}

/**
 * PRD 687: Effective snapshot expiry = min(source expiry, job expiry, policy cap).
 */
export function resolveSnapshotExpiry(
  sourceExpiresAt: string,
  jobExpiresAt: string,
  policyCapExpiresAt: string,
): string {
  const sourceMs = new Date(sourceExpiresAt).getTime();
  const jobMs = new Date(jobExpiresAt).getTime();
  const policyMs = new Date(policyCapExpiresAt).getTime();
  const minMs = Math.min(sourceMs, jobMs, policyMs);
  return new Date(minMs).toISOString();
}

/**
 * PRD 687: Idempotent job creation — same input produces same job ID.
 */
export function computeIdempotentJobId(
  ownerId: string,
  contentHash: string,
  engine: string,
): string {
  return createHash("sha256")
    .update(`${ownerId}:${contentHash}:${engine}`)
    .digest("hex");
}

/**
 * PRD 687: Source delete immediately revokes snapshot.
 */
export function revokeSnapshot(job: AsyncDocumentJob): AsyncDocumentJob {
  const revokedSnapshot: SourceSnapshot = {
    ...job.sourceSnapshot,
    revoked: true,
  };
  const terminalStatus: AsyncDocumentJobStatus =
    DOC_TERMINAL_STATUSES.has(job.status) ? job.status : "cancelled";
  return {
    ...job,
    sourceSnapshot: revokedSnapshot,
    status: terminalStatus,
  };
}

/**
 * PRD 687: Three cancel scopes are independent.
 */
export function validateCancelScope(scope: string): CancelScope {
  const valid: CancelScope[] = [
    "caller_wait",
    "groundlane_dispatch",
    "upstream_cancel",
  ];
  if (!valid.includes(scope as CancelScope)) {
    throw new Error(
      `Unknown cancel scope "${scope}"; expected one of: ${valid.join(", ")}`,
    );
  }
  return scope as CancelScope;
}

const KNOWN_MCP_CLIENTS = new Set(["claude", "codex", "cursor"]);

export function validateMcpTasksMatrix(matrix: McpTasksSupportMatrix): void {
  if (matrix.entries.length === 0) {
    throw new Error("MCP Tasks support matrix must contain at least one entry");
  }
  for (const entry of matrix.entries) {
    if (!KNOWN_MCP_CLIENTS.has(entry.clientId)) {
      throw new Error(
        `Unknown MCP client "${entry.clientId}"; known clients: ${[...KNOWN_MCP_CLIENTS].join(", ")}`,
      );
    }
  }
}

// -- PRD 688: Async deadline fixtures --------------------------------------

export interface DeadlineSet {
  readonly syncRequestDeadlineMs: number;
  readonly createRequestDeadlineMs: number;
  readonly pollWaitDeadlineMs: number;
  readonly jobAbsoluteDeadlineMs: number;
  readonly perAttemptDeadlineMs: number;
  readonly totalExecutionBudgetMs: number;
}

export interface DeadlinePolicy {
  /** PRD 688: Disconnect doesn't cancel running job. */
  readonly disconnectCancelsJob: false;
  /** PRD 688: Retry/fallback must not reset total budget. */
  readonly retryResetsBudget: false;
}

export const DEFAULT_DEADLINE_POLICY: DeadlinePolicy = {
  disconnectCancelsJob: false,
  retryResetsBudget: false,
};

/**
 * PRD 688: All deadline values must be positive.
 */
export function validateDeadlines(deadlines: DeadlineSet): void {
  const fields: (keyof DeadlineSet)[] = [
    "syncRequestDeadlineMs",
    "createRequestDeadlineMs",
    "pollWaitDeadlineMs",
    "jobAbsoluteDeadlineMs",
    "perAttemptDeadlineMs",
    "totalExecutionBudgetMs",
  ];
  for (const field of fields) {
    if (deadlines[field] <= 0) {
      throw new Error(
        `Deadline "${field}" must be positive; got ${String(deadlines[field])}`,
      );
    }
  }
}

/**
 * PRD 688: Track remaining budget after retry — never reset.
 */
export function computeRemainingBudget(
  totalBudgetMs: number,
  elapsedMs: number,
): number {
  const remaining = totalBudgetMs - elapsedMs;
  if (remaining <= 0) {
    throw new Error(
      `Total execution budget exhausted: elapsed ${String(elapsedMs)}ms >= budget ${String(totalBudgetMs)}ms`,
    );
  }
  return remaining;
}

// ---------------------------------------------------------------------------
// PRD 664: Sync/async dual-track execution runtime (in-memory port)
// ---------------------------------------------------------------------------
//
// Deterministic in-memory runtime behind the validators above. No live
// provider, D1/DO/Workflow/Queue/R2 bindings, or network. `DocumentJobStorePort`
// is the explicit durable seam; `DocumentProviderPort` is the upstream-cancel
// seam. Concepts mirror src/core/async-lifecycle.ts (ownership, TTL, three
// independent cancels with ack gating, idempotency, sanitized errors) but are
// re-implemented here for the document job shape; async-lifecycle.ts itself is
// never modified.
//
// Tracks share one schema family: sync and async both produce ExecutionResult.
// Sync never silently becomes async: over-limit/async-only sync requests throw
// ASYNC_REQUIRED and create no job. execution=auto requires explicit opt-in.

export const MAX_DOCUMENT_JOBS = 500;
export const MAX_DOCUMENT_OWNER_CHARS = 256;
export const MAX_DOCUMENT_HASH_CHARS = 256;
export const MAX_DOCUMENT_ENGINE_CHARS = 128;

/** Engines that can never complete within sync limits. */
export const ASYNC_ONLY_ENGINES: readonly string[] = [
  "ocr",
  "vlm",
  "audio",
  "ocr-vlm",
  "layout-vlm",
  "transcription",
];

export function requiresExplicitAsyncJob(engine: string): boolean {
  return ASYNC_ONLY_ENGINES.includes(engine);
}

function executionRuntimeError(message: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "document-execution", message);
}

/**
 * Resolves an execution mode string. "auto" is rejected unless the caller
 * passes explicit opt-in (allowAuto=true). "sync"/"async" pass through.
 */
export function resolveExecutionModeWithOptIn(
  mode: string,
  allowAuto: boolean,
): ExecutionMode | "auto" {
  if (mode === "auto") {
    if (!allowAuto) {
      throw executionRuntimeError(
        'Execution mode "auto" requires explicit opt-in; pass allowAuto=true or use explicit "sync"/"async"',
      );
    }
    return "auto";
  }
  validateExecutionMode(mode);
  return mode as ExecutionMode;
}

/** Routes an auto request to a track; requires explicit opt-in. */
export function routeAutoExecution(
  request: ExecutionRequest,
  limits: ExecutionLimits,
  allowAuto: boolean,
): ExecutionTrack {
  if (!allowAuto) {
    throw executionRuntimeError(
      'Execution mode "auto" requires explicit opt-in; pass allowAuto=true',
    );
  }
  return selectExecutionTrack(request, limits);
}

/**
 * Throws ASYNC_REQUIRED (sanitized, no payload) when a sync request cannot
 * run synchronously. Never creates a job.
 */
export function assertSyncExecutable(
  request: ExecutionRequest,
  limits: ExecutionLimits,
): void {
  if (request.mode !== "sync") {
    throw executionRuntimeError(`Sync execution requires mode "sync", got "${request.mode}"`);
  }
  const guard = validateSyncExecutionGuard(request, limits);
  if (guard !== null) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "document-execution",
      `ASYNC_REQUIRED: ${guard.reason}; use an explicit async document job`,
    );
  }
  if (requiresExplicitAsyncJob(request.engine)) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "document-execution",
      `ASYNC_REQUIRED: Engine "${request.engine}" is async-only; use an explicit async document job`,
    );
  }
}

export interface SyncExecutionContext {
  readonly contentHash: string;
  readonly sourceId: string;
  readonly projections?: readonly string[];
}

function assertBoundedId(value: string, field: string, max: number): void {
  if (value.length === 0 || value.length > max) {
    throw executionRuntimeError(`${field} must be non-empty within ${String(max)} characters`);
  }
}

export interface DocumentProviderCancelAck {
  readonly providerResponseCode: number;
  readonly acknowledgedAt: string;
}

export interface InternalDocumentJobState {
  readonly job: AsyncDocumentJob;
  readonly callerWaitCancelled: boolean;
  readonly groundlaneDispatchCancelled: boolean;
  readonly upstreamRequested: boolean;
  readonly upstreamAck: DocumentProviderCancelAck | null;
}

export interface DocumentJobStorePort {
  get(jobId: string): InternalDocumentJobState | undefined;
  set(state: InternalDocumentJobState): void;
  size(): number;
}

export class InMemoryDocumentJobStore implements DocumentJobStorePort {
  private readonly jobs = new Map<string, InternalDocumentJobState>();

  get(jobId: string): InternalDocumentJobState | undefined {
    return this.jobs.get(jobId);
  }

  set(state: InternalDocumentJobState): void {
    this.jobs.set(state.job.jobId, state);
  }

  size(): number {
    return this.jobs.size;
  }
}

export interface CreateDocumentJobInput {
  readonly ownerId: string;
  readonly contentHash: string;
  readonly engine: string;
  readonly credentialBinding: CredentialBinding;
  readonly sourceSnapshot: SourceSnapshot;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly policyCapExpiresAt?: string;
  readonly now?: Date;
}

export interface CreateDocumentJobResult {
  readonly job: AsyncDocumentJob;
  readonly reused: boolean;
}

export interface DocumentCancelOutcome {
  readonly job: AsyncDocumentJob;
  readonly callerWaitCancelled: boolean;
  readonly groundlaneDispatchCancelled: boolean;
  readonly upstreamRequested: boolean;
  readonly upstreamCancelled: boolean;
  readonly providerAck: DocumentProviderCancelAck | null;
}

export interface DocumentExecutionManagerOptions {
  readonly store?: DocumentJobStorePort;
  readonly maxJobs?: number;
}

/**
 * In-memory dual-track document execution manager. All time flows through
 * injectable Date params for determinism. Disconnect never cancels; retry
 * never resets the total budget; upstream cancel without acknowledgment never
 * reports upstreamCancelled=true.
 */
export class DocumentExecutionManager {
  private readonly store: DocumentJobStorePort;
  private readonly maxJobs: number;

  constructor(options: DocumentExecutionManagerOptions = {}) {
    this.store = options.store ?? new InMemoryDocumentJobStore();
    this.maxJobs = options.maxJobs ?? MAX_DOCUMENT_JOBS;
  }

  /** Bounded sync execution: throws ASYNC_REQUIRED instead of creating a job. */
  executeSync(
    request: ExecutionRequest,
    limits: ExecutionLimits,
    context: SyncExecutionContext,
  ): ExecutionResult {
    assertSyncExecutable(request, limits);
    assertBoundedId(context.contentHash, "contentHash", MAX_DOCUMENT_HASH_CHARS);
    assertBoundedId(context.sourceId, "sourceId", MAX_DOCUMENT_OWNER_CHARS);
    return {
      track: "sync",
      contentHash: context.contentHash,
      projections: context.projections === undefined ? ["markdown"] : [...context.projections],
      provenance: { engine: request.engine, durationMs: 0, sourceId: context.sourceId },
      cachedAt: null,
      error: null,
    };
  }

  /** Builds the async-track result with the same ExecutionResult schema. */
  buildAsyncResult(
    job: AsyncDocumentJob,
    projections: readonly string[],
  ): ExecutionResult {
    return {
      track: "async",
      contentHash: job.sourceSnapshot.contentHash,
      projections: [...projections],
      provenance: {
        engine: job.billingProvenance.providerId,
        durationMs: 0,
        sourceId: job.jobId,
      },
      cachedAt: null,
      error: null,
    };
  }

  /** Idempotent create: same owner+hash+engine reuses the same jobId. */
  create(input: CreateDocumentJobInput): CreateDocumentJobResult {
    assertBoundedId(input.ownerId, "ownerId", MAX_DOCUMENT_OWNER_CHARS);
    assertBoundedId(input.contentHash, "contentHash", MAX_DOCUMENT_HASH_CHARS);
    assertBoundedId(input.engine, "engine", MAX_DOCUMENT_ENGINE_CHARS);
    if (!input.credentialBinding.credentialId) {
      throw executionRuntimeError("credentialBinding.credentialId is required");
    }
    const jobId = computeIdempotentJobId(input.ownerId, input.contentHash, input.engine);
    const existing = this.store.get(jobId);
    if (existing !== undefined) {
      if (existing.job.ownerId !== input.ownerId) {
        throw executionRuntimeError("Owner mismatch: caller does not own this document job");
      }
      return { job: existing.job, reused: true };
    }
    if (this.store.size() >= this.maxJobs) {
      throw new GroundlaneError(
        "CONCURRENCY_LIMIT",
        "document-execution",
        "The document job store is full",
        true,
      );
    }
    const now = input.now ?? new Date();
    if (isNaN(now.getTime())) throw executionRuntimeError("Invalid creation time");
    if (new Date(input.expiresAt).getTime() <= now.getTime()) {
      throw executionRuntimeError("Document job expiresAt must be in the future");
    }
    const policyCap = input.policyCapExpiresAt ?? input.expiresAt;
    const snapshotExpiresAt = resolveSnapshotExpiry(
      input.sourceSnapshot.expiresAt,
      input.expiresAt,
      policyCap,
    );
    const job: AsyncDocumentJob = {
      jobId,
      ownerId: input.ownerId,
      sourceSnapshot: { ...input.sourceSnapshot, expiresAt: snapshotExpiresAt },
      status: "created",
      credentialBinding: input.credentialBinding,
      billingProvenance: {
        providerId: input.engine,
        inputUnits: 0,
        outputUnits: 0,
        billedAt: null,
      },
      resultRef: null,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
    const state: InternalDocumentJobState = {
      job,
      callerWaitCancelled: false,
      groundlaneDispatchCancelled: false,
      upstreamRequested: false,
      upstreamAck: null,
    };
    this.store.set(state);
    return { job, reused: false };
  }

  /** Read-only poll; never extends expiry. */
  poll(jobId: string, ownerId: string, now: Date = new Date()): AsyncDocumentJob {
    return this.resolve(jobId, ownerId, now).job;
  }

  /** Monotonic status transition. */
  transition(
    jobId: string,
    ownerId: string,
    to: AsyncDocumentJob["status"],
    now: Date = new Date(),
  ): AsyncDocumentJob {
    const state = this.resolve(jobId, ownerId, now);
    try {
      validateDocumentJobStatusTransition(state.job.status, to);
    } catch (error) {
      throw executionRuntimeError(error instanceof Error ? error.message : "Invalid status transition");
    }
    const next: InternalDocumentJobState = { ...state, job: { ...state.job, status: to } };
    this.store.set(next);
    return next.job;
  }

  /** Source delete revokes the snapshot (terminal-cancel when running). */
  revokeSource(jobId: string, ownerId: string, now: Date = new Date()): AsyncDocumentJob {
    const state = this.resolve(jobId, ownerId, now);
    const revoked = revokeSnapshot(state.job);
    const next: InternalDocumentJobState = { ...state, job: revoked };
    this.store.set(next);
    return revoked;
  }

  /** Cancel kind 1: caller stops waiting. Flag-only; job keeps running. */
  cancelCallerWait(jobId: string, ownerId: string, now: Date = new Date()): DocumentCancelOutcome {
    const state = this.resolve(jobId, ownerId, now);
    this.assertNonTerminal(state);
    const next: InternalDocumentJobState = { ...state, callerWaitCancelled: true };
    this.store.set(next);
    return this.toCancelOutcome(next);
  }

  /** Cancel kind 2: Groundlane stops polling/dispatch. Transitions when active. */
  cancelGroundlaneDispatch(
    jobId: string,
    ownerId: string,
    now: Date = new Date(),
  ): DocumentCancelOutcome {
    const state = this.resolve(jobId, ownerId, now);
    this.assertNonTerminal(state);
    let job = state.job;
    try {
      validateDocumentJobStatusTransition(job.status, "cancelled");
      job = { ...job, status: "cancelled" as const };
    } catch {
      // Already in a state that cannot move to cancelled (e.g. created->cancelled
      // is monotonic per order table, so this rarely triggers); keep status.
    }
    const next: InternalDocumentJobState = {
      ...state,
      job,
      groundlaneDispatchCancelled: true,
    };
    this.store.set(next);
    return this.toCancelOutcome(next);
  }

  /**
   * Cancel kind 3: upstream cancel requires provider acknowledgment.
   * Without ack only upstreamRequested is recorded; upstreamCancelled stays false.
   */
  requestUpstreamCancel(
    jobId: string,
    ownerId: string,
    now: Date,
    ack: DocumentProviderCancelAck | null,
  ): DocumentCancelOutcome {
    const state = this.resolve(jobId, ownerId, now);
    this.assertNonTerminal(state);
    if (ack === null) {
      const next: InternalDocumentJobState = { ...state, upstreamRequested: true };
      this.store.set(next);
      return this.toCancelOutcome(next);
    }
    if (!Number.isInteger(ack.providerResponseCode) || ack.acknowledgedAt === "") {
      throw executionRuntimeError("provider acknowledgment must carry response code and timestamp");
    }
    let job = state.job;
    try {
      validateDocumentJobStatusTransition(job.status, "cancelled");
      job = { ...job, status: "cancelled" as const };
    } catch {
      // Keep current status if transition is not monotonic from here.
    }
    const next: InternalDocumentJobState = {
      ...state,
      job,
      upstreamRequested: true,
      upstreamAck: ack,
    };
    this.store.set(next);
    const outcome = this.toCancelOutcome(next);
    if (outcome.upstreamCancelled && outcome.providerAck === null) {
      throw executionRuntimeError("upstreamCancelled requires provider acknowledgment");
    }
    return outcome;
  }

  /** Disconnect-safe resume: read-only, never cancels the durable job. */
  resumeAfterDisconnect(jobId: string, ownerId: string, now: Date = new Date()): AsyncDocumentJob {
    return this.poll(jobId, ownerId, now);
  }

  /** Retry budget check: returns remaining, never resets the total. */
  checkRetryBudget(totalBudgetMs: number, elapsedMs: number): number {
    try {
      return computeRemainingBudget(totalBudgetMs, elapsedMs);
    } catch (error) {
      throw executionRuntimeError(error instanceof Error ? error.message : "Budget exhausted");
    }
  }

  /** Independent per-category deadline check (sync/create/poll/absolute/attempt). */
  checkDocumentDeadline(elapsedMs: number, deadlineMs: number, label: string): void {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw executionRuntimeError(`Deadline "${label}" must be positive`);
    }
    if (elapsedMs > deadlineMs) {
      throw new GroundlaneError(
        "DEADLINE_EXCEEDED",
        "document-execution",
        `Document deadline "${label}" exceeded`,
      );
    }
  }

  private toCancelOutcome(state: InternalDocumentJobState): DocumentCancelOutcome {
    const base = {
      job: state.job,
      callerWaitCancelled: state.callerWaitCancelled,
      groundlaneDispatchCancelled: state.groundlaneDispatchCancelled,
      upstreamRequested: state.upstreamRequested,
      upstreamCancelled: state.upstreamAck !== null,
    };
    if (state.upstreamAck === null) {
      return { ...base, providerAck: null };
    }
    return { ...base, providerAck: state.upstreamAck };
  }

  private resolve(jobId: string, ownerId: string, now: Date): InternalDocumentJobState {
    assertBoundedId(jobId, "jobId", MAX_DOCUMENT_HASH_CHARS);
    assertBoundedId(ownerId, "ownerId", MAX_DOCUMENT_OWNER_CHARS);
    const state = this.store.get(jobId);
    if (state === undefined) {
      throw executionRuntimeError(`Unknown document job "${jobId.slice(0, 32)}"`);
    }
    if (state.job.ownerId !== ownerId) {
      throw executionRuntimeError("Owner mismatch: caller does not own this document job");
    }
    if (new Date(state.job.expiresAt).getTime() <= now.getTime()) {
      throw new GroundlaneError(
        "DEADLINE_EXCEEDED",
        "document-execution",
        "Document job has expired",
      );
    }
    return state;
  }

  private assertNonTerminal(state: InternalDocumentJobState): void {
    const terminal: readonly string[] = ["completed", "failed", "cancelled", "deleted", "expired"];
    if (terminal.includes(state.job.status)) {
      throw executionRuntimeError(
        `Cannot transition from terminal status "${state.job.status}"`,
      );
    }
  }
}
