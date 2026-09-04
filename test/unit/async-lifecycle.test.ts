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
} from "../../src/core/async-lifecycle.js";

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
