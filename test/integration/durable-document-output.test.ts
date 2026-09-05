import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { SqliteImmutableBlobStore } from "../../src/adapters/state/sqlite-immutable-blob.js";
import { DurableArtifactRepository } from "../../src/core/durable-artifacts.js";
import { DurableDocumentOutputRuntime } from "../../src/core/durable-document-output.js";
import { GroundlaneError } from "../../src/core/errors.js";
import type { ImmutableBlobPort, ImmutableBlobPutResult } from "../../src/core/immutable-blob.js";
import type { DurableRecordStorePort } from "../../src/core/durable-store.js";

const caller = { tenantId: "tenant", ownerId: "owner", credentialBinding: "credential" };
const sourceBytes = Buffer.from("a source document");
const input = { caller, sourceBytes, mimeType: "text/plain", filename: "document.txt", payload: { envelope: { version: "1" }, projection: "result" } };
const signal = (): AbortSignal => new AbortController().signal;

void test("job-bound output reservation recovers after acknowledgment loss and rejects content aliasing", async (t) => {
  const state = await fixture(t);
  const runtime = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, undefined, state.records);
  const saved = await runtime.save({ ...input, operationKey: "job-one" }, signal());
  const writes = state.blobs.writes;
  const restarted = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 2_000, undefined, state.records);
  assert.deepEqual(await restarted.recoverOperation("job-one", caller, signal()), { refId: saved.refId, ready: true });
  const again = await restarted.save({ ...input, operationKey: "job-one" }, signal());
  assert.equal(again.refId, saved.refId);
  assert.equal(state.blobs.count(), 2);
  assert.equal(state.blobs.writes, writes);
  await assert.rejects(restarted.save({ ...input, operationKey: "job-one", payload: { forged: true } }, signal()));
  assert.equal(await restarted.recoverOperation("job-one", { ...caller, credentialBinding: "other" }, signal()), null);
  assert.equal(await restarted.recoverOperation("job-two", caller, signal()), null);
});

void test("expired job-bound output reservations are discoverable and removed after artifact cleanup", async (t) => {
  const state = await fixture(t);
  const runtime = new DurableDocumentOutputRuntime(state.repository, 1, () => 1_000, undefined, state.records);
  const saved = await runtime.save({ ...input, operationKey: "expired-job" }, signal());
  assert.equal((await state.records.scanExpired(2_000, null, 10)).records.some((record) =>
    record.key === `output-intent:${saved.refId}`), true);
  await state.repository.sweepExpired(2_000, null, 10);
  await state.repository.sweepExpired(2_000, null, 10);
  assert.equal(state.blobs.count(), 0);
  assert.deepEqual(await runtime.sweepExpiredIntents(2_000, null, 10), {
    scanned: 1, deleted: 1, failures: [], nextCursor: null,
  });
  assert.equal(await state.records.get(`output-intent:${saved.refId}`), null);
  assert.equal(await runtime.recoverOperation("expired-job", caller, signal()), null);
});

void test("source-only reserved write survives restart cleanup and fences a late canonical publication", async (t) => {
  const state = await fixture(t);
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const originalPut = state.repository.put.bind(state.repository);
  state.repository.put = async (value) => {
    if (value.details.kind === "canonical") { entered(); await paused; }
    return originalPut(value);
  };
  const runtime = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, undefined, state.records);
  const saving = assert.rejects(runtime.save({ ...input, operationKey: "partial-job" }, signal()));
  await started;
  const restarted = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 2_000, undefined, state.records);
  const recovery = await restarted.recoverOperation("partial-job", caller, signal());
  assert.ok(recovery);
  assert.equal(recovery.ready, false);
  assert.equal(state.blobs.count(), 1);
  await assert.rejects(restarted.delete(recovery.refId, { ...caller, credentialBinding: "other" }, signal()));
  assert.equal(state.blobs.count(), 1);
  assert.equal((await restarted.delete(recovery.refId, caller, signal())).cleanupPending, false);
  assert.equal(state.blobs.count(), 0);
  release();
  await saving;
  assert.equal(state.blobs.count(), 0);
  await assert.rejects(restarted.read(recovery.refId, caller, 0, 100, signal()));
  await assert.rejects(restarted.save({ ...input, operationKey: "partial-job" }, signal()));
});

void test("replayed output reservation does not append duplicate source reverse edges", async (t) => {
  const state = await fixture(t);
  let registrations = 0;
  const register = state.repository.registerExternalOutput.bind(state.repository);
  state.repository.registerExternalOutput = (...args) => { registrations += 1; return register(...args); };
  const externalSources = { assertActive: () => Promise.resolve({ expiresAt: 20_000,
    contentHash: `sha256-${createHash("sha256").update(sourceBytes).digest("hex")}` }) };
  const runtime = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, externalSources, state.records);
  const saved = await runtime.save({ ...input, operationKey: "job", externalSourceRef: "original" }, signal());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await runtime.save({ ...input, operationKey: "job", externalSourceRef: "original" }, signal())).refId, saved.refId);
  }
  assert.equal(registrations, 1);
  assert.equal(state.blobs.writes, 2);
});

void test("external uploaded source revocation gates derived reads and durably retries cascading cleanup", async (t) => {
  const state = await fixture(t);
  let allowed = true;
  const externalSources = { assertActive: (ref: string, identity: typeof caller) => {
    assert.equal(ref, "uploaded-source");
    assert.deepEqual(identity, caller);
    if (!allowed) throw new Error("revoked");
    return Promise.resolve({ expiresAt: 20_000, contentHash: `sha256-${createHash("sha256").update(sourceBytes).digest("hex")}` });
  } };
  const runtime = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, externalSources);
  const saved = await runtime.save({ ...input, externalSourceRef: "uploaded-source" }, signal());
  assert.equal(saved.expiresAt, 20_000);
  allowed = false;
  await assert.rejects(runtime.read(saved.refId, caller, 0, 100, signal()));
  state.blobs.failDelete = true;
  assert.equal((await runtime.revokeExternalSource("uploaded-source", caller, signal())).cleanupPending, true);
  state.blobs.failDelete = false;
  const reopened = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, externalSources);
  assert.equal((await reopened.revokeExternalSource("uploaded-source", caller, signal())).cleanupPending, false);
  assert.equal(state.blobs.count(), 0);
  allowed = true;
  await assert.rejects(reopened.save({ ...input, externalSourceRef: "uploaded-source" }, signal()));
  assert.equal(state.blobs.count(), 0);
});

void test("external source hash, expiry, authority absence and revocation during reads fail closed", async (t) => {
  const state = await fixture(t);
  let allowed = true;
  let expiresAt = 10_000;
  const externalSources = { assertActive: () => {
    if (!allowed) throw new Error("private upstream revocation");
    return Promise.resolve({ expiresAt, contentHash: `sha256-${createHash("sha256").update(sourceBytes).digest("hex")}` });
  } };
  const runtime = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, externalSources);
  await assert.rejects(runtime.save({ ...input, sourceBytes: Buffer.from("forged"), externalSourceRef: "original" }, signal()));
  assert.equal(state.blobs.count(), 0);
  const saved = await runtime.save({ ...input, externalSourceRef: "original" }, signal());
  await assert.rejects(state.runtime.read(saved.refId, caller, 0, 10, signal()));
  expiresAt = 1_000;
  await assert.rejects(runtime.read(saved.refId, caller, 0, 10, signal()));
  expiresAt = 10_000;
  state.blobs.afterRead = () => { allowed = false; };
  await assert.rejects(runtime.read(saved.refId, caller, 0, 10, signal()));
});

void test("source cascade isolates credentials and resumes bounded batches from durable index", async (t) => {
  const state = await fixture(t);
  const externalSources = { assertActive: () => Promise.resolve({ expiresAt: 20_000,
    contentHash: `sha256-${createHash("sha256").update(sourceBytes).digest("hex")}` }) };
  const runtime = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, externalSources);
  const other = { ...caller, credentialBinding: "other" };
  const unrelated = await runtime.save({ ...input, caller: other, externalSourceRef: "original" }, signal());
  for (let index = 0; index < 101; index += 1) {
    await runtime.save({ ...input, externalSourceRef: "original" }, signal());
  }
  assert.equal((await runtime.revokeExternalSource("original", caller, signal())).cleanupPending, true);
  assert.equal(state.blobs.count(), 4);
  const restarted = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, externalSources);
  assert.equal((await restarted.revokeExternalSource("original", caller, signal())).cleanupPending, false);
  assert.equal(state.blobs.count(), 2);
  assert.ok(await restarted.read(unrelated.refId, other, 0, 10, signal()));
});

void test("source deletion racing publication denies the new output and compensates its blobs", async (t) => {
  const state = await fixture(t);
  let checks = 0;
  const externalSources = { assertActive: () => {
    checks += 1;
    if (checks > 1) throw new Error("source deleted during write");
    return Promise.resolve({ expiresAt: 20_000, contentHash: `sha256-${createHash("sha256").update(sourceBytes).digest("hex")}` });
  } };
  const runtime = new DurableDocumentOutputRuntime(state.repository, 86_400, () => 1_000, externalSources);
  await assert.rejects(runtime.save({ ...input, externalSourceRef: "original" }, signal()));
  assert.equal(state.blobs.count(), 0);
  assert.equal((await runtime.revokeExternalSource("original", caller, signal())).cleanupPending, false);
});

class FaultBlobs extends SqliteImmutableBlobStore {
  writes = 0;
  failWrite = 0;
  failDelete = false;
  readonly failDeleteKeys = new Set<string>();
  readonly writtenKeys: string[] = [];
  afterWrite: (() => void) | undefined;
  afterRead: (() => void) | undefined;

  override async putIfAbsent(value: Parameters<ImmutableBlobPort["putIfAbsent"]>[0]): Promise<ImmutableBlobPutResult> {
    this.writes += 1;
    if (this.writes === this.failWrite) throw new Error("private storage failure");
    const result = await super.putIfAbsent(value);
    this.writtenKeys.push(value.blobKey);
    this.afterWrite?.();
    return result;
  }

  override deleteIfOwner(key: string, ownerId: string): ReturnType<ImmutableBlobPort["deleteIfOwner"]> {
    if (this.failDelete || this.failDeleteKeys.has(key)) return Promise.reject(new Error("private storage failure"));
    return super.deleteIfOwner(key, ownerId);
  }

  override async get(value: Parameters<ImmutableBlobPort["get"]>[0]): Promise<Uint8Array | null> {
    const result = await super.get(value);
    this.afterRead?.();
    return result;
  }
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-output-"));
  let nowMs = 1_000;
  const records = new SqliteDurableRecordStore(join(directory, "state.sqlite"), "output");
  const blobs = new FaultBlobs(join(directory, "blobs.sqlite"), "output");
  const repository = new DurableArtifactRepository(records, blobs);
  const runtime = new DurableDocumentOutputRuntime(repository, 86_400, () => nowMs);
  let closed = false;
  const close = () => {
    if (!closed) { records.close(); blobs.close(); closed = true; }
  };
  t.after(async () => { close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, records, blobs, repository, runtime, close, setNow: (value: number) => { nowMs = value; } };
}

void test("source and canonical SQLite artifacts survive restart and reconstruct bounded chunks", async (t) => {
  const state = await fixture(t);
  const payload = { envelope: { version: "1" }, projection: "漢字".repeat(20_000) };
  const saved = await state.runtime.save({ ...input, payload, sourceExpiresAt: 30_000 }, signal());
  assert.match(saved.refId, /^art_[A-Za-z0-9_-]+$/u);
  assert.equal(saved.expiresAt, 30_000);
  assert.equal(saved.verification, "verified");
  assert.equal(state.blobs.count(), 2);
  assert.equal(saved.details.kind, "canonical");
  if (saved.details.kind !== "canonical") throw new Error("Expected canonical");
  const source = await state.repository.getForCaller(saved.details.sourceRefId, caller);
  assert.equal(source?.metadata.details.kind, "source");
  assert.equal(source?.metadata.expiresAt, saved.expiresAt);
  state.close();
  const reopenedRecords = new SqliteDurableRecordStore(join(state.directory, "state.sqlite"), "output");
  const reopenedBlobs = new SqliteImmutableBlobStore(join(state.directory, "blobs.sqlite"), "output");
  t.after(() => { reopenedRecords.close(); reopenedBlobs.close(); });
  const reopened = new DurableDocumentOutputRuntime(new DurableArtifactRepository(reopenedRecords, reopenedBlobs), 86_400, () => 2_000);
  const chunks: Buffer[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const chunk = await reopened.read(saved.refId, caller, offset, 48 * 1024, signal());
    const bytes = Buffer.from(chunk.dataBase64, "base64");
    assert.ok(bytes.byteLength <= 48 * 1024);
    chunks.push(bytes);
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.totalBytes, saved.byteSize);
    offset = chunk.nextOffset;
  }
  const result = Buffer.concat(chunks);
  assert.deepEqual(JSON.parse(result.toString()), payload);
  assert.equal(saved.contentHash, `sha256-${createHash("sha256").update(result).digest("hex")}`);
  assert.equal((await reopened.read(saved.refId, caller, saved.byteSize, 1, signal())).dataBase64, "");
});

void test("tenant, owner, and credential mismatches receive identical read/delete rejection", async (t) => {
  const { runtime, blobs } = await fixture(t);
  const saved = await runtime.save(input, signal());
  for (const stranger of [
    { ...caller, tenantId: "other" }, { ...caller, ownerId: "other" }, { ...caller, credentialBinding: "other" },
  ]) {
    for (const operation of [() => runtime.read(saved.refId, stranger, 0, 100, signal()), () => runtime.delete(saved.refId, stranger, signal())]) {
      await assert.rejects(operation, (error: unknown) => error instanceof GroundlaneError && error.code === "INVALID_INPUT" && error.message === "Document output is unavailable");
    }
  }
  assert.equal(blobs.count(), 2);
  await runtime.read(saved.refId, caller, 0, 100, signal());
});

void test("expiry and source parent revocation immediately deny output reads", async (t) => {
  const state = await fixture(t);
  const expiring = await state.runtime.save({ ...input, sourceExpiresAt: 2_000 }, signal());
  state.setNow(2_000);
  await assert.rejects(state.runtime.read(expiring.refId, caller, 0, 100, signal()), /unavailable/u);
  const saved = await state.runtime.save(input, signal());
  if (saved.details.kind !== "canonical") throw new Error("Expected canonical");
  const source = await state.repository.getForCaller(saved.details.sourceRefId, caller);
  assert.ok(source);
  await state.repository.deleteExplicit(source.metadata.refId, caller, source.revision, 2_000);
  await assert.rejects(state.runtime.read(saved.refId, caller, 0, 100, signal()), /unavailable/u);
});

void test("delete revokes first and retries pending source cleanup without losing its reference", async (t) => {
  const { runtime, repository, blobs } = await fixture(t);
  const saved = await runtime.save(input, signal());
  blobs.failDelete = true;
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: true });
  assert.equal((await repository.getForCaller(saved.refId, caller))?.metadata.status, "logically_deleted");
  await assert.rejects(runtime.read(saved.refId, caller, 0, 100, signal()), /unavailable/u);
  await assert.rejects(runtime.delete(saved.refId, { ...caller, credentialBinding: "other" }, signal()), /unavailable/u);
  blobs.failDelete = false;
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: false });
  assert.equal(blobs.count(), 0);
  assert.equal(await repository.get(saved.refId), null);
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: false });
});

void test("sweep preserves canonical tombstone while only source deletion fails, and explicit retry reports pending", async (t) => {
  const { runtime, repository, blobs } = await fixture(t);
  const saved = await runtime.save(input, signal());
  if (saved.details.kind !== "canonical") throw new Error("Expected canonical");
  const sourceKey = blobs.writtenKeys[0];
  assert.ok(sourceKey);
  blobs.failDeleteKeys.add(sourceKey);
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: true });
  await repository.sweepExpired(2_000);
  const retained = await repository.getForCaller(saved.refId, caller);
  assert.ok(retained);
  assert.equal(retained.metadata.status, "logically_deleted");
  assert.equal(blobs.count(), 2);
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: true });
  assert.ok(await repository.getForCaller(saved.details.sourceRefId, caller));
  blobs.failDeleteKeys.clear();
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: false });
  assert.equal(blobs.count(), 0);
  assert.equal(await repository.get(saved.refId), null);
  assert.equal(await repository.get(saved.details.sourceRefId), null);
});

void test("sweep cascades source revocation after cancellation immediately following canonical revoke", async (t) => {
  const { runtime, repository, blobs } = await fixture(t);
  const saved = await runtime.save(input, signal());
  if (saved.details.kind !== "canonical") throw new Error("Expected canonical");
  const controller = new AbortController();
  const originalDelete = repository.deleteExplicit.bind(repository);
  t.mock.method(repository, "deleteExplicit", async (...args: Parameters<DurableArtifactRepository["deleteExplicit"]>) => {
    const result = await originalDelete(...args);
    if (args[0] === saved.refId) controller.abort();
    return result;
  });
  await assert.rejects(runtime.delete(saved.refId, caller, controller.signal), /cancelled/u);
  assert.equal((await repository.getForCaller(saved.refId, caller))?.metadata.status, "logically_deleted");
  assert.equal((await repository.getForCaller(saved.details.sourceRefId, caller))?.metadata.status, "active");
  const sourceKey = blobs.writtenKeys[0];
  assert.ok(sourceKey);
  blobs.failDeleteKeys.add(sourceKey);
  await repository.sweepExpired(2_000);
  assert.equal((await repository.getForCaller(saved.details.sourceRefId, caller))?.metadata.status, "logically_deleted");
  await repository.sweepExpired(2_002);
  assert.ok(await repository.getForCaller(saved.refId, caller));
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: true });
  blobs.failDeleteKeys.clear();
  assert.deepEqual(await runtime.delete(saved.refId, caller, signal()), { deleted: true, cleanupPending: false });
  assert.equal(blobs.count(), 0);
});

void test("canonical write failure rolls back the already stored source", async (t) => {
  const { runtime, blobs } = await fixture(t);
  blobs.failWrite = 2;
  await assert.rejects(runtime.save(input, signal()), (error: unknown) => error instanceof GroundlaneError && error.message === "Document output storage failed");
  assert.equal(blobs.count(), 0);
});

void test("canonical metadata commit followed by failed acknowledgment revokes both artifacts", async (t) => {
  const { records, blobs } = await fixture(t);
  let writes = 0;
  const uncertainRecords: DurableRecordStorePort = {
    get: (key) => records.get(key),
    createIfAbsent: async (value) => {
      writes += 1;
      const result = await records.createIfAbsent(value);
      if (writes === 2) throw new Error("acknowledgment lost");
      return result;
    },
    compareAndSwap: (key, revision, value) => records.compareAndSwap(key, revision, value),
    deleteIfRevision: (key, revision) => records.deleteIfRevision(key, revision),
    scanExpired: (nowMs, cursor, limit) => records.scanExpired(nowMs, cursor, limit),
  };
  const runtime = new DurableDocumentOutputRuntime(new DurableArtifactRepository(uncertainRecords, blobs), 86_400, () => 1_000);
  await assert.rejects(runtime.save(input, signal()), /storage failed/u);
  assert.equal(blobs.count(), 0);
});

void test("abort before storage and after each artifact write cleans up partial output", async (t) => {
  for (const abortAt of [0, 1, 2]) {
    await t.test(`abort at write ${abortAt}`, async (subtest) => {
      const { runtime, blobs } = await fixture(subtest);
      const controller = new AbortController();
      if (abortAt === 0) controller.abort();
      blobs.afterWrite = () => { if (blobs.writes === abortAt) controller.abort(); };
      await assert.rejects(runtime.save(input, controller.signal), (error: unknown) => error instanceof GroundlaneError && error.code === "CANCELLED");
      assert.equal(blobs.count(), 0);
    });
  }
});

void test("chunk bounds, JSON bounds, retention, and cancelled reads are enforced", async (t) => {
  const { runtime, repository, blobs } = await fixture(t);
  for (const ttl of [0, -1, 0.5, Number.NaN, 2_592_001]) {
    assert.throws(() => new DurableDocumentOutputRuntime(repository, ttl), /TTL/u);
  }
  const saved = await runtime.save(input, signal());
  for (const [offset, maxBytes] of [[-1, 1], [0, 0], [0, 48 * 1024 + 1], [0.5, 1], [saved.byteSize + 1, 1]]) {
    await assert.rejects(runtime.read(saved.refId, caller, offset ?? -1, maxBytes ?? -1, signal()));
  }
  await assert.rejects(runtime.save({ ...input, payload: "x".repeat(32 * 1024 * 1024) }, signal()), (error: unknown) => error instanceof GroundlaneError && error.code === "OUTPUT_LIMIT");
  await assert.rejects(runtime.save({ ...input, payload: undefined }, signal()), /JSON serializable/u);
  await assert.rejects(runtime.save({ ...input, sourceExpiresAt: 1_000 }, signal()), /retention/u);
  assert.equal(blobs.count(), 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.read(saved.refId, caller, 0, 100, controller.signal), /cancelled/u);
  await assert.rejects(runtime.delete(saved.refId, caller, controller.signal), /cancelled/u);
  assert.equal(blobs.count(), 2);
});

void test("abort while awaiting blob read returns no output bytes", async (t) => {
  const { runtime, blobs } = await fixture(t);
  const saved = await runtime.save(input, signal());
  const controller = new AbortController();
  blobs.afterRead = () => controller.abort();
  await assert.rejects(runtime.read(saved.refId, caller, 0, 100, controller.signal), (error: unknown) => error instanceof GroundlaneError && error.code === "CANCELLED");
  assert.equal(blobs.count(), 2);
});
