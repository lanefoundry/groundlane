import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DERIVED_INDEX_POLICY,
  MAX_INLINE_BYTES,
  mapBackendFailureToState,
  resolveCancelAcknowledgment,
  resolveEnrollmentExpiry,
  revokeEnrollment,
  validateArtifactWriteNotDuplicated,
  validateCorpusIdentity,
  validateDeletionStatus,
  validateDurableArtifactRef,
  validateDurableState,
  validateEnrollmentExpiry,
  validatePaidCallNotDuplicated,
  validateProviderTaskNotDuplicated,
  validateReEnroll,
  validateRetryIdempotency,
  validateSearchResultLabeling,
  verifyManifestStableAfterRebuild,
  type CorpusEnrollment,
  type CorpusIdentity,
  type CorpusLifecycleOperation,
  type CorpusManifest,
  type CorpusSourceManifestEntry,
  type CorpusSourceRecord,
  type CorpusState,
  type DeletionStatus,
  type DurableArtifactRef,
  type DurableStatePolicy,
  type RetentionPolicy,
  type RetryIdempotencyGuard,
  type SearchResultProvenance,
} from "../../src/core/corpus-contract.js";
import {
  CorpusStore,
  IdempotencyStore,
  InMemoryArtifactStorageBackend,
  InMemoryCorpusBackend,
  InMemoryDurableStateStore,
  PUBLIC_WEB_TOOL_FAMILY,
  SCOPED_CORPUS_TOOL_FAMILY,
  createDurableArtifact,
  fakePublicWebSearch,
  resolveSearchToolFamily,
  resolveStorageBackendName,
  resolveUpstreamCancel,
  type CallerPrincipal,
  type CorpusRetentionCaps,
  type EnrollSourceInput,
} from "../../src/core/corpus-runtime.js";
import {
  getDocumentPolicyView,
  resolveSectionExpiry,
} from "../../src/core/document-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRetentionPolicy(overrides?: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    operator: null,
    project: null,
    corpus: null,
    source: null,
    minimumBoundMs: 3600_000,
    ...overrides,
  };
}

function makeSourceRecord(overrides?: Partial<CorpusSourceRecord>): CorpusSourceRecord {
  return {
    sourceId: "src-001",
    corpusId: "corpus-001",
    contentHash: "hash-abc",
    enrolledAt: "2026-01-15T00:00:00Z",
    lifecycle: "enrolled",
    cacheBindings: ["cache-1", "cache-2"],
    ...overrides,
  };
}

function makeEnrollment(overrides?: Partial<CorpusEnrollment>): CorpusEnrollment {
  return {
    sourceId: "src-001",
    corpusId: "corpus-001",
    enrolledAt: "2026-01-15T00:00:00Z",
    expiresAt: "2026-12-31T23:59:59Z",
    retentionPolicy: makeRetentionPolicy(),
    sourceRecord: makeSourceRecord(),
    ...overrides,
  };
}

function makeManifestEntry(overrides?: Partial<CorpusSourceManifestEntry>): CorpusSourceManifestEntry {
  return {
    sourceId: "src-001",
    contentHash: "hash-abc",
    acl: ["role:reader"],
    retentionPolicy: "90d",
    deletionPolicy: "on_expiry",
    lifecycleProvenance: "groundlane",
    citationProvenance: "original",
    backendProvenance: "internal",
    ...overrides,
  };
}

function makeManifest(overrides?: Partial<CorpusManifest>): CorpusManifest {
  return {
    corpusId: "corpus-001",
    sources: [makeManifestEntry()],
    updatedAt: "2026-01-15T00:00:00Z",
    ...overrides,
  };
}

function makeDurableRef(overrides?: Partial<DurableArtifactRef>): DurableArtifactRef {
  return {
    tenantId: "tenant-001",
    ownerId: "owner-001",
    contentHash: "hash-abc",
    byteSize: 1024,
    retentionPolicy: "90d",
    expiresAt: "2026-12-31T23:59:59Z",
    deletionPolicy: "on_expiry",
    ...overrides,
  };
}

function makeRetryGuard(overrides?: Partial<RetryIdempotencyGuard>): RetryIdempotencyGuard {
  return {
    idempotencyKey: "idem-001",
    previousAttemptId: null,
    providerTaskCreated: false,
    paidCallCompleted: false,
    artifactWriteCompleted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 675: Corpus enrollment
// ---------------------------------------------------------------------------

void test("PRD 675: default enrollment is persistent (null expiresAt)", () => {
  const expiry = resolveEnrollmentExpiry(null, null, null, null, null);
  assert.equal(expiry, null);
});

void test("PRD 675: expiry picks minimum of all caps", () => {
  const expiry = resolveEnrollmentExpiry(
    "2026-12-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
    null,
    "2026-03-01T00:00:00.000Z",
  );
  assert.equal(expiry, "2026-03-01T00:00:00.000Z");
});

void test("PRD 675: expiry picks caller when it is earliest", () => {
  const expiry = resolveEnrollmentExpiry(
    "2026-01-15T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
    null,
    null,
    null,
  );
  assert.equal(expiry, "2026-01-15T00:00:00.000Z");
});

void test("PRD 675: below-minimum rejected (not extended)", () => {
  const now = new Date("2026-01-15T00:00:00Z");
  const minimumBoundMs = 86_400_000; // 1 day
  // Expiry is only 1 hour from now, below minimum of 1 day
  assert.throws(
    () => validateEnrollmentExpiry("2026-01-15T01:00:00Z", minimumBoundMs, now),
    { message: /below minimum bound/ },
  );
});

void test("PRD 675: above-minimum accepted", () => {
  const now = new Date("2026-01-15T00:00:00Z");
  const minimumBoundMs = 3600_000; // 1 hour
  // Expiry is 1 day from now, above minimum of 1 hour
  assert.doesNotThrow(
    () => validateEnrollmentExpiry("2026-01-16T00:00:00Z", minimumBoundMs, now),
  );
});

void test("PRD 675: persistent enrollment always valid for minimum check", () => {
  const now = new Date("2026-01-15T00:00:00Z");
  assert.doesNotThrow(
    () => validateEnrollmentExpiry(null, 86_400_000, now),
  );
});

void test("PRD 675: re-enroll doesn't extend expiry", () => {
  const existing = makeEnrollment({ expiresAt: "2026-06-01T00:00:00Z" });
  // Try to extend to a later date
  assert.throws(
    () => validateReEnroll(existing, "2026-12-01T00:00:00Z"),
    { message: /cannot extend expiry/ },
  );
});

void test("PRD 675: re-enroll with earlier or same expiry accepted", () => {
  const existing = makeEnrollment({ expiresAt: "2026-06-01T00:00:00Z" });
  assert.doesNotThrow(() => validateReEnroll(existing, "2026-03-01T00:00:00Z"));
  assert.doesNotThrow(() => validateReEnroll(existing, "2026-06-01T00:00:00Z"));
});

void test("PRD 675: re-enroll from finite to persistent rejected", () => {
  const existing = makeEnrollment({ expiresAt: "2026-06-01T00:00:00Z" });
  assert.throws(
    () => validateReEnroll(existing, null),
    { message: /cannot extend expiry from finite to persistent/ },
  );
});

void test("PRD 675: delete revokes access", () => {
  const enrollment = makeEnrollment();
  const result = revokeEnrollment(enrollment);
  assert.equal(result.enrollment.sourceRecord.lifecycle, "deleted");
});

void test("PRD 675: delete invalidates cache bindings", () => {
  const enrollment = makeEnrollment({
    sourceRecord: makeSourceRecord({ cacheBindings: ["cache-1", "cache-2", "cache-3"] }),
  });
  const result = revokeEnrollment(enrollment);
  assert.deepEqual(result.cacheBindingsInvalidated, ["cache-1", "cache-2", "cache-3"]);
  assert.deepEqual(result.enrollment.sourceRecord.cacheBindings, []);
});

void test("PRD 675: enrollment creates source record (not just ArtifactRef)", () => {
  const enrollment = makeEnrollment();
  // Source record exists and is separate from ArtifactRef
  assert.ok(enrollment.sourceRecord);
  assert.equal(enrollment.sourceRecord.sourceId, "src-001");
  assert.equal(enrollment.sourceRecord.corpusId, "corpus-001");
  assert.equal(enrollment.sourceRecord.lifecycle, "enrolled");
  assert.ok(enrollment.sourceRecord.contentHash);
});

// ---------------------------------------------------------------------------
// PRD 743: Durable job retry idempotency
// ---------------------------------------------------------------------------

void test("PRD 743: retry with same key returns previous result", () => {
  const guard = makeRetryGuard({ previousAttemptId: "attempt-001" });
  const result = validateRetryIdempotency(guard, { data: "previous" });
  assert.equal(result.reused, true);
  assert.deepEqual(result.result, { data: "previous" });
});

void test("PRD 743: first attempt returns no previous result", () => {
  const guard = makeRetryGuard({ previousAttemptId: null });
  const result = validateRetryIdempotency(guard, null);
  assert.equal(result.reused, false);
  assert.equal(result.result, null);
});

void test("PRD 743: retry doesn't duplicate provider task", () => {
  const guard = makeRetryGuard({
    previousAttemptId: "attempt-001",
    providerTaskCreated: true,
  });
  assert.throws(
    () => validateProviderTaskNotDuplicated(guard),
    { message: /already created/ },
  );
});

void test("PRD 743: first attempt allows provider task creation", () => {
  const guard = makeRetryGuard({ previousAttemptId: null, providerTaskCreated: false });
  assert.doesNotThrow(() => validateProviderTaskNotDuplicated(guard));
});

void test("PRD 743: retry doesn't duplicate paid call", () => {
  const guard = makeRetryGuard({
    previousAttemptId: "attempt-001",
    paidCallCompleted: true,
  });
  assert.throws(
    () => validatePaidCallNotDuplicated(guard),
    { message: /already completed.*re-bill/ },
  );
});

void test("PRD 743: retry doesn't duplicate artifact write", () => {
  const guard = makeRetryGuard({
    previousAttemptId: "attempt-001",
    artifactWriteCompleted: true,
  });
  assert.throws(
    () => validateArtifactWriteNotDuplicated(guard),
    { message: /already completed.*duplicate/ },
  );
});

void test("PRD 743: cancel without acknowledgment returns uncertain status", () => {
  const result = resolveCancelAcknowledgment(true, false);
  assert.equal(result.status, "uncertain");
  assert.equal(result.providerAcknowledged, false);
});

void test("PRD 743: cancel with acknowledgment returns confirmed status", () => {
  const result = resolveCancelAcknowledgment(true, true);
  assert.equal(result.status, "confirmed");
  assert.equal(result.providerAcknowledged, true);
});

void test("PRD 743: no cancel returns not_requested status", () => {
  const result = resolveCancelAcknowledgment(false, false);
  assert.equal(result.status, "not_requested");
});

// ---------------------------------------------------------------------------
// PRD 744: Durable state policy and storage-neutral ArtifactRef
// ---------------------------------------------------------------------------

void test("PRD 744: large content in durable state rejected", () => {
  const policy: DurableStatePolicy = { maxInlineBytes: MAX_INLINE_BYTES };
  assert.throws(
    () => validateDurableState(5000, policy),
    { message: /exceeds durable state limit/ },
  );
});

void test("PRD 744: small content in durable state accepted", () => {
  const policy: DurableStatePolicy = { maxInlineBytes: MAX_INLINE_BYTES };
  assert.doesNotThrow(() => validateDurableState(1000, policy));
});

void test("PRD 744: content exactly at limit accepted", () => {
  const policy: DurableStatePolicy = { maxInlineBytes: MAX_INLINE_BYTES };
  assert.doesNotThrow(() => validateDurableState(MAX_INLINE_BYTES, policy));
});

void test("PRD 744: ArtifactRef has no storage-specific fields", () => {
  const ref = makeDurableRef();
  const keys = Object.keys(ref);
  // Must not contain storageBackend, bucket, region, s3Path, r2Binding, etc.
  const storageFields = ["storageBackend", "bucket", "region", "s3Path", "r2Binding", "endpoint"];
  for (const field of storageFields) {
    assert.ok(!keys.includes(field), `ArtifactRef must not contain storage field "${field}"`);
  }
});

void test("PRD 744: all required ArtifactRef fields present", () => {
  const ref = makeDurableRef();
  assert.doesNotThrow(() => validateDurableArtifactRef(ref));
});

void test("PRD 744: ArtifactRef missing tenantId rejected", () => {
  assert.throws(
    () => validateDurableArtifactRef(makeDurableRef({ tenantId: "" })),
    { message: /tenantId is required/ },
  );
});

void test("PRD 744: ArtifactRef missing ownerId rejected", () => {
  assert.throws(
    () => validateDurableArtifactRef(makeDurableRef({ ownerId: "" })),
    { message: /ownerId is required/ },
  );
});

void test("PRD 744: ArtifactRef zero byteSize rejected", () => {
  assert.throws(
    () => validateDurableArtifactRef(makeDurableRef({ byteSize: 0 })),
    { message: /byteSize must be positive/ },
  );
});

void test("PRD 744: MAX_INLINE_BYTES is 4096", () => {
  assert.equal(MAX_INLINE_BYTES, 4096);
});

// ---------------------------------------------------------------------------
// PRD 745: Search source kind and provenance
// ---------------------------------------------------------------------------

void test("PRD 745: corpus result with sourceKind=public_web rejected", () => {
  const provenance: SearchResultProvenance = {
    sourceKind: "public_web",
    provider: "internal",
    backend: "vector-store",
    corpusBoundary: "corpus-001",
    freshnessTimestamp: "2026-01-15T00:00:00Z",
  };
  assert.throws(
    () => validateSearchResultLabeling(provenance),
    { message: /must not be labeled as public_web/ },
  );
});

void test("PRD 745: public result with no corpus boundary accepted", () => {
  const provenance: SearchResultProvenance = {
    sourceKind: "public_web",
    provider: "brave",
    backend: "brave-api",
    corpusBoundary: null,
    freshnessTimestamp: "2026-01-15T00:00:00Z",
  };
  assert.doesNotThrow(() => validateSearchResultLabeling(provenance));
});

void test("PRD 745: corpus result with proper boundary accepted", () => {
  const provenance: SearchResultProvenance = {
    sourceKind: "corpus",
    provider: "internal",
    backend: "vector-store",
    corpusBoundary: "corpus-001",
    freshnessTimestamp: "2026-01-15T00:00:00Z",
  };
  assert.doesNotThrow(() => validateSearchResultLabeling(provenance));
});

void test("PRD 745: each output has provenance fields", () => {
  const provenance: SearchResultProvenance = {
    sourceKind: "corpus",
    provider: "pinecone",
    backend: "pinecone-v3",
    corpusBoundary: "corpus-002",
    freshnessTimestamp: "2026-01-15T12:00:00Z",
  };
  assert.ok(provenance.sourceKind);
  assert.ok(provenance.provider);
  assert.ok(provenance.backend);
  assert.ok(provenance.corpusBoundary);
  assert.ok(provenance.freshnessTimestamp);
});

// ---------------------------------------------------------------------------
// PRD 746: Corpus lifecycle contract
// ---------------------------------------------------------------------------

void test("PRD 746: each lifecycle operation exists", () => {
  const ops: CorpusLifecycleOperation[] = [
    "create",
    "enroll_source",
    "update",
    "resync",
    "remove_source",
    "status",
    "search",
    "delete",
  ];
  assert.equal(new Set(ops).size, 8);
});

void test("PRD 746: identity doesn't expose backend ID (index prefix)", () => {
  const identity: CorpusIdentity = { corpusId: "idx-12345", displayName: "My Corpus" };
  assert.throws(
    () => validateCorpusIdentity(identity),
    { message: /backend internal ID/ },
  );
});

void test("PRD 746: identity doesn't expose backend ID (job prefix)", () => {
  const identity: CorpusIdentity = { corpusId: "job-99999", displayName: "My Corpus" };
  assert.throws(
    () => validateCorpusIdentity(identity),
    { message: /backend internal ID/ },
  );
});

void test("PRD 746: identity doesn't expose backend ID (vs_ prefix)", () => {
  const identity: CorpusIdentity = { corpusId: "vs_abc123", displayName: "My Corpus" };
  assert.throws(
    () => validateCorpusIdentity(identity),
    { message: /backend internal ID/ },
  );
});

void test("PRD 746: opaque Groundlane identity accepted", () => {
  const identity: CorpusIdentity = { corpusId: "gl-corpus-abc123", displayName: "My Corpus" };
  assert.doesNotThrow(() => validateCorpusIdentity(identity));
});

void test("PRD 746: incomplete deletion not reported as complete", () => {
  const status: DeletionStatus = {
    derivedIndexDeleted: true,
    artifactDeleted: false,
    isComplete: true,
  };
  assert.throws(
    () => validateDeletionStatus(status),
    { message: /cannot be reported as complete/ },
  );
});

void test("PRD 746: complete deletion accepted", () => {
  const status: DeletionStatus = {
    derivedIndexDeleted: true,
    artifactDeleted: true,
    isComplete: true,
  };
  assert.doesNotThrow(() => validateDeletionStatus(status));
});

void test("PRD 746: incomplete deletion with isComplete=false accepted", () => {
  const status: DeletionStatus = {
    derivedIndexDeleted: true,
    artifactDeleted: false,
    isComplete: false,
  };
  assert.doesNotThrow(() => validateDeletionStatus(status));
});

void test("PRD 746: partial failure mapped to degraded state", () => {
  assert.equal(mapBackendFailureToState(true, false), "degraded");
  assert.equal(mapBackendFailureToState(false, true), "degraded");
  assert.equal(mapBackendFailureToState(false, false), "degraded");
});

void test("PRD 746: healthy backend maps to active state", () => {
  assert.equal(mapBackendFailureToState(true, true), "active");
});

void test("PRD 746: all corpus states are distinct", () => {
  const states: CorpusState[] = ["active", "syncing", "degraded", "deleting", "deleted"];
  assert.equal(new Set(states).size, 5);
});

// ---------------------------------------------------------------------------
// PRD 747: Corpus manifest as contract truth
// ---------------------------------------------------------------------------

void test("PRD 747: manifest is the truth source with all fields", () => {
  const manifest = makeManifest();
  assert.ok(manifest.corpusId);
  assert.ok(manifest.sources.length > 0);
  const entry = manifest.sources[0];
  assert.ok(entry);
  assert.ok(entry.sourceId);
  assert.ok(entry.contentHash);
  assert.ok(entry.acl.length > 0);
  assert.ok(entry.retentionPolicy);
  assert.ok(entry.deletionPolicy);
  assert.ok(entry.lifecycleProvenance);
  assert.ok(entry.citationProvenance);
  assert.ok(entry.backendProvenance);
});

void test("PRD 747: derived index flags all false for truth fields", () => {
  assert.equal(DERIVED_INDEX_POLICY.isRebuildable, true);
  assert.equal(DERIVED_INDEX_POLICY.isIdentityTruth, false);
  assert.equal(DERIVED_INDEX_POLICY.isAuthorizationTruth, false);
  assert.equal(DERIVED_INDEX_POLICY.isRetentionTruth, false);
  assert.equal(DERIVED_INDEX_POLICY.isDeletionTruth, false);
});

void test("PRD 747: index rebuild doesn't change manifest identity", () => {
  const before = makeManifest();
  const after = makeManifest(); // Same content after rebuild
  assert.doesNotThrow(() => verifyManifestStableAfterRebuild(before, after));
});

void test("PRD 747: index rebuild with changed identity rejected", () => {
  const before = makeManifest();
  const after = makeManifest({ corpusId: "corpus-002" });
  assert.throws(
    () => verifyManifestStableAfterRebuild(before, after),
    { message: /identity changed after index rebuild/ },
  );
});

void test("PRD 747: index rebuild with changed source identity rejected", () => {
  const before = makeManifest({
    sources: [makeManifestEntry({ sourceId: "src-001" })],
  });
  const after = makeManifest({
    sources: [makeManifestEntry({ sourceId: "src-002" })],
  });
  assert.throws(
    () => verifyManifestStableAfterRebuild(before, after),
    { message: /Source identity changed/ },
  );
});

void test("PRD 747: index rebuild with changed source count rejected", () => {
  const before = makeManifest({
    sources: [makeManifestEntry()],
  });
  const after = makeManifest({
    sources: [makeManifestEntry(), makeManifestEntry({ sourceId: "src-002" })],
  });
  assert.throws(
    () => verifyManifestStableAfterRebuild(before, after),
    { message: /Source count changed/ },
  );
});

void test("PRD 747: index rebuild with changed content hash rejected", () => {
  const before = makeManifest({
    sources: [makeManifestEntry({ contentHash: "hash-abc" })],
  });
  const after = makeManifest({
    sources: [makeManifestEntry({ contentHash: "hash-xyz" })],
  });
  assert.throws(
    () => verifyManifestStableAfterRebuild(before, after),
    { message: /content hash changed/ },
  );
});

// ---------------------------------------------------------------------------
// Runtime helpers (PRD 665/666/667/723/724/725/726): corpus-runtime +
// document-policy. Failing-first coverage for the new runtime modules.
// ---------------------------------------------------------------------------

function makeCaller(overrides?: Partial<CallerPrincipal>): CallerPrincipal {
  return {
    principalId: "owner-001",
    roles: ["role:reader", "role:writer"],
    ...overrides,
  };
}

function makeCaps(overrides?: Partial<CorpusRetentionCaps>): CorpusRetentionCaps {
  return {
    operatorCapExpiresAt: null,
    projectCapExpiresAt: null,
    corpusCapExpiresAt: null,
    sourceCapExpiresAt: null,
    minimumBoundMs: 3600_000,
    ...overrides,
  };
}

function makeEnrollInput(overrides?: Partial<EnrollSourceInput>): EnrollSourceInput {
  return {
    sourceId: "src-001",
    contentHash: "hash-abc",
    acl: ["role:reader", "role:writer"],
    retentionPolicy: "90d",
    deletionPolicy: "on_expiry",
    lifecycleProvenance: "groundlane-enroll",
    citationProvenance: "original",
    backendProvenance: "mem-fake-v1",
    callerExpiresAt: "2026-12-31T23:59:59.000Z",
    cacheBindings: ["cache-1"],
    ...overrides,
  };
}

function makeStore(nowMs = Date.parse("2026-01-15T00:00:00Z")): {
  store: CorpusStore;
  backend: InMemoryCorpusBackend;
} {
  const backend = new InMemoryCorpusBackend();
  const store = new CorpusStore(backend, () => new Date(nowMs));
  return { store, backend };
}

void test("PRD 665/725: create corpus uses opaque Groundlane ID, never backend ID", () => {
  const { store, backend } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  assert.match(view.corpusId, /^gl-corpus-/u);
  assert.equal(view.state, "active");
  assert.equal(view.sourceCount, 0);
  // Backend-internal index key must not leak into the public view.
  assert.ok(!Object.keys(view).some((k) => /backend|index|job/iu.test(k)));
  assert.ok(!/^idx[-_]/iu.test(view.corpusId));
  assert.equal(backend.internalIndexKeyCount(), 1);
});

void test("PRD 665/725: enroll creates corpus-owned source lifecycle record", () => {
  const { store } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  const enrollment = store.enrollSource(view.corpusId, makeEnrollInput(), makeCaller(), makeCaps());
  assert.equal(enrollment.sourceId, "src-001");
  assert.equal(enrollment.corpusId, view.corpusId);
  assert.equal(enrollment.sourceRecord.lifecycle, "enrolled");
  assert.equal(enrollment.sourceRecord.contentHash, "hash-abc");
  assert.deepEqual(enrollment.sourceRecord.cacheBindings, ["cache-1"]);
  const status = store.corpusStatus(view.corpusId, makeCaller());
  assert.equal(status.sourceCount, 1);
});

void test("PRD 665/725: retention takes earliest of caller request and hard caps", () => {
  const { store } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  const enrollment = store.enrollSource(
    view.corpusId,
    makeEnrollInput({ callerExpiresAt: "2026-12-31T23:59:59.000Z" }),
    makeCaller(),
    makeCaps({ corpusCapExpiresAt: "2026-03-01T00:00:00.000Z" }),
  );
  assert.equal(enrollment.expiresAt, "2026-03-01T00:00:00.000Z");
});

void test("PRD 665/725: update (re-enroll) does not reset expiry", () => {
  const { store } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  const first = store.enrollSource(view.corpusId, makeEnrollInput(), makeCaller(), makeCaps());
  const updated = store.updateSource(
    view.corpusId,
    "src-001",
    { contentHash: "hash-def", citationProvenance: "re-crawled" },
    makeCaller(),
  );
  assert.equal(updated.expiresAt, first.expiresAt);
  assert.equal(updated.sourceRecord.contentHash, "hash-def");
});

void test("PRD 665/725: delete immediately revokes access and cache bindings", () => {
  const { store } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  store.enrollSource(view.corpusId, makeEnrollInput(), makeCaller(), makeCaps());
  const deletion = store.deleteCorpus(view.corpusId, makeCaller());
  assert.equal(deletion.isComplete, true);
  assert.equal(store.isCacheBindingHittable("cache-1"), false);
  const status = store.corpusStatus(view.corpusId, makeCaller());
  assert.equal(status.state, "deleted");
  assert.throws(
    () => store.searchCorpus(view.corpusId, "hello", makeCaller()),
    { message: /deleted|revoked|access/i },
  );
});

void test("PRD 665/725: backend partial failure maps to stable degraded state", () => {
  const { store, backend } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  backend.setIndexHealthy(view.corpusId, false);
  const status = store.corpusStatus(view.corpusId, makeCaller());
  assert.equal(status.state, "degraded");
});

void test("PRD 665/725: incomplete deletion never claims complete", () => {
  const { store, backend } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  store.enrollSource(view.corpusId, makeEnrollInput(), makeCaller(), makeCaps());
  backend.setFailDelete(true);
  const deletion = store.deleteCorpus(view.corpusId, makeCaller());
  assert.equal(deletion.isComplete, false);
  const status = store.corpusStatus(view.corpusId, makeCaller());
  assert.notEqual(status.state, "deleted");
});

void test("PRD 726: manifest is truth source, derived index rebuild keeps identity", () => {
  const { store } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  store.enrollSource(view.corpusId, makeEnrollInput(), makeCaller(), makeCaps());
  const before = store.corpusStatus(view.corpusId, makeCaller()).manifest;
  const after = store.rebuildDerivedIndex(view.corpusId, makeCaller());
  assert.doesNotThrow(() => verifyManifestStableAfterRebuild(before, after));
  const entry = after.sources[0];
  assert.ok(entry);
  assert.ok(entry.acl.length > 0);
  assert.ok(entry.retentionPolicy);
  assert.ok(entry.deletionPolicy);
  assert.ok(entry.lifecycleProvenance);
  assert.ok(entry.citationProvenance);
  assert.ok(entry.backendProvenance);
});

void test("PRD 725/726: ACL enforced on scoped search", () => {
  const { store } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  store.enrollSource(
    view.corpusId,
    makeEnrollInput({ acl: ["role:writer"] }),
    makeCaller(),
    makeCaps(),
  );
  assert.throws(
    () => store.searchCorpus(view.corpusId, "hello", makeCaller({ principalId: "intruder", roles: ["role:other"] })),
    { message: /access denied/i },
  );
  const response = store.searchCorpus(view.corpusId, "hello", makeCaller());
  assert.equal(response.results.length, 1);
});

void test("PRD 724: scoped corpus search uses its own tool family and provenance", () => {
  const { store } = makeStore();
  const view = store.createCorpus({
    displayName: "My Corpus",
    ownerId: "owner-001",
    tenantId: "tenant-001",
    callerExpiresAt: null,
    caps: makeCaps(),
  });
  store.enrollSource(view.corpusId, makeEnrollInput(), makeCaller(), makeCaps());
  const response = store.searchCorpus(view.corpusId, "hello", makeCaller());
  assert.equal(response.toolFamily, SCOPED_CORPUS_TOOL_FAMILY);
  assert.notEqual(response.toolFamily, PUBLIC_WEB_TOOL_FAMILY);
  const hit = response.results[0];
  assert.ok(hit);
  assert.equal(hit.provenance.sourceKind, "corpus");
  assert.equal(hit.provenance.corpusBoundary, view.corpusId);
  assert.ok(hit.provenance.provider);
  assert.ok(hit.provenance.backend);
  assert.ok(hit.provenance.freshnessTimestamp);
  assert.equal(resolveSearchToolFamily(hit.provenance.sourceKind), SCOPED_CORPUS_TOOL_FAMILY);
});

void test("PRD 724: public web fake result never carries a corpus boundary", () => {
  const response = fakePublicWebSearch("hello", "brave", "brave-api", new Date("2026-01-15T00:00:00Z"));
  assert.equal(response.toolFamily, PUBLIC_WEB_TOOL_FAMILY);
  const hit = response.results[0];
  assert.ok(hit);
  assert.equal(hit.provenance.sourceKind, "public_web");
  assert.equal(hit.provenance.corpusBoundary, null);
  assert.equal(resolveSearchToolFamily(hit.provenance.sourceKind), PUBLIC_WEB_TOOL_FAMILY);
});

void test("PRD 667: same idempotency key reuses result without re-executing effect", () => {
  const idempotency = new IdempotencyStore();
  let executions = 0;
  const effect = () => {
    executions += 1;
    return {
      result: "done",
      providerTaskCreated: true,
      paidCallCompleted: true,
      artifactWriteCompleted: true,
    };
  };
  const first = idempotency.run("key-001", "attempt-001", effect);
  assert.equal(first.reused, false);
  assert.equal(first.result, "done");
  const second = idempotency.run("key-001", "attempt-002", effect);
  assert.equal(second.reused, true);
  assert.equal(second.result, "done");
  assert.equal(executions, 1);
});

void test("PRD 667: retry that re-creates provider task / paid call / artifact write throws", () => {
  const idempotency = new IdempotencyStore();
  idempotency.recordUnfinishedAttempt("key-002", "attempt-001", {
    providerTaskCreated: true,
    paidCallCompleted: true,
    artifactWriteCompleted: true,
  });
  assert.throws(
    () => idempotency.run("key-002", "attempt-002", () => ({
      result: "again",
      providerTaskCreated: true,
      paidCallCompleted: false,
      artifactWriteCompleted: false,
    })),
    { message: /already created/ },
  );
  assert.throws(
    () => idempotency.run("key-002", "attempt-002", () => ({
      result: "again",
      providerTaskCreated: false,
      paidCallCompleted: true,
      artifactWriteCompleted: false,
    })),
    { message: /re-bill/ },
  );
  assert.throws(
    () => idempotency.run("key-002", "attempt-002", () => ({
      result: "again",
      providerTaskCreated: false,
      paidCallCompleted: false,
      artifactWriteCompleted: true,
    })),
    { message: /duplicate/ },
  );
});

void test("PRD 667: no provider acknowledgment never reports upstream cancel confirmed", () => {
  assert.equal(resolveUpstreamCancel(true, false).status, "uncertain");
  assert.equal(resolveUpstreamCancel(true, true).status, "confirmed");
  assert.equal(resolveUpstreamCancel(false, false).status, "not_requested");
});

void test("PRD 723: durable state store rejects large inline content", () => {
  const durable = new InMemoryDurableStateStore();
  assert.throws(
    () => durable.put({ key: "k1", inlineBytes: MAX_INLINE_BYTES + 1, ref: null }),
    { message: /exceeds durable state limit/ },
  );
  assert.doesNotThrow(
    () => durable.put({ key: "k1", inlineBytes: 128, ref: null }),
  );
});

void test("PRD 723/667: durable ArtifactRef is storage-neutral with tenant/owner binding", () => {
  const ref = createDurableArtifact({
    tenantId: "tenant-001",
    ownerId: "owner-001",
    contentHash: "hash-abc",
    byteSize: 1024,
    retentionPolicy: "90d",
    deletionPolicy: "on_expiry",
    expiresAt: "2026-12-31T23:59:59.000Z",
  });
  const keys = Object.keys(ref);
  for (const field of ["storageBackend", "bucket", "r2Binding", "endpoint"]) {
    assert.ok(!keys.includes(field));
  }
  assert.equal(ref.tenantId, "tenant-001");
  assert.equal(ref.ownerId, "owner-001");
  assert.equal(resolveStorageBackendName("cloudflare"), "r2");
  assert.equal(resolveStorageBackendName("local"), "in-memory-fake");
});

void test("PRD 723: storage backend enforces tenant/owner binding and content hash", () => {
  const storage = new InMemoryArtifactStorageBackend();
  const bytes = new TextEncoder().encode("hello corpus");
  const digest = "9b4b3a8a2d8b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";
  assert.throws(
    () => storage.storeBlob("tenant-001", "owner-001", digest, bytes),
    { message: /content hash mismatch/i },
  );
  // Round-trip through a caller-computed content hash.
  const realHash: string = createHash("sha256").update(bytes).digest("hex");
  storage.storeBlob("tenant-001", "owner-001", realHash, bytes);
  assert.deepEqual(
    Array.from(storage.loadBlob("tenant-001", "owner-001", realHash)),
    Array.from(bytes),
  );
  assert.throws(
    () => storage.loadBlob("tenant-002", "owner-001", realHash),
    { message: /not found or access denied/i },
  );
});

void test("PRD 666: policy view announces defaults, caps, and effective absolute expiry", () => {
  const nowMs = Date.parse("2026-01-15T00:00:00Z");
  const view = getDocumentPolicyView(nowMs);
  for (const section of [view.cache, view.upload, view.artifact, view.corpus]) {
    assert.ok(section.defaultTtlSeconds > 0);
    assert.ok(section.minTtlSeconds <= section.defaultTtlSeconds);
    assert.ok(section.defaultTtlSeconds <= section.maxTtlSeconds);
    assert.ok(section.effectiveExpiresAtMs > nowMs);
    assert.equal(
      section.effectiveExpiresAt,
      new Date(section.effectiveExpiresAtMs).toISOString(),
    );
  }
  assert.ok(view.upload.defaultTtlSeconds <= view.artifact.defaultTtlSeconds);
});

void test("PRD 666: relative and absolute expiry are mutually exclusive", () => {
  assert.throws(
    () => resolveSectionExpiry(
      { relativeTtlSeconds: 3600, absoluteExpiresAtMs: Date.parse("2026-01-16T00:00:00Z") },
      { defaultTtlSeconds: 900, minTtlSeconds: 60, maxTtlSeconds: 3600 },
      Date.parse("2026-01-15T00:00:00Z"),
    ),
    { message: /mutually exclusive/ },
  );
});

void test("PRD 666: out-of-bounds TTL is a validation error, never clamped", () => {
  const nowMs = Date.parse("2026-01-15T00:00:00Z");
  const bounds = { defaultTtlSeconds: 900, minTtlSeconds: 60, maxTtlSeconds: 3600 };
  assert.throws(
    () => resolveSectionExpiry({ relativeTtlSeconds: 7200 }, bounds, nowMs),
    { message: /exceeds maximum/ },
  );
  assert.throws(
    () => resolveSectionExpiry({ relativeTtlSeconds: 10 }, bounds, nowMs),
    { message: /below minimum/ },
  );
  const effective = resolveSectionExpiry({ relativeTtlSeconds: 600 }, bounds, nowMs);
  assert.equal(effective, nowMs + 600_000);
});
