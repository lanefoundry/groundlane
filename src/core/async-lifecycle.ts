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
