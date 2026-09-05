import assert from "node:assert/strict";
import test from "node:test";

import { createEdgeDocumentOutputRuntime, DOCUMENT_OUTPUT_NAMESPACE } from "../../src/worker/document-output-runtime.js";

import { FakeD1, FakeR2 } from "../support/document-output-bindings.js";

const caller = { tenantId: "tenant-a", ownerId: "owner-a", credentialBinding: "private-credential-a" };
const signal = new AbortController().signal;
function fixture() {
  const db = new FakeD1();
  const bucket = new FakeR2();
  let time = 1_700_000_000_000;
  const env = { MANAGED_TOKEN_D1: db, GROUNDLANE_ARTIFACTS: bucket };
  return { db, bucket, env, now: () => time, advance: (ms: number) => { time += ms; } };
}
const input = { caller, sourceBytes: new TextEncoder().encode("source"), mimeType: "text/plain", filename: "source.txt", payload: { text: "x".repeat(100_000) } };

void test("Worker output persists bytes only in R2 and survives a new runtime with full caller isolation", async () => {
  const f = fixture();
  const first = createEdgeDocumentOutputRuntime(f.env, { now: f.now });
  const ref = await first.runtime.save(input, signal);
  assert.equal(f.bucket.objects.size, 2);
  assert.equal(f.db.rows.size, 2);
  for (const row of f.db.rows.values()) {
    assert.equal(row.namespace, DOCUMENT_OUTPUT_NAMESPACE);
    assert.ok(String(row.value).length < 4096);
    assert.ok(!String(row.value).includes(caller.credentialBinding));
  }
  const reopened = createEdgeDocumentOutputRuntime(f.env, { now: f.now });
  const chunk = await reopened.runtime.read(ref.refId, caller, 0, 48 * 1024, signal);
  assert.equal(Buffer.from(chunk.dataBase64, "base64").length, 48 * 1024);
  assert.equal(chunk.totalBytes, Buffer.byteLength(JSON.stringify(input.payload)));
  for (const other of [{ ...caller, tenantId: "other" }, { ...caller, ownerId: "other" }, { ...caller, credentialBinding: "other" }]) {
    await assert.rejects(reopened.runtime.read(ref.refId, other, 0, 100, signal), /unavailable/u);
    await assert.rejects(reopened.runtime.delete(ref.refId, other, signal), /unavailable/u);
  }
  assert.ok(f.db.sessions.every(value => value === "first-primary"));
});

void test("Worker output enforces operator caps and missing consistency/storage bindings fail closed", () => {
  const f = fixture();
  assert.throws(() => createEdgeDocumentOutputRuntime({}), /unavailable/u);
  assert.throws(() => createEdgeDocumentOutputRuntime({ MANAGED_TOKEN_D1: f.db }), /unavailable/u);
  assert.throws(() => createEdgeDocumentOutputRuntime({ GROUNDLANE_ARTIFACTS: f.bucket }), /unavailable/u);
  const noSession = { prepare: f.db.prepare.bind(f.db), batch: f.db.batch.bind(f.db) };
  assert.throws(() => createEdgeDocumentOutputRuntime({ ...f.env, MANAGED_TOKEN_D1: noSession }), /unavailable/u);
  for (const value of ["private-invalid", "1", "999999999999999999999999"]) {
    assert.throws(() => createEdgeDocumentOutputRuntime({ ...f.env, DOCUMENT_ARTIFACT_MAX_TTL_SECONDS: value }), /configuration is invalid/u);
  }
  for (const ttlSeconds of [0, 59, 86_401, Number.NaN]) {
    assert.throws(() => createEdgeDocumentOutputRuntime({ ...f.env, DOCUMENT_ARTIFACT_MAX_TTL_SECONDS: "86400" }, { ttlSeconds }), /configuration is invalid/u);
  }
});

void test("Worker output inherits source expiry and bounded cleanup removes expired D1/R2 artifacts", async () => {
  const f = fixture();
  const { runtime, repository } = createEdgeDocumentOutputRuntime(f.env, { now: f.now, ttlSeconds: 60 });
  const ref = await runtime.save({ ...input, sourceExpiresAt: f.now() + 1000 }, signal);
  assert.equal(ref.expiresAt, f.now() + 1000);
  f.advance(1001);
  await assert.rejects(runtime.read(ref.refId, caller, 0, 100, signal), /unavailable/u);
  for (let i = 0; i < 3; i++) await repository.sweepExpired(f.now(), null, 10);
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.bucket.objects.size, 0);
});

void test("Worker output delete revokes access before failed R2 cleanup and retries after recreation", async () => {
  const f = fixture();
  const { runtime } = createEdgeDocumentOutputRuntime(f.env, { now: f.now });
  const ref = await runtime.save(input, signal);
  f.bucket.failDelete = true;
  assert.deepEqual(await runtime.delete(ref.refId, caller, signal), { deleted: true, cleanupPending: true });
  await assert.rejects(runtime.read(ref.refId, caller, 0, 100, signal), /unavailable/u);
  f.bucket.failDelete = false;
  const reopened = createEdgeDocumentOutputRuntime(f.env, { now: f.now });
  assert.deepEqual(await reopened.runtime.delete(ref.refId, caller, signal), { deleted: true, cleanupPending: false });
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.bucket.objects.size, 0);
});

void test("Worker output checks cancellation before storage and rejects corrupted R2 payloads", async () => {
  const f = fixture();
  const { runtime } = createEdgeDocumentOutputRuntime(f.env, { now: f.now });
  await assert.rejects(runtime.save(input, AbortSignal.abort()), /cancelled/u);
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.bucket.objects.size, 0);
  const ref = await runtime.save(input, signal);
  const canonical = [...f.bucket.objects.values()].find(object => object.bytes.length === ref.byteSize);
  assert.ok(canonical);
  canonical.bytes[0] = 0;
  await assert.rejects(runtime.read(ref.refId, caller, 0, 100, signal), /unavailable/u);
  await assert.rejects(runtime.read(ref.refId, caller, 0, 48 * 1024 + 1, signal), /bounds are invalid/u);
});
