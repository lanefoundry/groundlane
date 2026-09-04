import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_LIFECYCLE_CLEANUP_WINDOW_MS,
  ArtifactLifecycleStore,
  InMemoryArtifactStorage,
} from "../../src/core/artifact-lifecycle.js";
import type { ArtifactRef } from "../../src/core/upload-intent.js";

const NOW = 1_700_000_000_000;

function makeVerifiedRef(overrides?: Partial<ArtifactRef>): ArtifactRef {
  return {
    refId: "art_opaque_lifecycle_001",
    artifactKind: "source",
    ownershipScope: "deploy_prod",
    contentHash: "sha256-deadbeef",
    byteSize: 32,
    createdAt: NOW,
    expiresAt: NOW + 24 * 60 * 60 * 1000,
    retentionPolicy: "transient",
    verified: true,
    ...overrides,
  };
}

function makeStore(): ArtifactLifecycleStore {
  return new ArtifactLifecycleStore(new InMemoryArtifactStorage());
}

void test("PRD 661: only verified artifacts can be registered and read", () => {
  const store = makeStore();
  const ref = makeVerifiedRef();
  const bytes = new TextEncoder().encode("%PDF-1.7\nverified\n");
  store.registerVerifiedArtifact(ref, bytes, NOW);
  const loaded = store.readArtifact(ref.refId, "deploy_prod", NOW + 1000);
  assert.deepEqual(loaded, bytes);

  const unverified = makeVerifiedRef({ refId: "art_unverified_001", verified: false });
  assert.throws(() => store.registerVerifiedArtifact(unverified, bytes, NOW), {
    message: /verified/i,
  });
});

void test("PRD 661: cross-ownership read rejected", () => {
  const store = makeStore();
  const ref = makeVerifiedRef();
  store.registerVerifiedArtifact(ref, new Uint8Array([1, 2, 3]), NOW);
  assert.throws(() => store.readArtifact(ref.refId, "deploy_staging", NOW + 10), {
    message: /Cross-ownership|access denied/i,
  });
});

void test("PRD 661: successful processing does not extend retention or enroll corpus", () => {
  const store = makeStore();
  const ref = makeVerifiedRef();
  store.registerVerifiedArtifact(ref, new TextEncoder().encode("%PDF-1.7\n"), NOW);
  const before = store.getRecord(ref.refId)?.ref.expiresAt;
  const receipt = store.processArtifact(ref.refId, "deploy_prod", NOW + 5000);
  assert.equal(receipt.retentionExtended, false);
  assert.equal(receipt.corpusEnrolled, false);
  const after = store.getRecord(ref.refId)?.ref.expiresAt;
  assert.equal(after, before);
  assert.equal(receipt.expiresAt, before);
});

void test("PRD 661: cancel and failure revoke processing without deleting bytes twice", () => {
  const store = makeStore();
  const ref = makeVerifiedRef({ refId: "art_cancel_001" });
  store.registerVerifiedArtifact(ref, new Uint8Array([9, 9]), NOW);
  store.cancelProcessing(ref.refId, "user cancelled", NOW + 10);
  const cancelled = store.getRecord(ref.refId);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.accessRevoked, true);

  const ref2 = makeVerifiedRef({ refId: "art_fail_001" });
  store.registerVerifiedArtifact(ref2, new Uint8Array([7]), NOW);
  store.failProcessing(ref2.refId, "engine error", NOW + 10);
  const failed = store.getRecord(ref2.refId);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.accessRevoked, true);
});

void test("PRD 661: expiry sweep marks logically expired, not yet physically cleaned", () => {
  const store = makeStore();
  const ref = makeVerifiedRef({ refId: "art_expiry_001" });
  store.registerVerifiedArtifact(ref, new Uint8Array([5]), NOW);
  const expired = store.expireSweep(ref.expiresAt + 1);
  assert.ok(expired.includes(ref.refId));
  const record = store.getRecord(ref.refId);
  assert.equal(record?.status, "logically_expired");
  // Logically expired is distinct from physical cleanup pending.
  assert.notEqual(record?.status, "physical_cleanup_pending");
  assert.throws(() => store.readArtifact(ref.refId, "deploy_prod", ref.expiresAt + 2), {
    message: /expired|revoked|access/i,
  });
});

void test("PRD 661: explicit delete immediately revokes access", () => {
  const store = makeStore();
  const ref = makeVerifiedRef({ refId: "art_delete_001" });
  store.registerVerifiedArtifact(ref, new Uint8Array([3, 3, 3]), NOW);
  store.deleteExplicit(ref.refId, "deploy_prod", NOW + 100);
  const record = store.getRecord(ref.refId);
  assert.equal(record?.status, "logically_deleted");
  assert.equal(record?.accessRevoked, true);
  assert.throws(() => store.readArtifact(ref.refId, "deploy_prod", NOW + 101), {
    message: /revoked|deleted|access/i,
  });
});

void test("PRD 661: orphan cleanup removes unreferenced blobs", () => {
  const storage = new InMemoryArtifactStorage();
  const store = new ArtifactLifecycleStore(storage);
  const ref = makeVerifiedRef({ refId: "art_orphan_keep" });
  store.registerVerifiedArtifact(ref, new Uint8Array([1]), NOW);
  storage.putOrphanForTest("art_orphan_stale", "deploy_prod", new Uint8Array([2]));
  const removed = store.cleanupOrphans(NOW + 10);
  assert.ok(removed.includes("art_orphan_stale"));
  assert.ok(!removed.includes("art_orphan_keep"));
});

void test("PRD 661: staging cleanup window is at most 1 hour", () => {
  assert.equal(ARTIFACT_LIFECYCLE_CLEANUP_WINDOW_MS, 3_600_000);
  const store = makeStore();
  assert.throws(() => store.sweepStaging(NOW, 3_600_001), {
    message: /exceeds maximum/i,
  });
});

void test("PRD 661: staging distinguishes logically expired vs physical cleanup pending", () => {
  const store = makeStore();
  const intentId = "intent_staging_001";
  store.trackStaging(intentId, NOW);
  const expired = store.expireStaging(intentId, NOW + 1000);
  assert.equal(expired.status, "logically_expired");
  assert.equal(expired.accessRevoked, false);
  const pending = store.markStagingCleanupPending(intentId, NOW + 2000);
  assert.equal(pending.status, "physical_cleanup_pending");
  const cleaned = store.sweepStaging(NOW + 2000 + ARTIFACT_LIFECYCLE_CLEANUP_WINDOW_MS + 1);
  assert.ok(cleaned.includes(intentId));
});

void test("PRD 661: explicit staging delete immediately revokes access", () => {
  const store = makeStore();
  const intentId = "intent_staging_delete";
  store.trackStaging(intentId, NOW);
  const deleted = store.deleteStagingExplicit(intentId, NOW + 5);
  assert.equal(deleted.status, "logically_deleted");
  assert.equal(deleted.accessRevoked, true);
});
