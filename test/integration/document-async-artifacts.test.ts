import assert from "node:assert/strict";
import test from "node:test";

import { DurableDocumentAsyncArtifacts } from "../../src/core/document-async-artifacts.js";
import { buildCanonicalEnvelopeFromAdapter, projectCanonicalDocument } from "../../src/core/canonical-document.js";
import { DurableUploadArtifactService } from "../../src/core/durable-upload-flow.js";
import { D1DurableRecordStore } from "../../src/worker/d1-durable-store.js";
import { createEdgeDocumentOutputRuntime } from "../../src/worker/document-output-runtime.js";
import { R2ImmutableBlobStore } from "../../src/worker/r2-immutable-blob.js";
import { FakeD1, FakeR2 } from "../support/document-output-bindings.js";
import { DocumentAsyncRuntime } from "../../src/core/document-async-runtime.js";
import { DurableEffectJournal } from "../../src/core/durable-effects.js";
import { DurableDocumentJobRepository } from "../../src/core/durable-document-jobs.js";
import type { DurableRecordStorePort } from "../../src/core/durable-store.js";
import { Deadline } from "../../src/core/limits.js";

const caller = { ownerId: "owner", credentialBinding: "credential" };
const outputCaller = { ...caller, tenantId: "cloudflare" };
const signal = new AbortController().signal;
const bytes = new TextEncoder().encode("synthetic document");

async function setup() {
  let now = 1_800_000_000_000;
  const env = { MANAGED_TOKEN_D1: new FakeD1(), GROUNDLANE_ARTIFACTS: new FakeR2() };
  const uploads = new DurableUploadArtifactService(new D1DurableRecordStore(env.MANAGED_TOKEN_D1, "artifact-upload-v1"),
    new R2ImmutableBlobStore(env.GROUNDLANE_ARTIFACTS));
  const intent = await uploads.createIntent({ idempotencyKey: "source", declaredMime: "text/plain",
    declaredSize: bytes.byteLength, filename: "source.txt", nowMs: now }, caller);
  const source = await uploads.finalize({ intentId: intent.intentId, bytes, observedMime: "text/plain", nowMs: now }, caller);
  const outputs = () => createEdgeDocumentOutputRuntime(env, { now: () => now }).runtime;
  const adapter = () => new DurableDocumentAsyncArtifacts(uploads, outputs(), "cloudflare", () => now);
  const snapshot = await adapter().inspectSource(source.refId, caller, signal);
  const envelope = buildCanonicalEnvelopeFromAdapter({ documentId: "synthetic", sourceIdentity: { contentHash: snapshot.contentHash, artifactRef: source.refId },
    blocks: [{ type: "text", blockId: "body", content: "parsed synthetic document" }], readingOrder: ["body"],
    status: "success", capabilityStates: { text: "available" },
    provenance: { engine: "fixture", model: "fixture", version: "1", cost: 0, confidence: 1 },
  });
  const result = new TextEncoder().encode(JSON.stringify(envelope));
  return { env, uploads, outputs, adapter, snapshot, result, envelope, now: () => now, setNow: (value: number) => { now = value; } };
}

void test("async artifact adapter stores canonical bytes in native D1/R2 output composition and survives recreation", async () => {
  const f = await setup();
  assert.deepEqual(await f.adapter().readSource(f.snapshot.refId, caller, 100, signal), bytes);
  const ref = await f.adapter().writeResult("job", f.result, caller, f.now() + 60_000, signal, f.snapshot);
  const read = await f.outputs().read(ref, outputCaller, 0, 4096, signal);
  assert.deepEqual(JSON.parse(Buffer.from(read.dataBase64, "base64").toString()) as unknown,
    { envelope: f.envelope, projection: projectCanonicalDocument(f.envelope, "markdown") });
  assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 3);
  assert.deepEqual(await f.adapter().revokeResult(ref, caller, signal), { deleted: true, cleanupPending: false });
  assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 1);
  assert.deepEqual(await f.adapter().readSource(f.snapshot.refId, caller, 100, signal), bytes);
});

void test("async output read is revoked when its original verified upload is deleted", async () => {
  const f = await setup();
  const ref = await f.adapter().writeResult("job", f.result, caller, f.now() + 60_000, signal, f.snapshot);
  await f.uploads.deleteArtifact(f.snapshot.refId, caller, f.now());
  await assert.rejects(f.outputs().read(ref, outputCaller, 0, 100, signal));
  await assert.rejects(f.adapter().writeResult("job", f.result, caller, f.now() + 60_000, signal, f.snapshot));
});

void test("async source isolation, integrity, byte bounds and cancellation fail before result publication", async () => {
  const f = await setup();
  await assert.rejects(f.adapter().inspectSource(f.snapshot.refId, { ...caller, credentialBinding: "other" }, signal));
  await assert.rejects(f.adapter().readSource(f.snapshot.refId, caller, 1, signal), { code: "OUTPUT_LIMIT" });
  await assert.rejects(f.adapter().writeResult("job", f.result, caller, f.now() + 60_000, signal, { ...f.snapshot, byteSize: 99 }));
  await assert.rejects(f.adapter().writeResult("job", new TextEncoder().encode("invalid JSON"), caller, f.now() + 60_000, signal, f.snapshot));
  await assert.rejects(f.adapter().writeResult("job", f.result, caller, f.now() + 60_000, AbortSignal.abort(), f.snapshot));
  assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 1);
});

void test("async result expiry is capped and failed cleanup remains retryable after recreation", async () => {
  const f = await setup();
  const ref = await f.adapter().writeResult("job", f.result, caller, f.now() + 60_000, signal, f.snapshot);
  f.env.GROUNDLANE_ARTIFACTS.failDelete = true;
  assert.equal((await f.adapter().revokeResult(ref, caller, signal)).cleanupPending, true);
  await assert.rejects(f.outputs().read(ref, outputCaller, 0, 100, signal));
  f.env.GROUNDLANE_ARTIFACTS.failDelete = false;
  assert.equal((await f.adapter().revokeResult(ref, caller, signal)).cleanupPending, false);
  const second = await f.adapter().writeResult("job-2", f.result, caller, f.now() + 60_000, signal, f.snapshot);
  f.setNow(f.now() + 60_001);
  await assert.rejects(f.outputs().read(second, outputCaller, 0, 100, signal));
});

for (const action of ["resume", "cancel"] as const) {
  void test(`D1/R2 output reservation recovers lost runtime acknowledgment on restart then ${action}`, async () => {
    const f = await setup();
    let failAcknowledgment = true;
    class InterruptedAckStore extends D1DurableRecordStore {
      override compareAndSwap(...args: Parameters<DurableRecordStorePort["compareAndSwap"]>) {
        const value: unknown = JSON.parse(args[2].value);
        if (failAcknowledgment && args[0].startsWith("document-async:") && typeof value === "object" && value !== null &&
            "resultArtifactRef" in value && typeof value.resultArtifactRef === "string") {
          failAcknowledgment = false;
          return Promise.reject(new Error("D1 result acknowledgment interrupted after R2 save"));
        }
        return super.compareAndSwap(...args);
      }
    }
    let submissions = 0;
    const provider = { providerId: "fixture", create: () => { submissions += 1; return Promise.resolve("paid-task"); },
      poll: () => Promise.resolve({ status: "completed" as const, envelope: f.envelope }),
      cancel: () => Promise.resolve({ acknowledged: false }),
    };
    const runtime = () => {
      const store = new InterruptedAckStore(f.env.MANAGED_TOKEN_D1, "async-crash-test");
      const effects = new DurableEffectJournal(store);
      return new DocumentAsyncRuntime(store, new DurableDocumentJobRepository(store, effects), effects, f.adapter(), provider, f.now);
    };
    const created = await runtime().create({ mode: "async", sourceRefId: f.snapshot.refId, idempotencyKey: "request", expiresAt: f.now() + 60_000,
      policy: { absoluteDeadlineMs: f.now() + 50_000, totalExecutionBudgetMs: 50_000, perAttemptDeadlineMs: 5000,
        maxInputBytes: 1000, maxOutputBytes: 10_000 } }, caller, new Deadline(5000));
    await assert.rejects(runtime().advance(created.job.jobId, caller), /uncertain/u);
    assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 3);
    const recovered = await f.adapter().recoverResult(created.job.jobId, caller, signal);
    assert.equal(recovered?.ready, true);
    if (action === "cancel") {
      await runtime().cancel(created.job.jobId, caller, false, new Deadline(5000));
      await runtime().advance(created.job.jobId, caller);
      assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 1);
    } else {
      await runtime().advance(created.job.jobId, caller);
      const status = await runtime().status(created.job.jobId, caller, new Deadline(5000));
      assert.equal(status.job.status, "completed");
      assert.equal(status.job.resultArtifactRef, recovered?.refId);
      assert.equal(f.env.GROUNDLANE_ARTIFACTS.objects.size, 3);
    }
    assert.equal(submissions, 1);
  });
}
