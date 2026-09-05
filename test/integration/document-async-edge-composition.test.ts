import assert from "node:assert/strict";
import test from "node:test";
import { ReductoAsyncDocumentProvider } from "../../src/adapters/document/reducto-async.js";
import { DurableUploadArtifactService } from "../../src/core/durable-upload-flow.js";
import { Deadline } from "../../src/core/limits.js";
import { createEdgeDocumentAsyncRuntime } from "../../src/worker/document-async-runtime.js";
import { D1DurableRecordStore } from "../../src/worker/d1-durable-store.js";
import { R2ImmutableBlobStore } from "../../src/worker/r2-immutable-blob.js";
import { FakeR2 } from "../support/document-output-bindings.js";
import { SqliteD1 } from "../support/sqlite-d1-admission.js";

void test("native async composition runs candidate wire adapter, persists job across restart and stores R2 canonical output", async (t) => {
  let now = 1_800_000_000_000;
  const caller = { ownerId: "owner", credentialBinding: "credential" };
  const env = { MANAGED_TOKEN_D1: new SqliteD1(), GROUNDLANE_ARTIFACTS: new FakeR2() };
  t.after(() => env.MANAGED_TOKEN_D1.db.close());
  const uploads = new DurableUploadArtifactService(new D1DurableRecordStore(env.MANAGED_TOKEN_D1, "artifact-upload-v1"),
    new R2ImmutableBlobStore(env.GROUNDLANE_ARTIFACTS));
  const bytes = new TextEncoder().encode("%PDF-1.7 synthetic");
  const intent = await uploads.createIntent({ idempotencyKey: "source", declaredMime: "application/pdf", declaredSize: bytes.length,
    filename: "synthetic.pdf", nowMs: now }, caller);
  const source = await uploads.finalize({ intentId: intent.intentId, bytes, observedMime: "application/pdf", nowMs: now }, caller);
  const replies: unknown[] = [{ file_id: "reducto://file-1" }, { job_id: "job-1" }, { status: "Pending" },
    { status: "Completed", result: { job_id: "job-1", duration: 2, usage: { num_pages: 1, credits: 3 }, result: {
      type: "full", chunks: [{ content: "hello", embed: "hello", enriched: null, blocks: [
        { type: "Text", content: "hello", bbox: { left: 0, top: 0, width: 1, height: 1, page: 1 } },
      ] }],
    } } }];
  const calls: string[] = [];
  const create = () => createEdgeDocumentAsyncRuntime(env, new ReductoAsyncDocumentProvider({ apiKey: "synthetic-provider-key",
    fetch: (url) => { calls.push(url); assert.ok(replies.length); return Promise.resolve(Response.json(replies.shift())); },
  }), { now: () => now });
  const input = { mode: "async" as const, idempotencyKey: "job-request", sourceRefId: source.refId, expiresAt: now + 120_000,
    policy: { absoluteDeadlineMs: now + 90_000, totalExecutionBudgetMs: 90_000, perAttemptDeadlineMs: 5_000,
      maxInputBytes: 1000, maxOutputBytes: 10_000 } };
  const created = await create().submit(input, caller, new Deadline(5000));
  assert.equal(created.snapshot.expiresAt, input.expiresAt);
  assert.equal((await create().submit(input, caller, new Deadline(5000))).snapshot.refId, created.snapshot.refId);
  assert.equal(calls.length, 0);
  now += 1;
  assert.equal((await create().dispatcher.drain()).advanced, 1);
  assert.equal((await create().runtime.status(created.job.jobId, caller, new Deadline(5000))).job.status, "running");
  now += 5001;
  assert.equal((await create().dispatcher.drain()).advanced, 1);
  const done = await create().runtime.status(created.job.jobId, caller, new Deadline(5000));
  assert.equal(done.job.status, "completed");
  assert.equal(done.resultCleanupPending, false);
  assert.ok(done.job.resultArtifactRef);
  assert.equal(calls.filter(url => url.endsWith("/parse_async")).length, 1);
  assert.equal(calls.filter(url => url.endsWith("/upload")).length, 1);
  assert.ok(!JSON.stringify(done).includes("credential"));
  assert.ok(!JSON.stringify(done).includes("synthetic-provider-key"));
  const read = await create().outputs.read(done.job.resultArtifactRef, { ...caller, tenantId: "cloudflare" }, 0, 4096, new AbortController().signal);
  const payload = Buffer.from(read.dataBase64, "base64").toString();
  assert.ok(payload.includes('"cost":null'));
  assert.ok(payload.includes('"content":"hello"'));
  await create().runtime.cancel(done.job.jobId, caller, true, new Deadline(5000));
  assert.ok(await create().outputs.read(done.job.resultArtifactRef, { ...caller, tenantId: "cloudflare" }, 0, 100, new AbortController().signal));
  await uploads.deleteArtifact(source.refId, caller, now);
  await assert.rejects(create().outputs.read(done.job.resultArtifactRef, { ...caller, tenantId: "cloudflare" }, 0, 100, new AbortController().signal));
});

async function snapshotFixture() {
  let now = 1_800_000_000_000;
  const caller = { ownerId: "owner", credentialBinding: "credential" };
  const env = { MANAGED_TOKEN_D1: new SqliteD1(), GROUNDLANE_ARTIFACTS: new FakeR2() };
  const blobs = new R2ImmutableBlobStore(env.GROUNDLANE_ARTIFACTS);
  const records = new D1DurableRecordStore(env.MANAGED_TOKEN_D1, "artifact-upload-v1");
  const uploads = new DurableUploadArtifactService(records, blobs);
  const bytes = new TextEncoder().encode("%PDF-1.7 source");
  const intent = await uploads.createIntent({ idempotencyKey: "source", declaredMime: "application/pdf", declaredSize: bytes.length, filename: "source.pdf", nowMs: now }, caller);
  const source = await uploads.finalize({ intentId: intent.intentId, bytes, observedMime: "application/pdf", nowMs: now }, caller);
  let creates = 0;
  const provider = { providerId: "fixture", create: () => { creates++; return Promise.resolve("task"); },
    poll: () => Promise.resolve({ status: "pending" as const }), cancel: () => Promise.resolve({ acknowledged: false }) };
  const factory = () => createEdgeDocumentAsyncRuntime(env, provider, { now: () => now });
  const input = { mode: "async" as const, idempotencyKey: "job", sourceRefId: source.refId, expiresAt: now + 100_000,
    policy: { absoluteDeadlineMs: now + 100_000, totalExecutionBudgetMs: 100_000, perAttemptDeadlineMs: 1_000, maxInputBytes: 1_000, maxOutputBytes: 10_000 } };
  return { env, caller, input, factory, bytes, records, blobs, uploads, source, creates: () => creates, setNow: (value: number) => { now = value; } };
}

void test("job owns distinct immutable source bytes and deleted source immediately cancels access after restart", async (t) => {
  const f = await snapshotFixture(); t.after(() => f.env.MANAGED_TOKEN_D1.db.close());
  const created = await f.factory().submit(f.input, f.caller, new Deadline(5000));
  assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 2);
  const sourceRecord = await f.records.get(`upload-artifact:${f.source.refId}`);
  assert.ok(sourceRecord);
  const metadata = JSON.parse(sourceRecord.value) as { blobKey: string };
  await f.blobs.deleteIfOwner(metadata.blobKey, f.caller.ownerId);
  // Storage bytes are independent; original logical authority is still active.
  assert.deepEqual((await f.factory().snapshots.read(created.job.jobId, f.source.refId, f.caller, 1000, new AbortController().signal)).bytes, f.bytes);
  await f.uploads.deleteArtifact(f.source.refId, f.caller, f.input.expiresAt - 90_000);
  const revoked = await f.factory().runtime.status(created.job.jobId, f.caller, new Deadline(5000));
  assert.equal(revoked.job.status, "cancelled"); assert.equal(revoked.sourceRevocation, "deleted");
  await assert.rejects(f.factory().snapshots.read(created.job.jobId, f.source.refId, f.caller, 1000, new AbortController().signal));
  await f.factory().runtime.advance(created.job.jobId, f.caller); assert.equal(f.creates(), 0);
});

void test("source deletion during atomic admission creates no job or dispatch and orphan cleanup removes copied bytes", async (t) => {
  const f = await snapshotFixture(); t.after(() => f.env.MANAGED_TOKEN_D1.db.close());
  f.env.MANAGED_TOKEN_D1.beforeBatch = () => {
    f.env.MANAGED_TOKEN_D1.db.prepare("UPDATE durable_records SET value=json_set(value,'$.status','deleted'),revision=revision+1 WHERE namespace='artifact-upload-v1' AND key=?").run(`upload-artifact:${f.source.refId}`);
  };
  await assert.rejects(f.factory().submit(f.input, f.caller, new Deadline(5000)));
  assert.equal(f.env.MANAGED_TOKEN_D1.db.prepare("SELECT COUNT(*) AS n FROM durable_records WHERE namespace IN('document-async-v1','document-dispatch-v1')").get()?.n, 0);
  assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 2);
  const cleanupAt = f.input.expiresAt + 3_600_000; f.setNow(cleanupAt);
  assert.equal((await f.factory().snapshots.cleanup(cleanupAt, null, 100)).cleaned, 1);
  assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 1); assert.equal(f.creates(), 0);
});

void test("snapshot expiry denies access before cleanup and respects original source policy", async (t) => {
  const f = await snapshotFixture(); t.after(() => f.env.MANAGED_TOKEN_D1.db.close());
  const created = await f.factory().submit(f.input, f.caller, new Deadline(5000));
  f.setNow(f.input.expiresAt);
  await assert.rejects(f.factory().snapshots.read(created.job.jobId, f.source.refId, f.caller, 1000, new AbortController().signal));
  const cleanup = await f.factory().snapshots.cleanup(f.input.expiresAt, null, 100);
  assert.equal(cleanup.cleaned, 1); assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 1);
});

void test("source revocation during snapshot byte read rejects the bytes and cleanup failures remain retryable", async (t) => {
  const f = await snapshotFixture(); t.after(() => f.env.MANAGED_TOKEN_D1.db.close());
  const created = await f.factory().submit(f.input, f.caller, new Deadline(5000));
  await assert.rejects(f.factory().snapshots.read(created.job.jobId, f.source.refId, { ...f.caller, credentialBinding: "other" }, 1000, new AbortController().signal));
  const originalGet = f.env.GROUNDLANE_ARTIFACTS.get.bind(f.env.GROUNDLANE_ARTIFACTS);
  f.env.GROUNDLANE_ARTIFACTS.get = async (key) => {
    const object = await originalGet(key);
    if (object === null) return null;
    return { ...object, bytes: async () => {
      f.env.MANAGED_TOKEN_D1.db.prepare("UPDATE durable_records SET value=json_set(value,'$.status','deleted'),revision=revision+1 WHERE namespace='artifact-upload-v1' AND key=?").run(`upload-artifact:${f.source.refId}`);
      return object.bytes();
    } };
  };
  await assert.rejects(f.factory().snapshots.read(created.job.jobId, f.source.refId, f.caller, 1000, new AbortController().signal));
  f.env.GROUNDLANE_ARTIFACTS.get = originalGet; f.env.GROUNDLANE_ARTIFACTS.failDelete = true;
  const pending = await f.factory().runtime.status(created.job.jobId, f.caller, new Deadline(5000));
  assert.equal(pending.snapshotCleanupPending, true); assert.equal(pending.resultCleanupPending, true);
  f.env.GROUNDLANE_ARTIFACTS.failDelete = false;
  assert.equal((await f.factory().runtime.status(created.job.jobId, f.caller, new Deadline(5000))).snapshotCleanupPending, false);
});

void test("native async factory fails closed without required D1/R2 consistency bindings", () => {
  const provider = new ReductoAsyncDocumentProvider({ apiKey: "synthetic-key" });
  assert.throws(() => createEdgeDocumentAsyncRuntime({}, provider), { code: "PROVIDER_UNAVAILABLE" });
});
