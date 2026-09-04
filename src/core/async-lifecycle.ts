// ---------------------------------------------------------------------------
// Async job lifecycle contracts (PRD 636, 637, 645, 646)
// ---------------------------------------------------------------------------

// -- PRD 636: Client capability matrix --------------------------------------

export interface ClientCapabilityEntry {
  readonly clientId: string;
  readonly supportsAsyncTasks: boolean;
  readonly supportsNotifications: boolean;
  readonly supportsPolling: boolean;
  readonly uploadHandoff: boolean;
  readonly verifiedAt: string | null;
}

export interface ClientCapabilityMatrix {
  readonly entries: readonly ClientCapabilityEntry[];
}

const KNOWN_CLIENT_IDS = new Set(["claude", "codex", "cursor"]);

export function verifyClientMatrix(matrix: ClientCapabilityMatrix): void {
  if (matrix.entries.length === 0) {
    throw new Error("Client capability matrix must contain at least one entry");
  }

  const seenIds = new Set<string>();
  for (const entry of matrix.entries) {
    if (!KNOWN_CLIENT_IDS.has(entry.clientId)) {
      throw new Error(
        `Unknown client "${entry.clientId}"; known clients: ${[...KNOWN_CLIENT_IDS].join(", ")}`,
      );
    }
    if (seenIds.has(entry.clientId)) {
      throw new Error(`Duplicate client entry for "${entry.clientId}"`);
    }
    seenIds.add(entry.clientId);

    if (entry.verifiedAt === null) {
      throw new Error(
        `Client "${entry.clientId}" has not been verified (verifiedAt is null); ` +
          "async tasks cannot be enabled until all clients are verified",
      );
    }
  }
}

// -- PRD 637: Async job state and cancel kinds ------------------------------

export type AsyncJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled_by_caller"
  | "cancelled_by_groundlane"
  | "cancelled_by_upstream";

export type CancelKind =
  | "caller"
  | "groundlane"
  | "upstream";

export interface AsyncJobRecord {
  readonly jobId: string;
  readonly ownerId: string;
  readonly providerJobId: string;
  readonly credentialBinding: string;
  readonly ttlSeconds: number;
  readonly expiresAt: string;
  readonly status: AsyncJobStatus;
  readonly billingProvenance: BillingProvenance;
  readonly sanitizedError?: string;
  readonly result?: unknown;
}

export interface BillingProvenance {
  readonly providerId: string;
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly billedAt: string | null;
}

/**
 * Ordered index for monotonic status transitions.  A status can only move
 * forward (to a higher index).  Terminal states cannot be left.
 */
const STATUS_ORDER: Record<AsyncJobStatus, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled_by_caller: 2,
  cancelled_by_groundlane: 2,
  cancelled_by_upstream: 2,
};

export function validateStatusTransition(
  from: AsyncJobStatus,
  to: AsyncJobStatus,
): void {
  const fromOrder = STATUS_ORDER[from];
  const toOrder = STATUS_ORDER[to];

  if (from === to) {
    throw new Error(`Status is already "${from}"; no transition needed`);
  }
  if (fromOrder >= 2) {
    throw new Error(
      `Cannot transition from terminal status "${from}" to "${to}"`,
    );
  }
  if (toOrder < fromOrder) {
    throw new Error(
      `Non-monotonic status transition: "${from}" (${String(fromOrder)}) -> "${to}" (${String(toOrder)})`,
    );
  }
}

export function validateAsyncJobRecord(record: AsyncJobRecord): void {
  if (!record.jobId) {
    throw new Error("jobId is required");
  }
  if (!record.ownerId) {
    throw new Error("ownerId is required");
  }
  if (!record.credentialBinding) {
    throw new Error("credentialBinding is required for async job records");
  }
  if (record.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive number");
  }
  if (!record.expiresAt) {
    throw new Error("expiresAt is required");
  }
  if (!record.billingProvenance.providerId) {
    throw new Error("billingProvenance.providerId is required");
  }
}

export function isJobExpired(record: AsyncJobRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

// -- PRD 645: Durable crawl job contract ------------------------------------

export interface CrawlBudgets {
  readonly maxPages: number;
  readonly maxBytes: number;
  readonly maxOutputChars: number;
}

export type CrawlJobStatus =
  | "created"
  | "crawling"
  | "completed"
  | "failed"
  | "cancelled_by_caller"
  | "cancelled_by_groundlane"
  | "cancelled_by_upstream";

export interface DurableCrawlJob {
  /** Opaque Groundlane-generated ID -- never the provider's job ID. */
  readonly groundlaneJobId: string;
  readonly ownerId: string;
  readonly expiresAt: string;
  readonly status: CrawlJobStatus;
  readonly budgets: CrawlBudgets;
  readonly createdAt: string;
  readonly paginationCursor?: string;
  readonly partialResults?: readonly CrawlPartialResult[];
}

export interface CrawlPartialResult {
  readonly url: string;
  readonly contentChars: number;
  readonly fetchedAt: string;
}

/**
 * Internal-only record that maps a Groundlane job to the provider job.
 * This type must never appear in any public API surface.
 */
export interface InternalCrawlJobMapping {
  readonly groundlaneJobId: string;
  readonly providerJobId: string;
  readonly providerId: string;
}

export function validateCrawlJobOwnership(
  job: DurableCrawlJob,
  callerId: string,
): void {
  if (job.ownerId !== callerId) {
    throw new Error(
      "Owner mismatch: caller does not own this crawl job",
    );
  }
}

export function validateCrawlJobNotExpired(
  job: DurableCrawlJob,
  now: Date,
): void {
  if (new Date(job.expiresAt).getTime() <= now.getTime()) {
    throw new Error("Crawl job has expired");
  }
}

export function lookupCrawlJob(
  jobs: readonly DurableCrawlJob[],
  groundlaneJobId: string,
): DurableCrawlJob {
  const job = jobs.find((j) => j.groundlaneJobId === groundlaneJobId);
  if (job === undefined) {
    throw new Error("Unknown crawl job");
  }
  return job;
}

export function validateCrawlBudgets(
  budgets: CrawlBudgets,
  currentPages: number,
  currentBytes: number,
  currentOutputChars: number,
): void {
  if (currentPages > budgets.maxPages) {
    throw new Error(
      `Page budget exceeded: ${String(currentPages)} > ${String(budgets.maxPages)}`,
    );
  }
  if (currentBytes > budgets.maxBytes) {
    throw new Error(
      `Byte budget exceeded: ${String(currentBytes)} > ${String(budgets.maxBytes)}`,
    );
  }
  if (currentOutputChars > budgets.maxOutputChars) {
    throw new Error(
      `Output char budget exceeded: ${String(currentOutputChars)} > ${String(budgets.maxOutputChars)}`,
    );
  }
}

/**
 * Asserts that no public-facing field on a DurableCrawlJob contains the
 * raw provider job ID.  The provider job ID must only live in the
 * internal mapping table.
 */
export function assertProviderJobIdNotLeaked(
  job: DurableCrawlJob,
  providerJobId: string,
): void {
  const serialised = JSON.stringify(job);
  if (serialised.includes(providerJobId)) {
    throw new Error(
      "Provider job ID must not appear in public crawl job fields",
    );
  }
}

// -- PRD 646: Crawl cancel result with three distinct cancellation states ---

export interface CrawlCancelResult {
  readonly callerCancelled: boolean;
  readonly groundlanePollingCancelled: boolean;
  readonly upstreamCancelled: boolean;
  readonly providerAcknowledgment?: ProviderCancelAcknowledgment;
}

export interface ProviderCancelAcknowledgment {
  readonly providerResponseCode: number;
  readonly acknowledgedAt: string;
}

export function validateCrawlCancelResult(result: CrawlCancelResult): void {
  if (result.upstreamCancelled && !result.providerAcknowledgment) {
    throw new Error(
      "upstreamCancelled cannot be true without providerAcknowledgment evidence",
    );
  }
}

// ---------------------------------------------------------------------------
// PRD 636/722 runtime: in-memory deterministic async job lifecycle
// ---------------------------------------------------------------------------
//
// This section implements the complete runtime behind the contract
// validators above. It is intentionally in-memory and deterministic:
// no D1/DO/Workflow/Queue/R2 live bindings, no network, no clock beyond
// an injectable `now`. The two port interfaces below
// (`AsyncJobStorePort`, `AsyncProviderPort`) are the explicit seam where a
// future durable backend replaces `InMemoryAsyncJobStore` and a real
// provider adapter replaces the fake used in tests.
//
// Invariants enforced here (not merely implied by SDK types):
// - caller ownership binding + credential binding on every read/mutation;
// - TTL/expiry from a fixed creation timestamp (poll waits never extend it);
// - provider job IDs live only in internal state, never in public views;
// - status monotonicity via `validateStatusTransition` on every mutation;
// - billing provenance preserved across cancel/failure;
// - sanitized errors (no secrets, stacks, or raw upstream bodies);
// - three independent cancels: caller stops waiting, Groundlane stops
//   polling/dispatch, upstream actually cancels (ack-gated);
// - idempotency/replay guards for task creation, paid calls, artifact writes;
// - per-client, per-operation capability evidence: a passing
//   `verifyClientMatrix` alone never authorises an operation.

import { GroundlaneError } from "./errors.js";

export const ASYNC_JOB_ID_PREFIX = "ajob-";
export const MAX_ASYNC_JOBS = 1000;
export const MAX_SANITIZED_ERROR_CHARS = 500;
export const MAX_URL_CHARS = 2000;

export const ASYNC_CLIENT_OPERATIONS = [
  "create",
  "poll",
  "result",
  "cancel",
  "resume",
] as const;

export type AsyncClientOperation = (typeof ASYNC_CLIENT_OPERATIONS)[number];

const ASYNC_TERMINAL_STATUSES: ReadonlySet<AsyncJobStatus> = new Set([
  "completed",
  "failed",
  "cancelled_by_caller",
  "cancelled_by_groundlane",
  "cancelled_by_upstream",
]);

export function isTerminalAsyncStatus(status: AsyncJobStatus): boolean {
  return ASYNC_TERMINAL_STATUSES.has(status);
}

/**
 * Shape-only validation for caller/provider URLs. Every URL is treated as
 * untrusted: HTTP(S) only, no embedded credentials, bounded length.
 * Network-time SSRF/DNS/redirect policy still belongs to the fetch
 * pipeline; this gate only guarantees the runtime never stores or
 * dispatches an obviously unsafe value.
 */
export function assertPublicHttpUrl(value: string, field: string): string {
  if (value.length === 0 || value.length > MAX_URL_CHARS) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "async-lifecycle",
      `${field} must be a non-empty URL within ${String(MAX_URL_CHARS)} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "async-lifecycle",
      `${field} must be a valid absolute URL`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "async-lifecycle",
      `${field} must use HTTP(S); got "${parsed.protocol}"`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "async-lifecycle",
      `${field} must not contain credentials`,
    );
  }
  if (parsed.hostname === "") {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "async-lifecycle",
      `${field} must contain a hostname`,
    );
  }
  return parsed.href;
}

const SECRET_REDACTIONS: readonly RegExp[] = [
  /bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
  /api[_-]?key\s*[:=]\s*[^\s,;}"']+/gi,
  /\btoken\s*[:=]\s*[^\s,;}"']+/gi,
  /authorization\s*:\s*[^\n,}]+/gi,
];

/**
 * Reduces any upstream failure to a bounded, log-safe message. Drops stack
 * frames (only the first line is kept), redacts bearer/key/token shapes,
 * collapses whitespace, and caps length. Already-sanitized
 * `GroundlaneError` messages pass through with only bounding applied.
 */
export function sanitizeUpstreamError(error: unknown, stage = "async-job"): string {
  void stage;
  let message: string;
  if (error instanceof GroundlaneError) {
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = "The upstream operation failed";
  }
  const firstLine = (message.split("\n")[0] ?? "").trim();
  let redacted = firstLine;
  for (const pattern of SECRET_REDACTIONS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[redacted]");
  }
  redacted = redacted.replace(/\s+/g, " ").trim();
  if (redacted === "") {
    return "The upstream operation failed";
  }
  return redacted.slice(0, MAX_SANITIZED_ERROR_CHARS);
}

export interface ClientOperationEvidence {
  readonly clientId: string;
  readonly operation: AsyncClientOperation;
  readonly verifiedAt: string;
  readonly transport: string;
}

function assertKnownClientId(clientId: string): void {
  if (!KNOWN_CLIENT_IDS.has(clientId)) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "async-lifecycle",
      `Unknown client "${clientId}"; known clients: ${[...KNOWN_CLIENT_IDS].join(", ")}`,
    );
  }
}

export interface AsyncJobCaller {
  readonly ownerId: string;
  readonly credentialBinding: string;
}

export interface CreateAsyncJobInput {
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly providerId: string;
  readonly ttlSeconds: number;
  readonly idempotencyKey?: string;
  readonly sourceUrl?: string;
  readonly now?: Date;
}

export interface BillingUnits {
  readonly inputUnits: number;
  readonly outputUnits: number;
}

export interface CompleteAsyncJobOptions {
  readonly billing?: BillingUnits;
  readonly now?: Date;
}

/** Public view: never contains the provider job ID or raw credentials. */
export interface PublicAsyncJob {
  readonly jobId: string;
  readonly ownerId: string;
  readonly status: AsyncJobStatus;
  readonly expiresAt: string;
  readonly billingProvenance: BillingProvenance;
  readonly callerCancelled: boolean;
  readonly groundlanePollingCancelled: boolean;
  readonly upstreamCancelRequested: boolean;
  readonly upstreamCancelled: boolean;
  readonly sanitizedError?: string;
  readonly result?: unknown;
}

export interface AsyncJobCreateResult {
  readonly job: PublicAsyncJob;
  readonly reused: boolean;
}

export interface UpstreamCancelOutcome {
  readonly job: PublicAsyncJob;
  readonly cancelResult: CrawlCancelResult;
}

export interface PaidCallOutcome {
  readonly reused: boolean;
}

export interface ArtifactWriteOutcome {
  readonly reused: boolean;
  readonly result: unknown;
}

/** Internal-only state. Must never be returned from a public method. */
export interface InternalAsyncJobState {
  readonly record: AsyncJobRecord;
  readonly idempotencyKey: string | null;
  readonly callerCancelled: boolean;
  readonly groundlanePollingCancelled: boolean;
  readonly upstreamCancelRequested: boolean;
  readonly upstreamAcknowledgment: ProviderCancelAcknowledgment | null;
  readonly paidCallCompleted: boolean;
  readonly artifactWriteCompleted: boolean;
  readonly artifactResult: unknown;
}

/** Durable-backend port: D1/DO/Workflow snapshots plug in here. */
export interface AsyncJobStorePort {
  get(jobId: string): InternalAsyncJobState | undefined;
  set(state: InternalAsyncJobState): void;
  getByIdempotencyKey(key: string): InternalAsyncJobState | undefined;
  size(): number;
}

/** Provider-adapter port: real task creation/cancel plugs in here. */
export interface AsyncProviderPort {
  createTask(input: { ownerId: string; providerId: string }): string;
  cancelTask(providerJobId: string): ProviderCancelAcknowledgment | null;
}

export class InMemoryAsyncJobStore implements AsyncJobStorePort {
  private readonly jobs = new Map<string, InternalAsyncJobState>();
  private readonly byIdempotency = new Map<string, string>();

  get(jobId: string): InternalAsyncJobState | undefined {
    return this.jobs.get(jobId);
  }

  set(state: InternalAsyncJobState): void {
    this.jobs.set(state.record.jobId, state);
    if (state.idempotencyKey !== null) {
      this.byIdempotency.set(state.idempotencyKey, state.record.jobId);
    }
  }

  getByIdempotencyKey(key: string): InternalAsyncJobState | undefined {
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

export function buildAsyncIdempotencyKey(ownerId: string, idempotencyKey: string): string {
  if (ownerId === "") {
    throw new GroundlaneError("INVALID_INPUT", "async-lifecycle", "ownerId is required");
  }
  if (idempotencyKey === "") {
    throw new GroundlaneError("INVALID_INPUT", "async-lifecycle", "idempotencyKey must be non-empty");
  }
  // In-memory scope only: a durable backend must use structured keys so
  // separators inside ownerId can never collide.
  return `${ownerId}:${idempotencyKey}`;
}

export function toPublicAsyncJob(state: InternalAsyncJobState): PublicAsyncJob {
  const base = {
    jobId: state.record.jobId,
    ownerId: state.record.ownerId,
    status: state.record.status,
    expiresAt: state.record.expiresAt,
    billingProvenance: state.record.billingProvenance,
    callerCancelled: state.callerCancelled,
    groundlanePollingCancelled: state.groundlanePollingCancelled,
    upstreamCancelRequested: state.upstreamCancelRequested,
    upstreamCancelled: state.upstreamAcknowledgment !== null,
  };
  const withError =
    state.record.sanitizedError === undefined
      ? base
      : { ...base, sanitizedError: state.record.sanitizedError };
  if (state.record.result === undefined) {
    return withError;
  }
  return { ...withError, result: state.record.result };
}

export interface AsyncJobManagerOptions {
  readonly store?: AsyncJobStorePort;
  readonly provider?: AsyncProviderPort;
  readonly maxJobs?: number;
  readonly jobIdPrefix?: string;
}

/**
 * In-memory deterministic async tool lifecycle runtime (PRD 636 + PRD 722
 * idempotency part). All time flows through the injectable `now`
 * parameter so tests are fully deterministic.
 */
export class AsyncJobManager {
  private readonly store: AsyncJobStorePort;
  private readonly provider: AsyncProviderPort | null;
  private readonly maxJobs: number;
  private readonly jobIdPrefix: string;
  private nextId = 1;
  private readonly evidence = new Map<string, ClientOperationEvidence>();

  constructor(options: AsyncJobManagerOptions = {}) {
    this.store = options.store ?? new InMemoryAsyncJobStore();
    this.provider = options.provider ?? null;
    this.maxJobs = options.maxJobs ?? MAX_ASYNC_JOBS;
    this.jobIdPrefix = options.jobIdPrefix ?? ASYNC_JOB_ID_PREFIX;
  }

  create(input: CreateAsyncJobInput): AsyncJobCreateResult {
    if (input.ownerId === "") {
      throw new GroundlaneError("INVALID_INPUT", "async-lifecycle", "ownerId is required");
    }
    if (input.credentialBinding === "") {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "credentialBinding is required for async job records",
      );
    }
    if (input.providerId === "") {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "billingProvenance.providerId is required",
      );
    }
    if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "ttlSeconds must be a positive number",
      );
    }
    if (input.sourceUrl !== undefined) {
      assertPublicHttpUrl(input.sourceUrl, "sourceUrl");
    }
    const now = input.now ?? new Date();

    if (input.idempotencyKey !== undefined) {
      const key = buildAsyncIdempotencyKey(input.ownerId, input.idempotencyKey);
      const existing = this.store.getByIdempotencyKey(key);
      if (existing !== undefined) {
        return { job: toPublicAsyncJob(existing), reused: true };
      }
    }
    if (this.store.size() >= this.maxJobs) {
      throw new GroundlaneError(
        "CONCURRENCY_LIMIT",
        "async-lifecycle",
        "The async job store is full",
        true,
      );
    }

    const jobId = `${this.jobIdPrefix}${String(this.nextId).padStart(6, "0")}`;
    this.nextId += 1;
    const providerJobId =
      this.provider === null
        ? `deferred:${jobId}`
        : this.provider.createTask({ ownerId: input.ownerId, providerId: input.providerId });
    const record: AsyncJobRecord = {
      jobId,
      ownerId: input.ownerId,
      providerJobId,
      credentialBinding: input.credentialBinding,
      ttlSeconds: input.ttlSeconds,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
      status: "pending",
      billingProvenance: {
        providerId: input.providerId,
        inputUnits: 0,
        outputUnits: 0,
        billedAt: null,
      },
    };
    validateAsyncJobRecord(record);
    const state: InternalAsyncJobState = {
      record,
      idempotencyKey:
        input.idempotencyKey === undefined
          ? null
          : buildAsyncIdempotencyKey(input.ownerId, input.idempotencyKey),
      callerCancelled: false,
      groundlanePollingCancelled: false,
      upstreamCancelRequested: false,
      upstreamAcknowledgment: null,
      paidCallCompleted: false,
      artifactWriteCompleted: false,
      artifactResult: null,
    };
    this.store.set(state);
    return { job: toPublicAsyncJob(state), reused: false };
  }

  /** Read-only poll. Never extends expiry, never mutates lifecycle. */
  poll(jobId: string, caller: AsyncJobCaller, now: Date = new Date()): PublicAsyncJob {
    return toPublicAsyncJob(this.resolve(jobId, caller, now));
  }

  /** Read-only result fetch. Disconnect-safe: repeatable after any poll gap. */
  result(jobId: string, caller: AsyncJobCaller, now: Date = new Date()): PublicAsyncJob {
    return toPublicAsyncJob(this.resolve(jobId, caller, now));
  }

  markRunning(jobId: string, caller: AsyncJobCaller, now: Date = new Date()): PublicAsyncJob {
    const state = this.resolve(jobId, caller, now);
    const next = this.transition(state, "running");
    this.store.set(next);
    return toPublicAsyncJob(next);
  }

  markCompleted(
    jobId: string,
    caller: AsyncJobCaller,
    result: unknown,
    options: CompleteAsyncJobOptions = {},
  ): PublicAsyncJob {
    const now = options.now ?? new Date();
    const state = this.resolve(jobId, caller, now);
    const transitioned = this.transition(state, "completed");
    const billing: BillingProvenance =
      options.billing === undefined
        ? transitioned.record.billingProvenance
        : {
            providerId: transitioned.record.billingProvenance.providerId,
            inputUnits: options.billing.inputUnits,
            outputUnits: options.billing.outputUnits,
            billedAt: now.toISOString(),
          };
    const record: AsyncJobRecord =
      result === undefined
        ? { ...transitioned.record, billingProvenance: billing }
        : { ...transitioned.record, billingProvenance: billing, result };
    const next: InternalAsyncJobState = { ...transitioned, record };
    this.store.set(next);
    return toPublicAsyncJob(next);
  }

  markFailed(
    jobId: string,
    caller: AsyncJobCaller,
    upstreamError: unknown,
    now: Date = new Date(),
  ): PublicAsyncJob {
    const state = this.resolve(jobId, caller, now);
    const transitioned = this.transition(state, "failed");
    const record: AsyncJobRecord = {
      ...transitioned.record,
      sanitizedError: sanitizeUpstreamError(upstreamError, "async-job"),
    };
    const next: InternalAsyncJobState = { ...transitioned, record };
    this.store.set(next);
    return toPublicAsyncJob(next);
  }

  /** PRD 722: paid upstream calls run once per job; retries reuse billing. */
  recordPaidCall(
    jobId: string,
    caller: AsyncJobCaller,
    units: BillingUnits,
    now: Date = new Date(),
  ): PaidCallOutcome {
    if (!Number.isInteger(units.inputUnits) || units.inputUnits < 0) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "inputUnits must be a non-negative integer",
      );
    }
    if (!Number.isInteger(units.outputUnits) || units.outputUnits < 0) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "outputUnits must be a non-negative integer",
      );
    }
    const state = this.resolve(jobId, caller, now);
    if (state.paidCallCompleted) {
      return { reused: true };
    }
    const previous = state.record.billingProvenance;
    const record: AsyncJobRecord = {
      ...state.record,
      billingProvenance: {
        providerId: previous.providerId,
        inputUnits: previous.inputUnits + units.inputUnits,
        outputUnits: previous.outputUnits + units.outputUnits,
        billedAt: previous.billedAt ?? now.toISOString(),
      },
    };
    this.store.set({ ...state, record, paidCallCompleted: true });
    return { reused: false };
  }

  /** PRD 722: artifact writes run once per job; retries return the stored result. */
  recordArtifactWrite(
    jobId: string,
    caller: AsyncJobCaller,
    result: unknown,
    now: Date = new Date(),
  ): ArtifactWriteOutcome {
    const state = this.resolve(jobId, caller, now);
    if (state.artifactWriteCompleted) {
      return { reused: true, result: state.artifactResult };
    }
    this.store.set({ ...state, artifactWriteCompleted: true, artifactResult: result });
    return { reused: false, result };
  }

  /** Cancel kind 1: the caller stops waiting. Needs no provider ack. */
  cancelCallerWait(
    jobId: string,
    caller: AsyncJobCaller,
    now: Date = new Date(),
  ): PublicAsyncJob {
    const state = this.resolve(jobId, caller, now);
    const transitioned = this.transition(state, "cancelled_by_caller");
    const next: InternalAsyncJobState = { ...transitioned, callerCancelled: true };
    this.store.set(next);
    return toPublicAsyncJob(next);
  }

  /** Cancel kind 2: Groundlane stops polling/dispatch. Needs no provider ack. */
  cancelGroundlanePolling(
    jobId: string,
    caller: AsyncJobCaller,
    now: Date = new Date(),
  ): PublicAsyncJob {
    const state = this.resolve(jobId, caller, now);
    const transitioned = this.transition(state, "cancelled_by_groundlane");
    const next: InternalAsyncJobState = { ...transitioned, groundlanePollingCancelled: true };
    this.store.set(next);
    return toPublicAsyncJob(next);
  }

  /**
   * Cancel kind 3: request a real upstream cancel. Without provider
   * acknowledgment the job keeps its status and only
   * `upstreamCancelRequested` is recorded; `upstreamCancelled` stays false.
   */
  requestUpstreamCancel(
    jobId: string,
    caller: AsyncJobCaller,
    now: Date = new Date(),
  ): UpstreamCancelOutcome {
    const state = this.resolve(jobId, caller, now);
    this.assertNonTerminal(state);
    const acknowledgment =
      this.provider === null ? null : this.provider.cancelTask(state.record.providerJobId);
    if (acknowledgment === null) {
      const next: InternalAsyncJobState = { ...state, upstreamCancelRequested: true };
      this.store.set(next);
      const cancelResult: CrawlCancelResult = {
        callerCancelled: next.callerCancelled,
        groundlanePollingCancelled: next.groundlanePollingCancelled,
        upstreamCancelled: false,
      };
      validateCrawlCancelResult(cancelResult);
      return { job: toPublicAsyncJob(next), cancelResult };
    }
    const transitioned = this.transition(state, "cancelled_by_upstream");
    const next: InternalAsyncJobState = {
      ...transitioned,
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
    return { job: toPublicAsyncJob(next), cancelResult };
  }

  recordClientEvidence(evidence: ClientOperationEvidence): void {
    assertKnownClientId(evidence.clientId);
    if (
      !(ASYNC_CLIENT_OPERATIONS as readonly string[]).includes(evidence.operation)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        `Unknown async operation "${evidence.operation}"`,
      );
    }
    if (evidence.verifiedAt === "") {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "verifiedAt is required for capability evidence",
      );
    }
    if (evidence.transport === "") {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "transport is required for capability evidence",
      );
    }
    this.evidence.set(`${evidence.clientId}:${evidence.operation}`, evidence);
  }

  assertClientOperation(clientId: string, operation: AsyncClientOperation): void {
    assertKnownClientId(clientId);
    if (!this.evidence.has(`${clientId}:${operation}`)) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        `No verified ${operation} evidence for client "${clientId}"; ` +
          "async operations require observed create/poll/result/cancel/resume verification, " +
          "not SDK type inference",
      );
    }
  }

  verifiedCreate(clientId: string, input: CreateAsyncJobInput): AsyncJobCreateResult {
    this.assertClientOperation(clientId, "create");
    return this.create(input);
  }

  verifiedPoll(
    clientId: string,
    jobId: string,
    caller: AsyncJobCaller,
    now: Date = new Date(),
  ): PublicAsyncJob {
    this.assertClientOperation(clientId, "poll");
    return this.poll(jobId, caller, now);
  }

  verifiedResult(
    clientId: string,
    jobId: string,
    caller: AsyncJobCaller,
    now: Date = new Date(),
  ): PublicAsyncJob {
    this.assertClientOperation(clientId, "result");
    return this.result(jobId, caller, now);
  }

  verifiedCancel(
    clientId: string,
    jobId: string,
    caller: AsyncJobCaller,
    kind: CancelKind,
    now: Date = new Date(),
  ): PublicAsyncJob {
    this.assertClientOperation(clientId, "cancel");
    if (kind === "caller") {
      return this.cancelCallerWait(jobId, caller, now);
    }
    if (kind === "groundlane") {
      return this.cancelGroundlanePolling(jobId, caller, now);
    }
    return this.requestUpstreamCancel(jobId, caller, now).job;
  }

  /**
   * Resume after a poll-wait disconnect. Read-only by construction: a
   * dropped status connection never cancels the durable job.
   */
  resumeAfterDisconnect(
    clientId: string,
    jobId: string,
    caller: AsyncJobCaller,
    now: Date = new Date(),
  ): PublicAsyncJob {
    this.assertClientOperation(clientId, "resume");
    return this.poll(jobId, caller, now);
  }

  private resolve(jobId: string, caller: AsyncJobCaller, now: Date): InternalAsyncJobState {
    const state = this.store.get(jobId);
    if (state === undefined) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        `Unknown async job "${jobId}"`,
      );
    }
    if (state.record.ownerId !== caller.ownerId) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "Owner mismatch: caller does not own this async job",
      );
    }
    if (state.record.credentialBinding !== caller.credentialBinding) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        "Credential binding mismatch: caller credential does not match this async job",
      );
    }
    if (isJobExpired(state.record, now)) {
      throw new GroundlaneError(
        "DEADLINE_EXCEEDED",
        "async-lifecycle",
        `Async job "${jobId}" has expired`,
      );
    }
    return state;
  }

  private transition(state: InternalAsyncJobState, to: AsyncJobStatus): InternalAsyncJobState {
    try {
      validateStatusTransition(state.record.status, to);
    } catch (error) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        error instanceof Error ? error.message : "Invalid async status transition",
      );
    }
    return { ...state, record: { ...state.record, status: to } };
  }

  private assertNonTerminal(state: InternalAsyncJobState): void {
    if (isTerminalAsyncStatus(state.record.status)) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "async-lifecycle",
        `Cannot transition from terminal status "${state.record.status}"`,
      );
    }
  }
}
