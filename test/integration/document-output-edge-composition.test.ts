import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { RemoteDocumentOutputRuntime } from "../../src/container/remote-document-output.js";
import { buildDocumentOutputRequest, DOCUMENT_OUTPUT_MAX_BODY_BYTES } from "../../src/mcp/document-output-bridge.js";
import { createDocumentOutputOutbound } from "../../src/worker/document-output-outbound.js";
import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import { INTERNAL_CONTEXT_HEADER } from "../../src/worker/internal-context.js";
import { FakeD1, FakeR2 } from "../support/document-output-bindings.js";
import { DurableUploadArtifactService } from "../../src/core/durable-upload-flow.js";
import { D1DurableRecordStore } from "../../src/worker/d1-durable-store.js";
import { R2ImmutableBlobStore } from "../../src/worker/r2-immutable-blob.js";
import { createArtifactCacheRevocationPort } from "../../src/worker/artifact-runtime.js";

const principal = { principalId: "owner", authMethod: "managed_token", scopes: ["mcp"] } as const;
const secret = "document-output-integration-secret-123456789";
const caller = { tenantId: "self-hosted", ownerId: "owner", credentialBinding: "managed:one" };
const context: OutboundHandlerContext = { className: "GroundlaneContainer", containerId: "container-one" };
function bytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
const subtle: TimingSafeSubtleCrypto = {
  digest: (algorithm, data) => crypto.subtle.digest(algorithm, data),
  timingSafeEqual: (a, b) => timingSafeEqual(bytes(a), bytes(b)),
};
const signal = new AbortController().signal;
const save = { caller, sourceBytes: new TextEncoder().encode("original source"), mimeType: "text/plain", filename: "test.txt", payload: { text: "y".repeat(100_000) } };
function fixture() {
  const db = new FakeD1();
  const bucket = new FakeR2();
  const env = { MANAGED_TOKEN_D1: db, GROUNDLANE_ARTIFACTS: bucket, DOCUMENT_OUTPUT_EDGE_ENABLED: "true", GROUNDLANE_INTERNAL_SIGNING_SECRET: secret, DOCUMENT_ARTIFACT_MAX_TTL_SECONDS: "86400" };
  const outbound = createDocumentOutputOutbound({ subtle });
  const fetcher = (request: Request) => outbound(request, env, context);
  const remote = (credentialBinding = caller.credentialBinding) => new RemoteDocumentOutputRuntime({ signingSecret: secret, principal, credentialBinding, subtle, timeoutMs: 5000, fetch: fetcher });
  return { db, bucket, env, outbound, fetcher, remote };
}
function signed(fields: Record<string, unknown>, operation: "save" | "read" | "delete" = "save", requestSignal = signal) {
  return buildDocumentOutputRequest({
    body: new TextEncoder().encode(JSON.stringify({ version: 1, operation, deadlineAt: Date.now() + 5000, ...fields })),
    operation, signingSecret: secret, principal, credentialBinding: caller.credentialBinding, subtle,
    clock: { now: Date.now }, signal: requestSignal,
  });
}
const saveFields = { sourceBase64: Buffer.from(save.sourceBytes).toString("base64"), mimeType: save.mimeType, filename: save.filename, payload: save.payload };

async function uploadedSource(f: ReturnType<typeof fixture>) {
  const service = new DurableUploadArtifactService(
    new D1DurableRecordStore(f.db, "artifact-upload-v1"), new R2ImmutableBlobStore(f.bucket), undefined,
    createArtifactCacheRevocationPort(f.env, {}),
  );
  const intent = await service.createIntent({ idempotencyKey: "source-upload", declaredMime: save.mimeType,
    declaredSize: save.sourceBytes.byteLength, filename: save.filename, nowMs: Date.now() }, caller);
  const ref = await service.finalize({ intentId: intent.intentId, bytes: save.sourceBytes,
    observedMime: save.mimeType, nowMs: Date.now() }, caller);
  return { service, ref };
}

void test("uploaded-source output bridge binds original authority and cascades deletion across recreated runtimes", async () => {
  const f = fixture();
  const { service, ref: source } = await uploadedSource(f);
  const output = await f.remote().save({ ...save, externalSourceRef: source.refId }, signal);
  assert.equal(output.details.kind, "canonical");
  assert.ok(output.expiresAt <= source.expiresAt);
  assert.ok(await f.remote().read(output.refId, caller, 0, 100, signal));
  await service.deleteArtifact(source.refId, caller, Date.now());
  await assert.rejects(f.remote().read(output.refId, caller, 0, 100, signal));
  assert.equal(f.bucket.objects.size, 0);
  await assert.rejects(f.remote().save({ ...save, externalSourceRef: source.refId }, signal));
});

void test("uploaded source linkage rejects substituted content and credentials before creating output blobs", async () => {
  const f = fixture();
  const { ref: source } = await uploadedSource(f);
  for (const input of [
    { ...save, sourceBytes: new TextEncoder().encode("tampered"), externalSourceRef: source.refId },
    { ...save, externalSourceRef: "art_missing" },
  ]) await assert.rejects(f.remote().save(input, signal));
  const other = { ...caller, credentialBinding: "managed:two" };
  await assert.rejects(f.remote(other.credentialBinding).save({ ...save, caller: other, externalSourceRef: source.refId }, signal));
  assert.equal(f.bucket.objects.size, 1);
});

void test("failed output cleanup leaves source revoked and retries the durable cascade after storage recovery", async () => {
  const f = fixture();
  const { service, ref: source } = await uploadedSource(f);
  const output = await f.remote().save({ ...save, externalSourceRef: source.refId }, signal);
  f.bucket.failDelete = true;
  await assert.rejects(service.deleteArtifact(source.refId, caller, Date.now()));
  await assert.rejects(f.remote().read(output.refId, caller, 0, 100, signal));
  f.bucket.failDelete = false;
  const reopened = new DurableUploadArtifactService(new D1DurableRecordStore(f.db, "artifact-upload-v1"),
    new R2ImmutableBlobStore(f.bucket), undefined, createArtifactCacheRevocationPort(f.env, {}));
  await reopened.deleteArtifact(source.refId, caller, Date.now());
  assert.equal(f.bucket.objects.size, 0);
});

void test("scheduled upload expiry cascades derived output cleanup using original source authority", async () => {
  const f = fixture();
  const { service, ref: source } = await uploadedSource(f);
  const output = await f.remote().save({ ...save, externalSourceRef: source.refId }, signal);
  const page = await service.cleanupExpiredPage(source.expiresAt + 1, null, 100);
  assert.equal(page.retryPending, 0);
  assert.deepEqual(page.failures, []);
  await assert.rejects(f.remote().read(output.refId, caller, 0, 100, signal));
  assert.equal(f.bucket.objects.size, 0);
});

void test("signed Container output bridge persists D1/R2, reads bounded chunks, and deletes through recreated runtime", async () => {
  const f = fixture();
  const start = Date.now();
  const ref = await f.remote().save(save, signal);
  assert.equal(ref.tenantId, "cloudflare");
  assert.ok(ref.expiresAt >= start + 86_400_000 && ref.expiresAt <= Date.now() + 86_400_000);
  assert.equal(f.db.rows.size, 2);
  assert.equal(f.bucket.objects.size, 2);
  const chunks: Buffer[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const chunk = await f.remote().read(ref.refId, caller, offset, 48 * 1024, signal);
    chunks.push(Buffer.from(chunk.dataBase64, "base64"));
    offset = chunk.nextOffset;
  }
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()) as unknown, save.payload);
  assert.deepEqual(await f.remote().delete(ref.refId, caller, signal), { deleted: true, cleanupPending: false });
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.bucket.objects.size, 0);
  await assert.rejects(f.remote().read(ref.refId, caller, 0, 100, signal));
});

void test("bridge caller namespace and credential isolation reject substituted identities", async () => {
  const f = fixture();
  const ref = await f.remote().save(save, signal);
  for (const alternate of [{ ...caller, tenantId: "other" }, { ...caller, ownerId: "other" }, { ...caller, credentialBinding: "other" }]) {
    await assert.rejects(f.remote().read(ref.refId, alternate, 0, 100, signal));
    await assert.rejects(f.remote().delete(ref.refId, alternate, signal));
  }
  const other = { ...caller, credentialBinding: "managed:two" };
  await assert.rejects(f.remote(other.credentialBinding).read(ref.refId, other, 0, 100, signal));
  await assert.rejects(f.remote(other.credentialBinding).delete(ref.refId, other, signal));
  assert.equal(f.bucket.objects.size, 2);
});

void test("bridge rejects tampering, unsigned requests, invalid paths and operation-purpose mismatches before storage", async () => {
  const f = fixture();
  const original = await signed(saveFields);
  const headers = new Headers(original.headers);
  headers.delete(INTERNAL_CONTEXT_HEADER);
  const body = await original.text();
  const init = { method: "POST", headers: original.headers, body };
  const variants = [
    new Request(original.url, { ...init, headers }),
    new Request(original.url, { ...init, body: JSON.stringify({ ...saveFields, payload: "tampered" }) }),
    new Request("http://groundlane-output.internal/v1/read", init),
    new Request("http://untrusted.internal/v1/save", init),
    new Request("http://groundlane-output.internal/v1/save?extra=1", init),
    await signed({ operation: "read", refId: "art_one", offset: 0, maxBytes: 10 }),
  ];
  for (const request of variants) {
    const response = await f.fetcher(request);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), '{"ok":false,"error":"DOCUMENT_OUTPUT_UNAVAILABLE"}');
  }
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.bucket.objects.size, 0);
});

void test("bridge fails closed for missing environment and refuses Container TTL overrides", async () => {
  const f = fixture();
  for (const env of [
    {}, { ...f.env, DOCUMENT_OUTPUT_EDGE_ENABLED: "false" }, { ...f.env, GROUNDLANE_INTERNAL_SIGNING_SECRET: "" },
    { DOCUMENT_OUTPUT_EDGE_ENABLED: "true", GROUNDLANE_INTERNAL_SIGNING_SECRET: secret },
  ]) {
    assert.equal((await f.outbound(await signed(saveFields), env, context)).status, 503);
  }
  assert.equal((await f.outbound(await signed(saveFields), f.env, { ...context, className: "Other" })).status, 503);
  for (const extra of [{ ttlSeconds: 2_592_000 }, { tenantId: "other" }, { caller }, { sourceExpiresAt: 0 }]) {
    assert.equal((await f.fetcher(await signed({ ...saveFields, ...extra }))).status, 400);
  }
  const ref = await f.remote().save({ ...save, sourceExpiresAt: Date.now() + 60_000 }, signal);
  assert.ok(ref.expiresAt <= Date.now() + 60_000);
});

void test("bridge expiry and cancellation reject before side effects", async () => {
  const f = fixture();
  assert.equal((await f.fetcher(await signed({ ...saveFields, deadlineAt: Date.now() - 1 }))).status, 408);
  assert.equal((await f.fetcher(await signed(saveFields, "save", AbortSignal.abort()))).status, 408);
  await assert.rejects(f.remote().save(save, AbortSignal.abort()), { code: "CANCELLED" });
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.bucket.objects.size, 0);
});

void test("bridge bounds streamed request and response bodies without trusting Content-Length", async () => {
  const f = fixture();
  let cancelled = 0;
  const oversized = () => new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled++; },
  });
  const request = await signed(saveFields);
  const streaming = new Request(request, { body: oversized(), duplex: "half" } as RequestInit);
  assert.equal((await f.fetcher(streaming)).status, 400);
  assert.equal(cancelled, 1);
  const remote = new RemoteDocumentOutputRuntime({ signingSecret: secret, principal, credentialBinding: caller.credentialBinding, subtle, timeoutMs: 5000,
    fetch: () => Promise.resolve(new Response(oversized())),
  });
  await assert.rejects(remote.save(save, signal), { code: "UPSTREAM_ERROR" });
  assert.equal(cancelled, 2);
  assert.equal(f.db.rows.size, 0);
  assert.ok(DOCUMENT_OUTPUT_MAX_BODY_BYTES < 20 * 1024 * 1024);
});

void test("remote output deadline cancels a stalled response stream", async () => {
  let cancelled = false;
  const remote = new RemoteDocumentOutputRuntime({ signingSecret: secret, principal, credentialBinding: caller.credentialBinding, subtle, timeoutMs: 20,
    fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }))),
  });
  const result = await Promise.race([
    remote.save(save, signal).then(() => "resolved", (error: unknown) => error),
    new Promise<string>(resolve => setTimeout(() => resolve("stalled"), 500)),
  ]);
  assert.notEqual(result, "stalled", "deadline must interrupt response-body reads");
  assert.ok(result instanceof Error && "code" in result && result.code === "DEADLINE_EXCEEDED");
  assert.equal(cancelled, true);
});

void test("Worker request cancellation interrupts a stalled upload bridge body without storage effects", async () => {
  const f = fixture();
  const controller = new AbortController();
  let cancelled = false;
  const request = await signed(saveFields, "save", controller.signal);
  const init: RequestInit & { duplex: string } = {
    method: "POST", headers: request.headers, signal: controller.signal, duplex: "half",
    body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
  };
  const pending = f.fetcher(new Request(request.url, init));
  controller.abort();
  const response = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
  assert.ok(response !== null, "abort must interrupt request-body reads");
  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.bucket.objects.size, 0);
});
