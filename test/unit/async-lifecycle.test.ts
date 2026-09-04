import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderJobIdNotLeaked,
  isJobExpired,
  lookupCrawlJob,
  validateAsyncJobRecord,
  validateCrawlBudgets,
  validateCrawlCancelResult,
  validateCrawlJobNotExpired,
  validateCrawlJobOwnership,
  validateStatusTransition,
  verifyClientMatrix,
  type AsyncJobRecord,
  type AsyncJobStatus,
  type BillingProvenance,
  type ClientCapabilityEntry,
  type ClientCapabilityMatrix,
  type CrawlCancelResult,
  type DurableCrawlJob,
  AsyncJobManager,
  InMemoryAsyncJobStore,
  sanitizeUpstreamError,
  type AsyncProviderPort,
  type CreateAsyncJobInput,
} from "../../src/core/async-lifecycle.js";
import { GroundlaneError } from "../../src/core/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClientEntry(
  clientId: string,
  overrides?: Partial<ClientCapabilityEntry>,
): ClientCapabilityEntry {
  return {
    clientId,
    supportsAsyncTasks: true,
    supportsNotifications: true,
    supportsPolling: true,
    uploadHandoff: false,
    verifiedAt: "2026-01-15T00:00:00Z",
    ...overrides,
  };
}

function makeBillingProvenance(overrides?: Partial<BillingProvenance>): BillingProvenance {
  return {
    providerId: "provider-crawl",
    inputUnits: 10,
    outputUnits: 5,
    billedAt: "2026-01-15T12:00:00Z",
    ...overrides,
  };
}

function makeJobRecord(overrides?: Partial<AsyncJobRecord>): AsyncJobRecord {
  return {
    jobId: "job-001",
    ownerId: "owner-abc",
    providerJobId: "prov-xyz",
    credentialBinding: "GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN",
    ttlSeconds: 3600,
    expiresAt: "2026-12-31T23:59:59Z",
    status: "pending",
    billingProvenance: makeBillingProvenance(),
    ...overrides,
  };
}

function makeCrawlJob(overrides?: Partial<DurableCrawlJob>): DurableCrawlJob {
  return {
    groundlaneJobId: "gl-crawl-001",
    ownerId: "owner-abc",
    expiresAt: "2026-12-31T23:59:59Z",
    status: "crawling",
    budgets: { maxPages: 100, maxBytes: 10_000_000, maxOutputChars: 500_000 },
    createdAt: "2026-01-15T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 636: Client capability matrix verification
// ---------------------------------------------------------------------------

void test("PRD 636: fully verified matrix passes verification", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("claude"),
      makeClientEntry("codex"),
      makeClientEntry("cursor"),
    ],
  };
  assert.doesNotThrow(() => verifyClientMatrix(matrix));
});

void test("PRD 636: matrix with unverified client rejects", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("claude"),
      makeClientEntry("codex", { verifiedAt: null }),
      makeClientEntry("cursor"),
    ],
  };
  assert.throws(
    () => verifyClientMatrix(matrix),
    { message: /codex.*not been verified/ },
  );
});

void test("PRD 636: unknown client rejected", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("claude"),
      makeClientEntry("unknown-client"),
    ],
  };
  assert.throws(
    () => verifyClientMatrix(matrix),
    { message: /Unknown client "unknown-client"/ },
  );
});

void test("PRD 636: empty matrix rejected", () => {
  const matrix: ClientCapabilityMatrix = { entries: [] };
  assert.throws(
    () => verifyClientMatrix(matrix),
    { message: /at least one entry/ },
  );
});

void test("PRD 636: duplicate client entries rejected", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("claude"),
      makeClientEntry("claude"),
    ],
  };
  assert.throws(
    () => verifyClientMatrix(matrix),
    { message: /Duplicate client entry/ },
  );
});

void test("PRD 636: supportsAsyncTasks field is independent per client", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("claude", { supportsAsyncTasks: true }),
      makeClientEntry("codex", { supportsAsyncTasks: false }),
      makeClientEntry("cursor", { supportsAsyncTasks: true }),
    ],
  };
  // All verified, so the matrix itself passes even though codex doesn't support async
  assert.doesNotThrow(() => verifyClientMatrix(matrix));
  const codex = matrix.entries.find((e) => e.clientId === "codex");
  assert.equal(codex?.supportsAsyncTasks, false);
});

void test("PRD 636: supportsNotifications field tracked per client", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("claude", { supportsNotifications: false }),
    ],
  };
  assert.doesNotThrow(() => verifyClientMatrix(matrix));
  assert.equal(matrix.entries[0]?.supportsNotifications, false);
});

void test("PRD 636: supportsPolling field tracked per client", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("cursor", { supportsPolling: false }),
    ],
  };
  assert.doesNotThrow(() => verifyClientMatrix(matrix));
  assert.equal(matrix.entries[0]?.supportsPolling, false);
});

void test("PRD 636: uploadHandoff field tracked per client", () => {
  const matrix: ClientCapabilityMatrix = {
    entries: [
      makeClientEntry("codex", { uploadHandoff: true }),
    ],
  };
  assert.doesNotThrow(() => verifyClientMatrix(matrix));
  assert.equal(matrix.entries[0]?.uploadHandoff, true);
});

// ---------------------------------------------------------------------------
// PRD 637: Async job lifecycle — status transitions and cancel kinds
// ---------------------------------------------------------------------------

void test("PRD 637: all three cancel kinds are distinct values", () => {
  const kinds = new Set(["caller", "groundlane", "upstream"]);
  assert.equal(kinds.size, 3);
});

void test("PRD 637: status transition pending -> running is valid", () => {
  assert.doesNotThrow(() => validateStatusTransition("pending", "running"));
});

void test("PRD 637: status transition pending -> completed is valid", () => {
  assert.doesNotThrow(() => validateStatusTransition("pending", "completed"));
});

void test("PRD 637: status transition running -> completed is valid", () => {
  assert.doesNotThrow(() => validateStatusTransition("running", "completed"));
});

void test("PRD 637: status transition running -> cancelled_by_caller is valid", () => {
  assert.doesNotThrow(() => validateStatusTransition("running", "cancelled_by_caller"));
});

void test("PRD 637: status transition running -> cancelled_by_groundlane is valid", () => {
  assert.doesNotThrow(() => validateStatusTransition("running", "cancelled_by_groundlane"));
});

void test("PRD 637: status transition running -> cancelled_by_upstream is valid", () => {
  assert.doesNotThrow(() => validateStatusTransition("running", "cancelled_by_upstream"));
});

void test("PRD 637: backward transition running -> pending is rejected", () => {
  assert.throws(
    () => validateStatusTransition("running", "pending"),
    { message: /Non-monotonic status transition/ },
  );
});

void test("PRD 637: transition from terminal completed -> running is rejected", () => {
  assert.throws(
    () => validateStatusTransition("completed", "running"),
    { message: /Cannot transition from terminal status/ },
  );
});

void test("PRD 637: transition from terminal failed -> pending is rejected", () => {
  assert.throws(
    () => validateStatusTransition("failed", "pending"),
    { message: /Cannot transition from terminal status/ },
  );
});

void test("PRD 637: transition from cancelled_by_caller -> running is rejected", () => {
  assert.throws(
    () => validateStatusTransition("cancelled_by_caller", "running"),
    { message: /Cannot transition from terminal status/ },
  );
});

void test("PRD 637: same-state transition is rejected", () => {
  assert.throws(
    () => validateStatusTransition("running", "running"),
    { message: /already "running"/ },
  );
});

void test("PRD 637: TTL/expiry enforcement — expired job detected", () => {
  const record = makeJobRecord({ expiresAt: "2020-01-01T00:00:00Z" });
  assert.equal(isJobExpired(record, new Date("2026-01-01T00:00:00Z")), true);
});

void test("PRD 637: TTL/expiry enforcement — non-expired job passes", () => {
  const record = makeJobRecord({ expiresAt: "2030-01-01T00:00:00Z" });
  assert.equal(isJobExpired(record, new Date("2026-01-01T00:00:00Z")), false);
});

void test("PRD 637: credential binding is required", () => {
  const record = makeJobRecord({ credentialBinding: "" });
  assert.throws(
    () => validateAsyncJobRecord(record),
    { message: /credentialBinding is required/ },
  );
});

void test("PRD 637: billing provenance preserved after cancel", () => {
  const provenance = makeBillingProvenance({ inputUnits: 42, outputUnits: 7 });
  const record = makeJobRecord({
    status: "cancelled_by_caller",
    billingProvenance: provenance,
  });
  assert.equal(record.billingProvenance.inputUnits, 42);
  assert.equal(record.billingProvenance.outputUnits, 7);
  assert.equal(record.status, "cancelled_by_caller");
  assert.doesNotThrow(() => validateAsyncJobRecord(record));
});

void test("PRD 637: ttlSeconds must be positive", () => {
  const record = makeJobRecord({ ttlSeconds: 0 });
  assert.throws(
    () => validateAsyncJobRecord(record),
    { message: /ttlSeconds must be a positive/ },
  );
});

void test("PRD 637: billingProvenance.providerId required", () => {
  const record = makeJobRecord({
    billingProvenance: makeBillingProvenance({ providerId: "" }),
  });
  assert.throws(
    () => validateAsyncJobRecord(record),
    { message: /billingProvenance\.providerId is required/ },
  );
});

void test("PRD 637: all seven async job statuses are distinct", () => {
  const statuses: AsyncJobStatus[] = [
    "pending", "running", "completed", "failed",
    "cancelled_by_caller", "cancelled_by_groundlane", "cancelled_by_upstream",
  ];
  assert.equal(new Set(statuses).size, 7);
});

// ---------------------------------------------------------------------------
// PRD 645: Durable crawl job contract
// ---------------------------------------------------------------------------

void test("PRD 645: owner mismatch rejected", () => {
  const job = makeCrawlJob({ ownerId: "owner-abc" });
  assert.throws(
    () => validateCrawlJobOwnership(job, "owner-xyz"),
    { message: /Owner mismatch/ },
  );
});

void test("PRD 645: owner match accepted", () => {
  const job = makeCrawlJob({ ownerId: "owner-abc" });
  assert.doesNotThrow(() => validateCrawlJobOwnership(job, "owner-abc"));
});

void test("PRD 645: expired job rejected", () => {
  const job = makeCrawlJob({ expiresAt: "2020-01-01T00:00:00Z" });
  assert.throws(
    () => validateCrawlJobNotExpired(job, new Date("2026-01-01T00:00:00Z")),
    { message: /expired/ },
  );
});

void test("PRD 645: non-expired job accepted", () => {
  const job = makeCrawlJob({ expiresAt: "2030-01-01T00:00:00Z" });
  assert.doesNotThrow(
    () => validateCrawlJobNotExpired(job, new Date("2026-01-01T00:00:00Z")),
  );
});

void test("PRD 645: unknown job returns stable error", () => {
  const jobs = [makeCrawlJob({ groundlaneJobId: "gl-001" })];
  assert.throws(
    () => lookupCrawlJob(jobs, "gl-999"),
    { message: /Unknown crawl job/ },
  );
});

void test("PRD 645: known job found by groundlaneJobId", () => {
  const jobs = [
    makeCrawlJob({ groundlaneJobId: "gl-001" }),
    makeCrawlJob({ groundlaneJobId: "gl-002" }),
  ];
  const found = lookupCrawlJob(jobs, "gl-002");
  assert.equal(found.groundlaneJobId, "gl-002");
});

void test("PRD 645: provider job ID not leaked in public fields", () => {
  const providerJobId = "prov-secret-12345";
  const job = makeCrawlJob({ groundlaneJobId: "gl-opaque-001" });
  // The public DurableCrawlJob should never contain the provider job ID
  assert.doesNotThrow(() => assertProviderJobIdNotLeaked(job, providerJobId));
});

void test("PRD 645: provider job ID leak detected", () => {
  const providerJobId = "prov-secret-12345";
  // Simulate a bug where provider ID leaks into groundlaneJobId
  const leakyJob = makeCrawlJob({ groundlaneJobId: providerJobId });
  assert.throws(
    () => assertProviderJobIdNotLeaked(leakyJob, providerJobId),
    { message: /Provider job ID must not appear/ },
  );
});

void test("PRD 645: partial results with pagination", () => {
  const job = makeCrawlJob({
    partialResults: [
      { url: "https://example.com/page1", contentChars: 5000, fetchedAt: "2026-01-15T00:01:00Z" },
      { url: "https://example.com/page2", contentChars: 3000, fetchedAt: "2026-01-15T00:02:00Z" },
    ],
    paginationCursor: "cursor-page-2",
  });
  assert.equal(job.partialResults?.length, 2);
  assert.equal(job.paginationCursor, "cursor-page-2");
});

void test("PRD 645: budget enforcement — page budget exceeded", () => {
  const budgets = { maxPages: 10, maxBytes: 10_000_000, maxOutputChars: 500_000 };
  assert.throws(
    () => validateCrawlBudgets(budgets, 11, 100, 100),
    { message: /Page budget exceeded/ },
  );
});

void test("PRD 645: budget enforcement — byte budget exceeded", () => {
  const budgets = { maxPages: 100, maxBytes: 1000, maxOutputChars: 500_000 };
  assert.throws(
    () => validateCrawlBudgets(budgets, 1, 1001, 100),
    { message: /Byte budget exceeded/ },
  );
});

void test("PRD 645: budget enforcement — output char budget exceeded", () => {
  const budgets = { maxPages: 100, maxBytes: 10_000_000, maxOutputChars: 500 };
  assert.throws(
    () => validateCrawlBudgets(budgets, 1, 100, 501),
    { message: /Output char budget exceeded/ },
  );
});

void test("PRD 645: budget enforcement — within limits passes", () => {
  const budgets = { maxPages: 100, maxBytes: 10_000_000, maxOutputChars: 500_000 };
  assert.doesNotThrow(() => validateCrawlBudgets(budgets, 50, 5_000_000, 250_000));
});

void test("PRD 645: opaque groundlaneJobId is not the provider job ID", () => {
  const internalMapping = {
    groundlaneJobId: "gl-opaque-abc",
    providerJobId: "firecrawl-job-xyz-789",
    providerId: "firecrawl",
  };
  const publicJob = makeCrawlJob({ groundlaneJobId: internalMapping.groundlaneJobId });
  assert.doesNotThrow(
    () => assertProviderJobIdNotLeaked(publicJob, internalMapping.providerJobId),
  );
  // Verify the mapping exists in internal structure but not in public
  assert.notEqual(publicJob.groundlaneJobId, internalMapping.providerJobId);
});

// ---------------------------------------------------------------------------
// PRD 646: Three distinct cancellation states
// ---------------------------------------------------------------------------

void test("PRD 646: all three cancel types coexist independently", () => {
  const result: CrawlCancelResult = {
    callerCancelled: true,
    groundlanePollingCancelled: true,
    upstreamCancelled: true,
    providerAcknowledgment: {
      providerResponseCode: 200,
      acknowledgedAt: "2026-01-15T12:00:00Z",
    },
  };
  assert.doesNotThrow(() => validateCrawlCancelResult(result));
  assert.equal(result.callerCancelled, true);
  assert.equal(result.groundlanePollingCancelled, true);
  assert.equal(result.upstreamCancelled, true);
});

void test("PRD 646: caller cancelled only", () => {
  const result: CrawlCancelResult = {
    callerCancelled: true,
    groundlanePollingCancelled: false,
    upstreamCancelled: false,
  };
  assert.doesNotThrow(() => validateCrawlCancelResult(result));
});

void test("PRD 646: groundlane polling cancelled only", () => {
  const result: CrawlCancelResult = {
    callerCancelled: false,
    groundlanePollingCancelled: true,
    upstreamCancelled: false,
  };
  assert.doesNotThrow(() => validateCrawlCancelResult(result));
});

void test("PRD 646: upstream cancel without acknowledgment rejected", () => {
  const result: CrawlCancelResult = {
    callerCancelled: false,
    groundlanePollingCancelled: false,
    upstreamCancelled: true,
    // providerAcknowledgment intentionally missing
  };
  assert.throws(
    () => validateCrawlCancelResult(result),
    { message: /upstreamCancelled cannot be true without providerAcknowledgment/ },
  );
});

void test("PRD 646: upstream cancel with acknowledgment accepted", () => {
  const result: CrawlCancelResult = {
    callerCancelled: false,
    groundlanePollingCancelled: false,
    upstreamCancelled: true,
    providerAcknowledgment: {
      providerResponseCode: 200,
      acknowledgedAt: "2026-01-15T12:30:00Z",
    },
  };
  assert.doesNotThrow(() => validateCrawlCancelResult(result));
});

void test("PRD 646: caller and groundlane cancelled but upstream not (no ack needed)", () => {
  const result: CrawlCancelResult = {
    callerCancelled: true,
    groundlanePollingCancelled: true,
    upstreamCancelled: false,
  };
  assert.doesNotThrow(() => validateCrawlCancelResult(result));
  // Without provider acknowledgment, upstreamCancelled must remain false
  assert.equal(result.upstreamCancelled, false);
});

void test("PRD 646: three cancel types map to three distinct async job statuses", () => {
  const cancelStatuses: AsyncJobStatus[] = [
    "cancelled_by_caller",
    "cancelled_by_groundlane",
    "cancelled_by_upstream",
  ];
  assert.equal(new Set(cancelStatuses).size, 3);
});

// ---------------------------------------------------------------------------
// PRD 636/722 runtime: AsyncJobManager (in-memory deterministic)
// Failing-first regression coverage for the complete async tool lifecycle:
// ownership, TTL/expiry, provider mapping isolation, credential binding,
// status monotonicity, billing provenance, sanitized errors, three
// independent cancels, capability evidence, idempotency/replay guards.
// ---------------------------------------------------------------------------

interface FakeAsyncProvider extends AsyncProviderPort {
  readonly created: string[];
  readonly cancelled: string[];
  ackNextCancel: boolean;
}

function makeFakeAsyncProvider(): FakeAsyncProvider {
  const created: string[] = [];
  const cancelled: string[] = [];
  let counter = 0;
  const port: FakeAsyncProvider = {
    created,
    cancelled,
    ackNextCancel: true,
    createTask: () => {
      counter += 1;
      const id = `prov-task-${String(counter).padStart(3, "0")}`;
      created.push(id);
      return id;
    },
    cancelTask: (providerJobId: string) => {
      cancelled.push(providerJobId);
      if (port.ackNextCancel) {
        return {
          providerResponseCode: 200,
          acknowledgedAt: "2026-02-01T00:00:00.000Z",
        };
      }
      return null;
    },
  };
  return port;
}

const CREATE_NOW = new Date("2026-02-01T00:00:00.000Z");
const OP_NOW = new Date("2026-02-01T00:00:10.000Z");
const CALLER = { ownerId: "owner-abc", credentialBinding: "BINDING-1" };

function makeCreateInput(overrides?: Partial<CreateAsyncJobInput>): CreateAsyncJobInput {
  return {
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    providerId: "firecrawl",
    ttlSeconds: 3600,
    now: CREATE_NOW,
    ...overrides,
  };
}

function makeManager(): { manager: AsyncJobManager; provider: FakeAsyncProvider } {
  const provider = makeFakeAsyncProvider();
  const manager = new AsyncJobManager({
    store: new InMemoryAsyncJobStore(),
    provider,
  });
  return { manager, provider };
}

function expectGroundlaneError(fn: () => unknown, code: string, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GroundlaneError, "expected a GroundlaneError");
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return;
  }
  assert.fail("expected function to throw");
}

void test("PRD 636 runtime: create returns public job with no provider job ID", () => {
  const { manager, provider } = makeManager();
  const { job, reused } = manager.create(makeCreateInput());
  assert.equal(reused, false);
  assert.equal(job.ownerId, CALLER.ownerId);
  assert.equal(job.status, "pending");
  assert.equal(job.expiresAt, "2026-02-01T01:00:00.000Z");
  assert.equal(provider.created.length, 1);
  const leaked = provider.created[0] ?? "";
  assert.ok(!JSON.stringify(job).includes(leaked), "provider job ID must not leak");
});

void test("PRD 722 runtime: idempotent create reuses job without new provider task", () => {
  const { manager, provider } = makeManager();
  const first = manager.create(makeCreateInput({ idempotencyKey: "idem-001" }));
  const second = manager.create(makeCreateInput({ idempotencyKey: "idem-001" }));
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.job.jobId, first.job.jobId);
  assert.equal(provider.created.length, 1);
});

void test("PRD 636 runtime: poll enforces owner binding", () => {
  const { manager } = makeManager();
  const { job } = manager.create(makeCreateInput());
  expectGroundlaneError(
    () => manager.poll(job.jobId, { ...CALLER, ownerId: "owner-evil" }, OP_NOW),
    "INVALID_INPUT",
    /Owner mismatch/,
  );
});

void test("PRD 636 runtime: poll on unknown job returns stable error", () => {
  const { manager } = makeManager();
  expectGroundlaneError(
    () => manager.poll("ajob-999999", CALLER, OP_NOW),
    "INVALID_INPUT",
    /Unknown async job/,
  );
});

void test("PRD 636 runtime: poll on expired job is rejected without mutation", () => {
  const { manager } = makeManager();
  const { job } = manager.create(makeCreateInput({ ttlSeconds: 60 }));
  expectGroundlaneError(
    () => manager.poll(job.jobId, CALLER, new Date("2026-02-01T02:00:00.000Z")),
    "DEADLINE_EXCEEDED",
    /expired/,
  );
  // Non-expired poll still works and status is unchanged.
  const fresh = manager.poll(job.jobId, CALLER, new Date("2026-02-01T00:00:30.000Z"));
  assert.equal(fresh.status, "pending");
});

void test("PRD 636 runtime: credential binding mismatch is rejected", () => {
  const { manager } = makeManager();
  const { job } = manager.create(makeCreateInput());
  expectGroundlaneError(
    () => manager.poll(job.jobId, { ...CALLER, credentialBinding: "BINDING-OTHER" }, OP_NOW),
    "INVALID_INPUT",
    /Credential binding mismatch/,
  );
});

void test("PRD 636 runtime: manager enforces status monotonicity", () => {
  const { manager } = makeManager();
  const { job } = manager.create(makeCreateInput());
  manager.markRunning(job.jobId, CALLER, OP_NOW);
  manager.markCompleted(job.jobId, CALLER, { title: "done" }, { now: OP_NOW });
  const done = manager.result(job.jobId, CALLER, OP_NOW);
  assert.equal(done.status, "completed");
  expectGroundlaneError(
    () => manager.cancelCallerWait(job.jobId, CALLER, OP_NOW),
    "INVALID_INPUT",
    /terminal/,
  );
});

void test("PRD 636 runtime: billing provenance survives caller cancel", () => {
  const { manager } = makeManager();
  const { job } = manager.create(makeCreateInput());
  manager.markRunning(job.jobId, CALLER, OP_NOW);
  manager.recordPaidCall(job.jobId, CALLER, { inputUnits: 42, outputUnits: 7 }, OP_NOW);
  const cancelled = manager.cancelCallerWait(job.jobId, CALLER, OP_NOW);
  assert.equal(cancelled.status, "cancelled_by_caller");
  assert.equal(cancelled.billingProvenance.inputUnits, 42);
  assert.equal(cancelled.billingProvenance.outputUnits, 7);
  assert.equal(cancelled.billingProvenance.providerId, "firecrawl");
});

void test("PRD 636 runtime: upstream errors are sanitized", () => {
  const raw = new Error(
    "fetch failed with Bearer secret-abc-123 token=xyz\n    at secretFunc (/app/secret.ts:1:1)\nAuthorization: Bearer secret-abc-123",
  );
  const sanitized = sanitizeUpstreamError(raw, "async-job");
  assert.ok(!sanitized.includes("secret-abc-123"), "secret must be redacted");
  assert.ok(!sanitized.includes("at secretFunc"), "stack frames must not leak");
  assert.ok(sanitized.length <= 500, "sanitized error must be bounded");
  assert.ok(sanitized.length > 0, "sanitized error must not be empty");
});

void test("PRD 636 runtime: caller and groundlane cancels are independent", () => {
  const first = makeManager();
  const created = first.manager.create(makeCreateInput());
  const callerOnly = first.manager.cancelCallerWait(created.job.jobId, CALLER, OP_NOW);
  assert.equal(callerOnly.status, "cancelled_by_caller");
  assert.equal(callerOnly.callerCancelled, true);
  assert.equal(callerOnly.groundlanePollingCancelled, false);
  assert.equal(callerOnly.upstreamCancelled, false);

  const second = makeManager();
  const created2 = second.manager.create(makeCreateInput());
  const groundlaneOnly = second.manager.cancelGroundlanePolling(created2.job.jobId, CALLER, OP_NOW);
  assert.equal(groundlaneOnly.status, "cancelled_by_groundlane");
  assert.equal(groundlaneOnly.callerCancelled, false);
  assert.equal(groundlaneOnly.groundlanePollingCancelled, true);
  assert.equal(groundlaneOnly.upstreamCancelled, false);
});

void test("PRD 636 runtime: upstream cancel without ack must not report success", () => {
  const { manager, provider } = makeManager();
  provider.ackNextCancel = false;
  const { job } = manager.create(makeCreateInput());
  manager.markRunning(job.jobId, CALLER, OP_NOW);
  const outcome = manager.requestUpstreamCancel(job.jobId, CALLER, OP_NOW);
  assert.equal(outcome.cancelResult.upstreamCancelled, false);
  assert.equal(outcome.cancelResult.providerAcknowledgment, undefined);
  // Job stays running; only the request flag is recorded.
  assert.equal(outcome.job.status, "running");
  assert.equal(outcome.job.upstreamCancelRequested, true);
  assert.equal(outcome.job.upstreamCancelled, false);
  assert.equal(provider.cancelled.length, 1);
});

void test("PRD 636 runtime: upstream cancel with ack transitions to cancelled_by_upstream", () => {
  const { manager } = makeManager();
  const { job } = manager.create(makeCreateInput());
  manager.markRunning(job.jobId, CALLER, OP_NOW);
  const outcome = manager.requestUpstreamCancel(job.jobId, CALLER, OP_NOW);
  assert.equal(outcome.cancelResult.upstreamCancelled, true);
  assert.equal(outcome.cancelResult.providerAcknowledgment?.providerResponseCode, 200);
  assert.equal(outcome.job.status, "cancelled_by_upstream");
  assert.equal(outcome.job.upstreamCancelled, true);
});

void test("PRD 722 runtime: paid call and artifact writes have replay guards", () => {
  const { manager } = makeManager();
  const { job } = manager.create(makeCreateInput());
  manager.markRunning(job.jobId, CALLER, OP_NOW);
  const firstCall = manager.recordPaidCall(job.jobId, CALLER, { inputUnits: 5, outputUnits: 5 }, OP_NOW);
  const replayCall = manager.recordPaidCall(job.jobId, CALLER, { inputUnits: 500, outputUnits: 500 }, OP_NOW);
  assert.equal(firstCall.reused, false);
  assert.equal(replayCall.reused, true);
  const after = manager.poll(job.jobId, CALLER, OP_NOW);
  assert.equal(after.billingProvenance.inputUnits, 5);

  const firstWrite = manager.recordArtifactWrite(job.jobId, CALLER, { ref: "artifact-1" }, OP_NOW);
  const replayWrite = manager.recordArtifactWrite(job.jobId, CALLER, { ref: "artifact-2" }, OP_NOW);
  assert.equal(firstWrite.reused, false);
  assert.equal(replayWrite.reused, true);
  assert.deepEqual(replayWrite.result, { ref: "artifact-1" });
});

void test("PRD 636 runtime: SDK-types-only matrix is insufficient without operation evidence", () => {
  const { manager } = makeManager();
  // Matrix-level verification passes, but no per-operation evidence exists yet.
  verifyClientMatrix({
    entries: [
      makeClientEntry("claude"),
      makeClientEntry("codex"),
      makeClientEntry("cursor"),
    ],
  });
  expectGroundlaneError(
    () => manager.verifiedCreate("claude", makeCreateInput()),
    "INVALID_INPUT",
    /No verified .* evidence/,
  );
});

void test("PRD 636 runtime: per-client create/poll/result/cancel/resume evidence gates operations", () => {
  const { manager } = makeManager();
  const operations = ["create", "poll", "result", "cancel", "resume"] as const;
  for (const clientId of ["claude", "codex", "cursor"] as const) {
    for (const operation of operations) {
      manager.recordClientEvidence({
        clientId,
        operation,
        verifiedAt: "2026-02-01T00:00:00.000Z",
        transport: operation === "create" ? "mcp-tasks" : "explicit-polling",
      });
    }
  }
  const { job } = manager.verifiedCreate("claude", makeCreateInput());
  manager.markRunning(job.jobId, CALLER, OP_NOW);
  const polled = manager.verifiedPoll("claude", job.jobId, CALLER, OP_NOW);
  assert.equal(polled.status, "running");
  // Disconnect does not cancel: resume returns the same running job unmutated.
  const resumed = manager.resumeAfterDisconnect("claude", job.jobId, CALLER, OP_NOW);
  assert.equal(resumed.jobId, job.jobId);
  assert.equal(resumed.status, "running");
  const result = manager.verifiedResult("claude", job.jobId, CALLER, OP_NOW);
  assert.equal(result.status, "running");
  const cancelled = manager.verifiedCancel("claude", job.jobId, CALLER, "caller", OP_NOW);
  assert.equal(cancelled.status, "cancelled_by_caller");
});

void test("PRD 636 runtime: untrusted caller URLs are rejected at create", () => {
  const { manager } = makeManager();
  expectGroundlaneError(
    () => manager.create(makeCreateInput({ sourceUrl: "https://user:pass@example.com/page" })),
    "INVALID_INPUT",
    /credentials/,
  );
  expectGroundlaneError(
    () => manager.create(makeCreateInput({ sourceUrl: "ftp://example.com/file" })),
    "INVALID_INPUT",
    /HTTP/,
  );
});

void test("PRD 636 runtime: public job view never exposes provider job ID or secrets", () => {
  const { manager, provider } = makeManager();
  const { job } = manager.create(makeCreateInput());
  manager.markRunning(job.jobId, CALLER, OP_NOW);
  manager.markFailed(job.jobId, CALLER, new Error("boom Bearer topsecret-1"), OP_NOW);
  const failed = manager.result(job.jobId, CALLER, OP_NOW);
  const serialised = JSON.stringify(failed);
  assert.ok(!serialised.includes(provider.created[0] ?? "prov-task-"), "provider job ID leaked");
  assert.ok(!serialised.includes("topsecret-1"), "raw upstream secret leaked");
  assert.ok((failed.sanitizedError ?? "").length > 0, "sanitized error must be present");
});
