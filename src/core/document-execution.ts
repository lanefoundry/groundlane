// ---------------------------------------------------------------------------
// Document execution lifecycle contracts (PRD 685, 686, 687, 688)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

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
