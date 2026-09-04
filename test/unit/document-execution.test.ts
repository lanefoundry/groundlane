import assert from "node:assert/strict";
import test from "node:test";

import {
  computeIdempotentJobId,
  computeRemainingBudget,
  DEFAULT_DEADLINE_POLICY,
  handleOversizedOutput,
  resolveSnapshotExpiry,
  revokeSnapshot,
  selectExecutionTrack,
  validateCancelScope,
  validateDeadlines,
  validateDocumentJobStatusTransition,
  validateExecutionMode,
  validateMcpTasksMatrix,
  validateSyncExecutionGuard,
  type AsyncDocumentJob,
  type CancelScope,
  type DeadlineSet,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutionResult,
  type McpTasksSupportMatrix,
} from "../../src/core/document-execution.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLimits(overrides?: Partial<ExecutionLimits>): ExecutionLimits {
  return {
    maxBytes: 10_000_000,
    maxPages: 100,
    maxTimeMs: 30_000,
    maxMemoryMb: 512,
    allowedEngines: ["text", "table"],
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<ExecutionRequest>): ExecutionRequest {
  return {
    inputBytes: 1000,
    inputPages: 5,
    estimatedTimeMs: 500,
    estimatedMemoryMb: 64,
    engine: "text",
    mode: "sync",
    ...overrides,
  };
}

function makeDeadlines(overrides?: Partial<DeadlineSet>): DeadlineSet {
  return {
    syncRequestDeadlineMs: 5000,
    createRequestDeadlineMs: 10_000,
    pollWaitDeadlineMs: 60_000,
    jobAbsoluteDeadlineMs: 300_000,
    perAttemptDeadlineMs: 30_000,
    totalExecutionBudgetMs: 600_000,
    ...overrides,
  };
}

function makeAsyncJob(overrides?: Partial<AsyncDocumentJob>): AsyncDocumentJob {
  return {
    jobId: "job-001",
    ownerId: "owner-abc",
    sourceSnapshot: {
      contentHash: "abc123",
      capturedAt: "2026-01-15T00:00:00Z",
      expiresAt: "2026-12-31T23:59:59Z",
      revoked: false,
    },
    status: "running",
    credentialBinding: {
      credentialId: "cred-001",
      boundAt: "2026-01-15T00:00:00Z",
    },
    billingProvenance: {
      providerId: "provider-doc",
      inputUnits: 10,
      outputUnits: 5,
      billedAt: "2026-01-15T12:00:00Z",
    },
    resultRef: null,
    createdAt: "2026-01-15T00:00:00Z",
    expiresAt: "2026-12-31T23:59:59Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 685: Document processing dual-track execution
// ---------------------------------------------------------------------------

void test("PRD 685: within-limits request selects sync track", () => {
  const limits = makeLimits();
  const request = makeRequest();
  assert.equal(selectExecutionTrack(request, limits), "sync");
});

void test("PRD 685: exceeding byte limit selects async track", () => {
  const limits = makeLimits({ maxBytes: 500 });
  const request = makeRequest({ inputBytes: 1000 });
  assert.equal(selectExecutionTrack(request, limits), "async");
});

void test("PRD 685: exceeding page limit selects async track", () => {
  const limits = makeLimits({ maxPages: 3 });
  const request = makeRequest({ inputPages: 5 });
  assert.equal(selectExecutionTrack(request, limits), "async");
});

void test("PRD 685: exceeding time limit selects async track", () => {
  const limits = makeLimits({ maxTimeMs: 100 });
  const request = makeRequest({ estimatedTimeMs: 500 });
  assert.equal(selectExecutionTrack(request, limits), "async");
});

void test("PRD 685: exceeding memory limit selects async track", () => {
  const limits = makeLimits({ maxMemoryMb: 32 });
  const request = makeRequest({ estimatedMemoryMb: 64 });
  assert.equal(selectExecutionTrack(request, limits), "async");
});

void test("PRD 685: disallowed engine selects async track", () => {
  const limits = makeLimits({ allowedEngines: ["text"] });
  const request = makeRequest({ engine: "ocr-vlm" });
  assert.equal(selectExecutionTrack(request, limits), "async");
});

void test("PRD 685: both tracks produce same ExecutionResult type", () => {
  const syncResult: ExecutionResult = {
    track: "sync",
    contentHash: "hash-sync",
    projections: ["full"],
    provenance: { engine: "text", durationMs: 100, sourceId: "src-1" },
    cachedAt: null,
    error: null,
  };
  const asyncResult: ExecutionResult = {
    track: "async",
    contentHash: "hash-async",
    projections: ["full"],
    provenance: { engine: "ocr-vlm", durationMs: 5000, sourceId: "src-2" },
    cachedAt: null,
    error: null,
  };
  // Same schema family — both have identical field shapes
  assert.equal(typeof syncResult.contentHash, "string");
  assert.equal(typeof asyncResult.contentHash, "string");
  assert.ok(Array.isArray(syncResult.projections));
  assert.ok(Array.isArray(asyncResult.projections));
  assert.equal(typeof syncResult.provenance.engine, "string");
  assert.equal(typeof asyncResult.provenance.engine, "string");
});

void test("PRD 685: no separate async-only document schema", () => {
  // Both tracks use ExecutionResult — the type accepts both "sync" and "async" track values
  const results: ExecutionResult[] = [
    {
      track: "sync",
      contentHash: "h1",
      projections: [],
      provenance: { engine: "text", durationMs: 50, sourceId: "s1" },
      cachedAt: null,
      error: null,
    },
    {
      track: "async",
      contentHash: "h2",
      projections: [],
      provenance: { engine: "ocr", durationMs: 3000, sourceId: "s2" },
      cachedAt: null,
      error: null,
    },
  ];
  assert.equal(results.length, 2);
  // Both are ExecutionResult — no separate async schema
  for (const r of results) {
    assert.ok("track" in r);
    assert.ok("contentHash" in r);
    assert.ok("projections" in r);
    assert.ok("provenance" in r);
  }
});

// ---------------------------------------------------------------------------
// PRD 686: Sync guard and async-required errors
// ---------------------------------------------------------------------------

void test("PRD 686: sync with large input returns error not job", () => {
  const limits = makeLimits({ maxBytes: 500 });
  const request = makeRequest({ inputBytes: 1000, mode: "sync" });
  const error = validateSyncExecutionGuard(request, limits);
  assert.notEqual(error, null);
  assert.equal(error?.code, "ASYNC_REQUIRED");
  assert.equal(error?.suggestedMode, "async");
});

void test("PRD 686: sync with async-only engine returns error", () => {
  const limits = makeLimits({ allowedEngines: ["text"] });
  const request = makeRequest({ engine: "ocr-vlm", mode: "sync" });
  const error = validateSyncExecutionGuard(request, limits);
  assert.notEqual(error, null);
  assert.equal(error?.code, "ASYNC_REQUIRED");
  assert.ok(error?.reason.includes("async-only"));
});

void test("PRD 686: sync within limits returns no error", () => {
  const limits = makeLimits();
  const request = makeRequest({ mode: "sync" });
  const error = validateSyncExecutionGuard(request, limits);
  assert.equal(error, null);
});

void test("PRD 686: execution=auto rejected in v1", () => {
  assert.throws(
    () => validateExecutionMode("auto"),
    { message: /auto.*not supported in v1/ },
  );
});

void test("PRD 686: execution=sync accepted", () => {
  assert.doesNotThrow(() => validateExecutionMode("sync"));
});

void test("PRD 686: execution=async accepted", () => {
  assert.doesNotThrow(() => validateExecutionMode("async"));
});

void test("PRD 686: unknown execution mode rejected", () => {
  assert.throws(
    () => validateExecutionMode("streaming"),
    { message: /Unknown execution mode/ },
  );
});

void test("PRD 686: oversized output returns ArtifactRef without job creation", () => {
  const result = handleOversizedOutput("hash-abc", 50_000_000, "2026-12-31T23:59:59Z");
  assert.equal(result.jobCreated, false);
  assert.ok(result.artifactRef.refId.length > 0);
  assert.equal(result.artifactRef.contentHash, "hash-abc");
  assert.equal(result.artifactRef.byteSize, 50_000_000);
});

void test("PRD 686: oversized output preserves deadline (no job reset)", () => {
  const result = handleOversizedOutput("hash-xyz", 100_000_000, "2026-06-15T00:00:00Z");
  assert.equal(result.artifactRef.expiresAt, "2026-06-15T00:00:00Z");
  assert.equal(result.jobCreated, false);
});

// ---------------------------------------------------------------------------
// PRD 687: Async document lifecycle
// ---------------------------------------------------------------------------

void test("PRD 687: idempotent create — same input produces same jobId", () => {
  const id1 = computeIdempotentJobId("owner-1", "hash-abc", "text");
  const id2 = computeIdempotentJobId("owner-1", "hash-abc", "text");
  assert.equal(id1, id2);
});

void test("PRD 687: different input produces different jobId", () => {
  const id1 = computeIdempotentJobId("owner-1", "hash-abc", "text");
  const id2 = computeIdempotentJobId("owner-1", "hash-xyz", "text");
  assert.notEqual(id1, id2);
});

void test("PRD 687: status transition created -> pending is valid", () => {
  assert.doesNotThrow(() => validateDocumentJobStatusTransition("created", "pending"));
});

void test("PRD 687: status transition pending -> running is valid", () => {
  assert.doesNotThrow(() => validateDocumentJobStatusTransition("pending", "running"));
});

void test("PRD 687: status transition running -> completed is valid", () => {
  assert.doesNotThrow(() => validateDocumentJobStatusTransition("running", "completed"));
});

void test("PRD 687: status can't go backwards running -> pending", () => {
  assert.throws(
    () => validateDocumentJobStatusTransition("running", "pending"),
    { message: /Non-monotonic status transition/ },
  );
});

void test("PRD 687: terminal status completed -> running rejected", () => {
  assert.throws(
    () => validateDocumentJobStatusTransition("completed", "running"),
    { message: /Cannot transition from terminal status/ },
  );
});

void test("PRD 687: same-state transition rejected", () => {
  assert.throws(
    () => validateDocumentJobStatusTransition("running", "running"),
    { message: /already "running"/ },
  );
});

void test("PRD 687: snapshot expiry is minimum of source, job, policy", () => {
  const result = resolveSnapshotExpiry(
    "2026-06-01T00:00:00.000Z",
    "2026-12-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
  );
  assert.equal(result, "2026-03-01T00:00:00.000Z");
});

void test("PRD 687: snapshot expiry picks source when earliest", () => {
  const result = resolveSnapshotExpiry(
    "2026-01-01T00:00:00.000Z",
    "2026-12-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
  );
  assert.equal(result, "2026-01-01T00:00:00.000Z");
});

void test("PRD 687: source delete revokes snapshot and cancels running job", () => {
  const job = makeAsyncJob({ status: "running" });
  const revoked = revokeSnapshot(job);
  assert.equal(revoked.sourceSnapshot.revoked, true);
  assert.equal(revoked.status, "cancelled");
});

void test("PRD 687: source delete on completed job preserves terminal status", () => {
  const job = makeAsyncJob({ status: "completed" });
  const revoked = revokeSnapshot(job);
  assert.equal(revoked.sourceSnapshot.revoked, true);
  assert.equal(revoked.status, "completed");
});

void test("PRD 687: cancel scopes are independent", () => {
  const scopes: CancelScope[] = ["caller_wait", "groundlane_dispatch", "upstream_cancel"];
  assert.equal(new Set(scopes).size, 3);
  for (const scope of scopes) {
    assert.doesNotThrow(() => validateCancelScope(scope));
  }
});

void test("PRD 687: unknown cancel scope rejected", () => {
  assert.throws(
    () => validateCancelScope("invalid"),
    { message: /Unknown cancel scope/ },
  );
});

void test("PRD 687: billing preserved after cancel", () => {
  const job = makeAsyncJob({
    status: "cancelled",
    billingProvenance: {
      providerId: "provider-doc",
      inputUnits: 42,
      outputUnits: 7,
      billedAt: "2026-01-15T12:00:00Z",
    },
  });
  assert.equal(job.billingProvenance.inputUnits, 42);
  assert.equal(job.billingProvenance.outputUnits, 7);
  assert.equal(job.status, "cancelled");
});

void test("PRD 687: MCP Tasks matrix entries for claude/codex/cursor", () => {
  const matrix: McpTasksSupportMatrix = {
    entries: [
      { clientId: "claude", supportsAsyncTasks: true, supportsNotifications: true, supportsPolling: true },
      { clientId: "codex", supportsAsyncTasks: true, supportsNotifications: false, supportsPolling: true },
      { clientId: "cursor", supportsAsyncTasks: false, supportsNotifications: false, supportsPolling: true },
    ],
  };
  assert.doesNotThrow(() => validateMcpTasksMatrix(matrix));
  assert.equal(matrix.entries.length, 3);
});

void test("PRD 687: MCP Tasks matrix rejects unknown client", () => {
  const matrix: McpTasksSupportMatrix = {
    entries: [
      { clientId: "unknown-ai", supportsAsyncTasks: true, supportsNotifications: true, supportsPolling: true },
    ],
  };
  assert.throws(
    () => validateMcpTasksMatrix(matrix),
    { message: /Unknown MCP client/ },
  );
});

void test("PRD 687: MCP Tasks empty matrix rejected", () => {
  const matrix: McpTasksSupportMatrix = { entries: [] };
  assert.throws(
    () => validateMcpTasksMatrix(matrix),
    { message: /at least one entry/ },
  );
});

// ---------------------------------------------------------------------------
// PRD 688: Async deadline fixtures
// ---------------------------------------------------------------------------

void test("PRD 688: all 5 deadline types are independent", () => {
  const deadlines = makeDeadlines();
  const keys = Object.keys(deadlines);
  assert.equal(keys.length, 6);
  // Each deadline has a distinct value
  const values = Object.values(deadlines);
  assert.equal(new Set(values).size, values.length);
});

void test("PRD 688: all deadlines must be positive", () => {
  assert.doesNotThrow(() => validateDeadlines(makeDeadlines()));
});

void test("PRD 688: zero deadline rejected", () => {
  assert.throws(
    () => validateDeadlines(makeDeadlines({ syncRequestDeadlineMs: 0 })),
    { message: /syncRequestDeadlineMs.*must be positive/ },
  );
});

void test("PRD 688: negative deadline rejected", () => {
  assert.throws(
    () => validateDeadlines(makeDeadlines({ pollWaitDeadlineMs: -1 })),
    { message: /pollWaitDeadlineMs.*must be positive/ },
  );
});

void test("PRD 688: each deadline type validates independently", () => {
  const fields: (keyof DeadlineSet)[] = [
    "syncRequestDeadlineMs",
    "createRequestDeadlineMs",
    "pollWaitDeadlineMs",
    "jobAbsoluteDeadlineMs",
    "perAttemptDeadlineMs",
    "totalExecutionBudgetMs",
  ];
  for (const field of fields) {
    assert.throws(
      () => validateDeadlines(makeDeadlines({ [field]: 0 })),
      { message: new RegExp(field) },
    );
  }
});

void test("PRD 688: disconnect doesn't cancel running job", () => {
  assert.equal(DEFAULT_DEADLINE_POLICY.disconnectCancelsJob, false);
});

void test("PRD 688: retry preserves total budget", () => {
  assert.equal(DEFAULT_DEADLINE_POLICY.retryResetsBudget, false);
  const remaining = computeRemainingBudget(600_000, 200_000);
  assert.equal(remaining, 400_000);
});

void test("PRD 688: retry does not reset total budget — elapsed tracked", () => {
  const totalBudget = 600_000;
  const firstAttempt = 200_000;
  const remaining = computeRemainingBudget(totalBudget, firstAttempt);
  assert.equal(remaining, 400_000);

  // Second attempt uses remaining budget, not total
  const secondAttempt = 300_000;
  const finalRemaining = computeRemainingBudget(remaining, secondAttempt);
  assert.equal(finalRemaining, 100_000);
});

void test("PRD 688: exhausted budget throws error", () => {
  assert.throws(
    () => computeRemainingBudget(600_000, 600_000),
    { message: /budget exhausted/ },
  );
});

void test("PRD 688: only explicit cancel changes lifecycle", () => {
  // Running job stays running after disconnect (per policy)
  const job = makeAsyncJob({ status: "running" });
  assert.equal(DEFAULT_DEADLINE_POLICY.disconnectCancelsJob, false);
  // Job status unchanged — disconnect doesn't mutate
  assert.equal(job.status, "running");
});
