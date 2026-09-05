import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ARTIFACT_TTL_MS,
  DEFAULT_UPLOAD_INTENT_TTL_MS,
  DurableUploadArtifactService,
} from "../../src/core/durable-upload-flow.js";
import { createArtifactRetentionPolicy } from "../../src/core/artifact-retention-policy.js";
import {
  InMemoryDurableRecordStore,
  type DurableCasResult,
  type DurableCreateResult,
  type DurableDeleteResult,
  type DurableExpiredPage,
  type DurableRecord,
  type DurableRecordStorePort,
  type DurableRecordUpdate,
  type NewDurableRecord,
} from "../../src/core/durable-store.js";
import { GroundlaneError } from "../../src/core/errors.js";
import type {
  ImmutableBlobPort,
  ImmutableBlobPutResult,
  ImmutableBlobStat,
} from "../../src/core/immutable-blob.js";

const NOW = 1_800_000_000_000;
const CALLER = { ownerId: "owner-a", credentialBinding: "managed:credential-a" };

class FakeImmutableBlobs implements ImmutableBlobPort {
  readonly objects = new Map<string, { ownerId: string; digest: string; bytes: Uint8Array }>();
  puts = 0;
  failPut = false;
  failDeletes = 0;

  putIfAbsent(input: { blobKey: string; ownerId: string; digest: string; bytes: Uint8Array }): Promise<ImmutableBlobPutResult> {
    this.puts += 1;
    if (this.failPut) throw new Error("private R2 endpoint and secret detail");
    const existing = this.objects.get(input.blobKey);
    if (existing !== undefined) {
      const stat = this.toStat(input.blobKey, existing);
      return Promise.resolve(existing.ownerId === input.ownerId && existing.digest === input.digest &&
        existing.bytes.byteLength === input.bytes.byteLength
        ? { status: "exists", stat }
        : { status: "conflict", stat });
    }
    const stored = { ownerId: input.ownerId, digest: input.digest, bytes: input.bytes.slice() };
    this.objects.set(input.blobKey, stored);
    return Promise.resolve({ status: "created", stat: this.toStat(input.blobKey, stored) });
  }

  stat(blobKey: string): Promise<ImmutableBlobStat | null> {
    const value = this.objects.get(blobKey);
    return Promise.resolve(value === undefined ? null : this.toStat(blobKey, value));
  }

  get(input: { blobKey: string; ownerId: string; digest: string; maxBytes: number }): Promise<Uint8Array | null> {
    const value = this.objects.get(input.blobKey);
    if (value === undefined) return Promise.resolve(null);
    if (value.ownerId !== input.ownerId || value.digest !== input.digest) throw new Error("private blob mismatch");
    if (value.bytes.byteLength > input.maxBytes) throw new Error("private blob over read cap");
    return Promise.resolve(value.bytes.slice());
  }

  deleteIfOwner(blobKey: string, ownerId: string): Promise<"deleted" | "missing" | "owner_mismatch"> {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("private R2 cleanup failure");
    }
    const value = this.objects.get(blobKey);
    if (value === undefined) return Promise.resolve("missing");
    if (value.ownerId !== ownerId) return Promise.resolve("owner_mismatch");
    this.objects.delete(blobKey);
    return Promise.resolve("deleted");
  }

  private toStat(blobKey: string, value: { ownerId: string; digest: string; bytes: Uint8Array }): ImmutableBlobStat {
    return { blobKey, ownerId: value.ownerId, digest: value.digest, byteSize: value.bytes.byteLength };
  }
}

function createInput(overrides: Partial<Parameters<DurableUploadArtifactService["createIntent"]>[0]> = {}) {
  return {
    idempotencyKey: "upload-request-1",
    declaredMime: "text/plain",
    declaredSize: 5,
    filename: "note.txt",
    nowMs: NOW,
    ...overrides,
  };
}

function assertGroundlaneError(
  error: unknown,
  code: GroundlaneError["code"],
  message: RegExp,
): boolean {
  assert.ok(error instanceof GroundlaneError);
  assert.equal(error.code, code);
  assert.equal(error.stage, "durable-upload");
  assert.match(error.message, message);
  return true;
}

void test("create is durable and idempotent for the same caller, key, and fingerprint", async () => {
  const records = new InMemoryDurableRecordStore();
  const service = new DurableUploadArtifactService(records, new FakeImmutableBlobs());
  const first = await service.createIntent(createInput(), CALLER);
  const replay = await service.createIntent(createInput({ nowMs: NOW + 10 }), CALLER);

  assert.deepEqual(replay, first);
  assert.equal(first.status, "pending");
  assert.equal(first.expiresAt, NOW + DEFAULT_UPLOAD_INTENT_TTL_MS);
  assert.equal(first.artifactTtlMs, DEFAULT_ARTIFACT_TTL_MS);
  assert.doesNotMatch(JSON.stringify(first), /credential-a/u);

  await assert.rejects(
    service.createIntent(createInput({ declaredSize: 6 }), CALLER),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /different upload request/u),
  );
});

void test("source deletion during a pending blob read rejects the late bytes", async () => {
  const records = new InMemoryDurableRecordStore();
  const blobs = new FakeImmutableBlobs();
  const service = new DurableUploadArtifactService(records, blobs);
  const intent = await service.createIntent(createInput(), CALLER);
  const ref = await service.finalize({ intentId: intent.intentId, bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain", nowMs: NOW + 1 }, CALLER);
  let markEntered = () => {};
  let releaseRead = () => {};
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseRead = resolve; });
  const originalGet = blobs.get.bind(blobs);
  blobs.get = async (input) => {
    const bytes = await originalGet(input);
    markEntered();
    await release;
    return bytes;
  };
  const pending = service.readArtifact(ref.refId, CALLER, NOW + 2, 32);
  const rejected = assert.rejects(pending, { code: "INVALID_INPUT" });
  await entered;
  await service.deleteArtifact(ref.refId, CALLER, NOW + 3);
  releaseRead();
  await rejected;
});

void test("scheduled cleanup revokes expired artifacts before retrying physical deletion", async () => {
  const records = new InMemoryDurableRecordStore();
  const blobs = new FakeImmutableBlobs();
  const service = new DurableUploadArtifactService(records, blobs);
  const intent = await service.createIntent(createInput({ artifactTtlMs: 60_000 }), CALLER);
  const ref = await service.finalize({
    intentId: intent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 1,
  }, CALLER);
  blobs.failDeletes = 1;

  const first = await service.cleanupExpiredPage(ref.expiresAt, null, 1);
  assert.equal(first.scanned, 1);
  assert.equal(first.logicallyRevoked, 1);
  assert.equal(first.physicallyDeleted, 0);
  assert.equal(first.retryPending, 1);
  const pending = await records.get(`upload-artifact:${ref.refId}`);
  assert.ok(pending !== null);
  assert.equal((JSON.parse(pending.value) as { status: string }).status, "physical_cleanup_pending");
  assert.equal(blobs.objects.size, 1);
  await assert.rejects(
    service.readArtifact(ref.refId, CALLER, ref.expiresAt + 1, 32),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /expired|unavailable/u),
  );

  const retry = await service.cleanupExpiredPage(ref.expiresAt + 60_001, null, 10);
  assert.equal(retry.physicallyDeleted, 1);
  assert.equal(retry.retryPending, 0);
  assert.equal(blobs.objects.size, 0);
  const cleaned = await records.get(`upload-artifact:${ref.refId}`);
  assert.ok(cleaned !== null);
  assert.equal((JSON.parse(cleaned.value) as { status: string }).status, "expired");
  assert.equal(cleaned.expiresAt, null);
});

void test("cleanup CAS conflict never deletes final bytes", async () => {
  const inner = new InMemoryDurableRecordStore();
  let conflictArtifactCleanup = true;
  const records: DurableRecordStorePort = {
    get: (key) => inner.get(key),
    createIfAbsent: (record) => inner.createIfAbsent(record),
    compareAndSwap: async (key, revision, update) => {
      const value = JSON.parse(update.value) as { status?: string };
      if (conflictArtifactCleanup && key.startsWith("upload-artifact:") &&
          value.status === "physical_cleanup_pending") {
        conflictArtifactCleanup = false;
        const current = await inner.get(key);
        assert.ok(current !== null);
        return { status: "conflict", record: current };
      }
      return inner.compareAndSwap(key, revision, update);
    },
    deleteIfRevision: (key, revision) => inner.deleteIfRevision(key, revision),
    scanExpired: (nowMs, cursor, limit) => inner.scanExpired(nowMs, cursor, limit),
  };
  const blobs = new FakeImmutableBlobs();
  const service = new DurableUploadArtifactService(records, blobs);
  const intent = await service.createIntent(createInput({ artifactTtlMs: 60_000 }), CALLER);
  const ref = await service.finalize({
    intentId: intent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 1,
  }, CALLER);

  const result = await service.cleanupExpiredPage(ref.expiresAt, null, 1);
  assert.equal(result.retryPending, 1);
  assert.equal(result.physicallyDeleted, 0);
  assert.equal(blobs.objects.size, 1);
});

void test("cleanup keeps final bytes when immutable owner metadata mismatches", async () => {
  const records = new InMemoryDurableRecordStore();
  const blobs = new FakeImmutableBlobs();
  const service = new DurableUploadArtifactService(records, blobs);
  const intent = await service.createIntent(createInput({ artifactTtlMs: 60_000 }), CALLER);
  const ref = await service.finalize({
    intentId: intent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 1,
  }, CALLER);
  const [key, stored] = [...blobs.objects.entries()][0] ?? [];
  assert.ok(key !== undefined && stored !== undefined);
  blobs.objects.set(key, { ...stored, ownerId: "other-owner" });

  const result = await service.cleanupExpiredPage(ref.expiresAt, null, 1);
  assert.equal(result.physicallyDeleted, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(blobs.objects.size, 1);
});

void test("intent and artifact access require both owner and credential binding", async () => {
  const service = new DurableUploadArtifactService(
    new InMemoryDurableRecordStore(),
    new FakeImmutableBlobs(),
  );
  const intent = await service.createIntent(createInput(), CALLER);

  for (const caller of [
    { ...CALLER, ownerId: "owner-b" },
    { ...CALLER, credentialBinding: "managed:credential-b" },
  ]) {
    await assert.rejects(
      service.getIntent(intent.intentId, caller, NOW + 1),
      (error) => assertGroundlaneError(error, "INVALID_INPUT", /Unknown or unavailable upload intent/u),
    );
  }
});

void test("TTL and identity inputs are bounded with stable validation errors", async () => {
  const service = new DurableUploadArtifactService(
    new InMemoryDurableRecordStore(),
    new FakeImmutableBlobs(),
  );
  for (const input of [
    createInput({ uploadTtlMs: 59_999 }),
    createInput({ uploadTtlMs: 3_600_001 }),
    createInput({ artifactTtlMs: 59_999 }),
    createInput({ artifactTtlMs: 2_592_000_001 }),
    createInput({ idempotencyKey: "" }),
  ]) {
    await assert.rejects(
      service.createIntent(input, CALLER),
      (error) => assertGroundlaneError(error, "INVALID_INPUT", /must be|TTL/u),
    );
  }
});

void test("operator TTL caps are enforced without clamping", async () => {
  const service = new DurableUploadArtifactService(
    new InMemoryDurableRecordStore(),
    new FakeImmutableBlobs(),
    createArtifactRetentionPolicy({
      uploadMaxTtlSeconds: 1_200,
      artifactMaxTtlSeconds: 172_800,
    }),
  );
  await assert.rejects(
    service.createIntent(createInput({ uploadTtlMs: 1_200_001 }), CALLER),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /1200000 milliseconds/u),
  );
  await assert.rejects(
    service.createIntent(createInput({ artifactTtlMs: 172_800_001 }), CALLER),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /172800000 milliseconds/u),
  );

  const intent = await service.createIntent(createInput({
    idempotencyKey: "at-operator-cap",
    uploadTtlMs: 1_200_000,
    artifactTtlMs: 172_800_000,
  }), CALLER);
  assert.equal(intent.expiresAt, NOW + 1_200_000);
  assert.equal(intent.artifactTtlMs, 172_800_000);
});

void test("finalize uses CAS, creates one immutable artifact, and is replay-safe", async () => {
  const records = new InMemoryDurableRecordStore();
  const blobs = new FakeImmutableBlobs();
  const service = new DurableUploadArtifactService(records, blobs);
  const intent = await service.createIntent(createInput(), CALLER);
  const bytes = new TextEncoder().encode("hello");

  const first = await service.finalize({
    intentId: intent.intentId,
    bytes,
    observedMime: "text/plain",
    nowMs: NOW + 1_000,
  }, CALLER);
  const replay = await service.finalize({
    intentId: intent.intentId,
    bytes,
    observedMime: "text/plain",
    nowMs: NOW + 2_000,
  }, CALLER);

  assert.deepEqual(replay, first);
  assert.equal(first.artifactKind, "source");
  assert.equal(first.verified, true);
  assert.equal(first.expiresAt, NOW + 1_000 + DEFAULT_ARTIFACT_TTL_MS);
  assert.match(first.refId, /^art_[a-f0-9]{40}$/u);
  assert.equal(blobs.puts, 1);
  assert.equal((await records.get(`upload-intent:${intent.intentId}`))?.revision, 3);

  await assert.rejects(
    service.finalize({
      intentId: intent.intentId,
      bytes: new TextEncoder().encode("other"),
      observedMime: "text/plain",
      nowMs: NOW + 3_000,
    }, CALLER),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /different content/u),
  );
});

class FailFinalIntentCasOnce implements DurableRecordStorePort {
  private failed = false;
  constructor(private readonly inner: DurableRecordStorePort) {}
  get(key: string): Promise<DurableRecord | null> { return this.inner.get(key); }
  createIfAbsent(record: NewDurableRecord): Promise<DurableCreateResult> { return this.inner.createIfAbsent(record); }
  compareAndSwap(key: string, revision: number, update: DurableRecordUpdate): Promise<DurableCasResult> {
    const parsed = JSON.parse(update.value) as { status?: unknown };
    if (!this.failed && key.startsWith("upload-intent:") && parsed.status === "finalized") {
      this.failed = true;
      return Promise.resolve({ status: "conflict", record: {
        key,
        value: update.value.replace('"status":"finalized"', '"status":"finalizing"'),
        revision,
        createdAt: update.nowMs,
        updatedAt: update.nowMs,
        expiresAt: update.expiresAt ?? null,
      } });
    }
    return this.inner.compareAndSwap(key, revision, update);
  }
  deleteIfRevision(key: string, revision: number): Promise<DurableDeleteResult> { return this.inner.deleteIfRevision(key, revision); }
  scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage> { return this.inner.scanExpired(nowMs, cursor, limit); }
}

void test("a retry resumes a finalizing intent after the immutable write already succeeded", async () => {
  const records = new FailFinalIntentCasOnce(new InMemoryDurableRecordStore());
  const blobs = new FakeImmutableBlobs();
  const service = new DurableUploadArtifactService(records, blobs);
  const intent = await service.createIntent(createInput(), CALLER);
  const request = {
    intentId: intent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 1_000,
  };

  await assert.rejects(
    service.finalize(request, CALLER),
    (error) => assertGroundlaneError(error, "UPSTREAM_ERROR", /conflicted/u),
  );
  const recovered = await service.finalize({ ...request, nowMs: NOW + 2_000 }, CALLER);
  assert.equal(recovered.verified, true);
  assert.equal(blobs.puts, 2);
});

void test("artifact read, expiry, and explicit deletion preserve immutable lifecycle rules", async () => {
  const records = new InMemoryDurableRecordStore();
  const blobs = new FakeImmutableBlobs();
  const service = new DurableUploadArtifactService(records, blobs);
  const firstIntent = await service.createIntent(createInput({ artifactTtlMs: 60_000 }), CALLER);
  const first = await service.finalize({
    intentId: firstIntent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 1,
  }, CALLER);
  const read = await service.readArtifact(first.refId, CALLER, NOW + 2, 32);
  assert.deepEqual(read.bytes, new TextEncoder().encode("hello"));
  assert.equal(read.mimeType, "text/plain");
  assert.equal(read.filename, "note.txt");

  await assert.rejects(
    service.readArtifact(first.refId, { ...CALLER, credentialBinding: "other" }, NOW + 2, 32),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /Unknown or unavailable artifact/u),
  );
  await assert.rejects(
    service.readArtifact(first.refId, CALLER, first.expiresAt, 32),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /expired/u),
  );

  const secondIntent = await service.createIntent(createInput({ idempotencyKey: "upload-request-2" }), CALLER);
  const second = await service.finalize({
    intentId: secondIntent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 10,
  }, CALLER);
  await service.deleteArtifact(second.refId, CALLER, NOW + 20);
  await service.deleteArtifact(second.refId, CALLER, NOW + 21);
  await assert.rejects(
    service.readArtifact(second.refId, CALLER, NOW + 22, 32),
    (error) => assertGroundlaneError(error, "INVALID_INPUT", /Unknown or unavailable artifact/u),
  );
});

void test("explicit deletion and expiry cleanup notify source-cache revocation before settling bytes", async () => {
  const records = new InMemoryDurableRecordStore();
  const blobs = new FakeImmutableBlobs();
  const revoked: Array<{ refId: string; reason: string }> = [];
  const service = new DurableUploadArtifactService(
    records,
    blobs,
    undefined,
    {
      revoke(input) {
        revoked.push({ refId: input.refId, reason: input.reason });
        return Promise.resolve();
      },
    },
  );
  const expiringIntent = await service.createIntent(createInput({
    idempotencyKey: "expiry-cache-revoke",
    artifactTtlMs: 60_000,
  }), CALLER);
  const expiring = await service.finalize({
    intentId: expiringIntent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 1,
  }, CALLER);
  await assert.rejects(
    service.readArtifact(expiring.refId, CALLER, expiring.expiresAt, 32),
    /expired/u,
  );
  await service.cleanupExpiredPage(expiring.expiresAt + 60_001, null, 100);

  const deletedIntent = await service.createIntent(createInput({
    idempotencyKey: "delete-cache-revoke",
  }), CALLER);
  const deleted = await service.finalize({
    intentId: deletedIntent.intentId,
    bytes: new TextEncoder().encode("hello"),
    observedMime: "text/plain",
    nowMs: NOW + 2,
  }, CALLER);
  await service.deleteArtifact(deleted.refId, CALLER, NOW + 3);

  assert.deepEqual(revoked, [
    { refId: expiring.refId, reason: "expired" },
    { refId: deleted.refId, reason: "deleted" },
  ]);
});

void test("storage failures map to stable sanitized Groundlane errors", async () => {
  const blobs = new FakeImmutableBlobs();
  blobs.failPut = true;
  const service = new DurableUploadArtifactService(new InMemoryDurableRecordStore(), blobs);
  const intent = await service.createIntent(createInput(), CALLER);

  await assert.rejects(
    service.finalize({
      intentId: intent.intentId,
      bytes: new TextEncoder().encode("hello"),
      observedMime: "text/plain",
      nowMs: NOW + 1,
    }, CALLER),
    (error) => {
      assertGroundlaneError(error, "UPSTREAM_ERROR", /Artifact storage operation failed/u);
      assert.doesNotMatch((error as Error).message, /private|secret|R2/u);
      return true;
    },
  );
});
