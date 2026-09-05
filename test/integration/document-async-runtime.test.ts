import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { SqliteImmutableBlobStore } from "../../src/adapters/state/sqlite-immutable-blob.js";
import { buildCanonicalEnvelopeFromAdapter } from "../../src/core/canonical-document.js";
import { DocumentAsyncRuntime, type DocumentAsyncArtifactPort, type DocumentAsyncProviderPort } from "../../src/core/document-async-runtime.js";
import { DurableDocumentJobRepository } from "../../src/core/durable-document-jobs.js";
import { DurableEffectJournal } from "../../src/core/durable-effects.js";
import { InMemoryDurableRecordStore, type DurableRecordStorePort } from "../../src/core/durable-store.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { Deadline } from "../../src/core/limits.js";

const caller = { ownerId: "owner", credentialBinding: "credential" };
const sourceBytes = new TextEncoder().encode("source document");
const digest = (bytes: Uint8Array): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
const source = { refId: "source", byteSize: sourceBytes.byteLength, contentHash: digest(sourceBytes), expiresAt: 50_000 };
const envelope = buildCanonicalEnvelopeFromAdapter({
  documentId: "document", sourceIdentity: { contentHash: source.contentHash, artifactRef: source.refId },
  blocks: [{ type: "text", blockId: "body", content: "parsed source document" }], readingOrder: ["body"], status: "success",
  capabilityStates: { text: "available", tables: "unsupported", images: "unsupported" },
  provenance: { engine: "fixture-provider", model: "none", version: "1", cost: 0, confidence: 1 },
});
const input = {
  mode: "async" as const, idempotencyKey: "request", sourceRefId: source.refId, expiresAt: 40_000,
  policy: { absoluteDeadlineMs: 30_000, totalExecutionBudgetMs: 20_000, perAttemptDeadlineMs: 1_000, maxInputBytes: 1_000, maxOutputBytes: 10_000 },
};

void test("source revocation cancels queued jobs at source expiry without claiming upstream cancellation", async () => {
  const fixture = setup(); const runtime = fixture.runtime();
  const created = await runtime.create(input, caller, new Deadline(1_000));
  fixture.setNow(50_000);
  const revoked = await runtime.revokeSource(created.job.jobId, caller, "expired", new Deadline(1_000));
  assert.equal(revoked.job.status, "cancelled");
  assert.equal(revoked.sourceRevocation, "expired"); assert.equal(revoked.upstreamAcknowledged, false);
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal(fixture.counts().creates, 0);
});

void test("source deletion revokes completed result access and retains retryable cleanup", async () => {
  const fixture = setup(); fixture.complete(); const runtime = fixture.runtime();
  const created = await runtime.create(input, caller, new Deadline(1_000));
  await runtime.advance(created.job.jobId, caller);
  let pending = true; let cleanups = 0;
  fixture.artifacts.revokeResult = () => { cleanups++; return Promise.resolve({ cleanupPending: pending }); };
  const revoked = await runtime.revokeSource(created.job.jobId, caller, "deleted", new Deadline(1_000));
  assert.equal(revoked.job.status, "completed"); assert.equal(revoked.job.resultArtifactRef, null);
  assert.equal(revoked.resultCleanupPending, true); assert.equal(revoked.sourceRevocation, "deleted");
  pending = false; await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal((await runtime.status(created.job.jobId, caller, new Deadline(1_000))).resultCleanupPending, false);
  assert.ok(cleanups >= 2); assert.equal(fixture.counts().creates, 1);
});

function setup(store: DurableRecordStorePort = new InMemoryDurableRecordStore()) {
  let now = 1_000;
  let creates = 0;
  let writes = 0;
  let polls = 0;
  let cancels = 0;
  let complete = false;
  const outputs = new Map<string, Uint8Array>();
  const artifacts: DocumentAsyncArtifactPort = {
    inspectSource: () => Promise.resolve(source), readSource: () => Promise.resolve(sourceBytes),
    writeResult: (jobId, bytes) => { writes += 1; outputs.set(jobId, bytes); return Promise.resolve(`result-${jobId}`); },
    revokeResult: (ref) => { outputs.delete(ref.replace(/^result-/u, "")); return Promise.resolve({ cleanupPending: false }); },
    recoverResult: () => Promise.resolve(null),
  };
  const provider: DocumentAsyncProviderPort = {
    providerId: "fixture-provider",
    create: (bytes) => { assert.deepEqual(bytes, sourceBytes); creates += 1; return Promise.resolve("private-provider-job"); },
    poll: (providerId) => { assert.equal(providerId, "private-provider-job"); polls += 1; return Promise.resolve(complete ? { status: "completed", envelope } : { status: "running" }); },
    cancel: () => { cancels += 1; return Promise.resolve({ acknowledged: false }); },
  };
  const runtime = (): DocumentAsyncRuntime => {
    const effects = new DurableEffectJournal(store);
    return new DocumentAsyncRuntime(store, new DurableDocumentJobRepository(store, effects), effects, artifacts, provider, () => now);
  };
  return { runtime, provider, artifacts, outputs, store, setNow: (value: number) => { now = value; },
    complete: () => { complete = true; }, counts: () => ({ creates, writes, polls, cancels }) };
}

void test("cancel racing acknowledged output write retries durable cleanup after runtime restart", async () => {
  const fixture = setup();
  fixture.complete();
  const runtime = fixture.runtime();
  const created = await runtime.create(input, caller, new Deadline(1_000));
  let entered: () => void = () => undefined;
  let acknowledge: (ref: string) => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  fixture.artifacts.writeResult = () => new Promise<string>((resolve) => { acknowledge = resolve; entered(); });
  let cleanupPending = true;
  let cleanups = 0;
  fixture.artifacts.revokeResult = (ref) => {
    assert.equal(ref, "late-output"); cleanups += 1;
    return Promise.resolve({ cleanupPending });
  };
  const running = assert.rejects(runtime.advance(created.job.jobId, caller), /cancelled/u);
  await started;
  await runtime.cancel(created.job.jobId, caller, false, new Deadline(1_000));
  acknowledge("late-output");
  await running;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(cleanups > 0);
  assert.equal((await runtime.status(created.job.jobId, caller, new Deadline(1_000))).resultCleanupPending, true);
  cleanupPending = false;
  await fixture.runtime().advance(created.job.jobId, caller);
  const cleaned = cleanups;
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal(cleanups, cleaned);
  assert.equal((await runtime.status(created.job.jobId, caller, new Deadline(1_000))).resultCleanupPending, false);
  assert.equal((await runtime.status(created.job.jobId, caller, new Deadline(1_000))).job.status, "cancelled");
});

void test("expiry after result acknowledgment cleans output but cancelling completed jobs preserves it", async () => {
  const fixture = setup();
  fixture.complete();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  const originalWrite = fixture.artifacts.writeResult.bind(fixture.artifacts);
  fixture.artifacts.writeResult = async (...args) => {
    const ref = await originalWrite(...args);
    fixture.setNow(35_000);
    return ref;
  };
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller));
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal(fixture.outputs.size, 0);
  const completed = setup();
  completed.complete();
  const successful = await completed.runtime().create(input, caller, new Deadline(1_000));
  await completed.runtime().advance(successful.job.jobId, caller);
  await completed.runtime().cancel(successful.job.jobId, caller, true, new Deadline(1_000));
  await completed.runtime().advance(successful.job.jobId, caller);
  assert.equal(completed.outputs.size, 1);
});

void test("acknowledged result recovers after journal failure without writing output twice", async () => {
  class LostResultReceipt extends InMemoryDurableRecordStore {
    fail = true;
    override compareAndSwap(...args: Parameters<DurableRecordStorePort["compareAndSwap"]>) {
      const value: unknown = JSON.parse(args[2].value);
      if (this.fail && typeof value === "object" && value !== null && "effectKind" in value &&
          value.effectKind === "artifact_write" && "status" in value && value.status === "succeeded") {
        this.fail = false;
        return Promise.reject(new Error("result receipt interrupted"));
      }
      return super.compareAndSwap(...args);
    }
  }
  const fixture = setup(new LostResultReceipt());
  fixture.complete();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /uncertain/u);
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal(fixture.counts().writes, 1);
  assert.equal((await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000))).job.status, "completed");
});

void test("failed completion transition leaves a durable result for terminal cleanup", async () => {
  class CompletionRaceStore extends InMemoryDurableRecordStore {
    override compareAndSwap(...args: Parameters<DurableRecordStorePort["compareAndSwap"]>) {
      const value: unknown = JSON.parse(args[2].value);
      if (typeof value === "object" && value !== null && "status" in value && value.status === "completed") {
        return super.compareAndSwap(args[0], args[1], { ...args[2],
          value: JSON.stringify({ ...value, status: "failed", resultArtifactRef: null, sanitizedError: "Concurrent failure" }),
        });
      }
      return super.compareAndSwap(...args);
    }
  }
  const fixture = setup(new CompletionRaceStore());
  fixture.complete();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal((await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000))).job.status, "failed");
  assert.equal(fixture.outputs.size, 0);
});

void test("dispatcher abort cancels its active attempt without cancelling the durable job", async () => {
  const fixture = setup();
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  fixture.provider.poll = (_id, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Dispatcher aborted")), { once: true });
    entered();
  });
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  const controller = new AbortController();
  const result = assert.rejects(fixture.runtime().advance(created.job.jobId, caller, controller.signal));
  await started;
  controller.abort();
  await result;
  assert.equal((await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000))).job.status, "running");
});
void test("acknowledged provider mapping recovers after receipt persistence failure without another paid create", async () => {
  class LostReceiptStore extends InMemoryDurableRecordStore {
    fail = true;
    override compareAndSwap(...args: Parameters<DurableRecordStorePort["compareAndSwap"]>) {
      const value: unknown = JSON.parse(args[2].value);
      if (this.fail && typeof value === "object" && value !== null && "effectKind" in value &&
          value.effectKind === "provider_task_create" && "status" in value && value.status === "succeeded") {
        this.fail = false;
        return Promise.reject(new Error("receipt persistence interrupted"));
      }
      return super.compareAndSwap(...args);
    }
  }
  const fixture = setup(new LostReceiptStore());
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /uncertain/u);
  fixture.complete();
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal((await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000))).job.status, "completed");
  assert.equal(fixture.counts().creates, 1);
});

void test("public async create and status omit caller credential binding", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  const status = await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000));
  for (const value of [created, status]) {
    assert.equal(Object.hasOwn(value.job, "credentialBinding"), false);
    assert.equal(JSON.stringify(value).includes('"credential"'), false);
  }
});

void test("explicit create acknowledges metadata only; restart resumes the same provider and canonical output", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  const reused = await fixture.runtime().create(input, caller, new Deadline(1_000));
  assert.equal(created.job.jobId, reused.job.jobId);
  assert.equal(fixture.counts().creates, 0);
  await fixture.runtime().advance(created.job.jobId, caller);
  fixture.complete();
  await fixture.runtime().advance(created.job.jobId, caller);
  await fixture.runtime().advance(created.job.jobId, caller);
  const status = await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000));
  assert.equal(status.job.status, "completed");
  assert.equal(JSON.stringify(status).includes("private-provider-job"), false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fixture.outputs.get(created.job.jobId))), envelope);
  assert.deepEqual(fixture.counts(), { creates: 1, writes: 1, polls: 2, cancels: 0 });
});

void test("SQLite reopen preserves submission receipts and immutable canonical result bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-async-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  const first = new SqliteDurableRecordStore(path, "async");
  const blobs = new SqliteImmutableBlobStore(path, "async-blobs");
  t.after(() => blobs.close());
  const sourceKey = `blobs/${source.contentHash.slice(7)}`;
  await blobs.putIfAbsent({ blobKey: sourceKey, ownerId: caller.ownerId, digest: source.contentHash, bytes: sourceBytes });
  const fixture = setup(first);
  fixture.artifacts.readSource = async () => {
    const result = await blobs.get({ blobKey: sourceKey, ownerId: caller.ownerId, digest: source.contentHash, maxBytes: 1_000 });
    assert.ok(result);
    return result;
  };
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await fixture.runtime().advance(created.job.jobId, caller);
  first.close();
  const reopened = new SqliteDurableRecordStore(path, "async");
  t.after(() => reopened.close());
  const second = setup(reopened);
  second.complete();
  let resultDigest = "";
  second.artifacts.writeResult = async (jobId, bytes) => {
    resultDigest = digest(bytes);
    const result = await blobs.putIfAbsent({ blobKey: `blobs/${resultDigest.slice(7)}`, ownerId: caller.ownerId, digest: resultDigest, bytes });
    assert.equal(result.status, "created");
    return jobId;
  };
  await second.runtime().advance(created.job.jobId, caller);
  const bytes = await blobs.get({ blobKey: `blobs/${resultDigest.slice(7)}`, ownerId: caller.ownerId, digest: resultDigest, maxBytes: 10_000 });
  assert.ok(bytes);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), envelope);
  assert.equal(second.counts().creates, 0);
});

void test("uncertain provider submission cannot repeat on restart or retry", async () => {
  const fixture = setup();
  let calls = 0;
  fixture.provider.create = () => { calls += 1; return Promise.reject(new Error("secret upstream body")); };
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /outcome is uncertain/u);
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /automatic repeat is prohibited/u);
  assert.equal(calls, 1);
});

void test("concurrent cancellation recovery claims one retry and never repeats provider submission", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await fixture.runtime().advance(created.job.jobId, caller);
  await fixture.runtime().cancel(created.job.jobId, caller, true, new Deadline(1_000));
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let acknowledge: (value: { acknowledged: boolean }) => void = () => undefined;
  let attempts = 0;
  fixture.provider.cancel = () => {
    attempts += 1;
    entered();
    return new Promise((resolve) => { acknowledge = resolve; });
  };
  const pending = fixture.runtime().reconcileCancellation(created.job.jobId, caller, new Deadline(1_000));
  await started;
  await assert.rejects(fixture.runtime().reconcileCancellation(created.job.jobId, caller, new Deadline(1_000)), /claimed or inflight/u);
  acknowledge({ acknowledged: true });
  await pending;
  assert.equal(attempts, 1);
  assert.equal(fixture.counts().creates, 1);
});

void test("a late negative cancellation result cannot overwrite a newer durable acknowledgment", async () => {
  let delayNegative = false;
  let entered: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release: () => void = () => undefined;
  const resume = new Promise<void>((resolve) => { release = resolve; });
  class DelayedCancellationStore extends InMemoryDurableRecordStore {
    override async compareAndSwap(...args: Parameters<InMemoryDurableRecordStore["compareAndSwap"]>) {
      if (delayNegative && args[0].startsWith("document-async:")) {
        delayNegative = false;
        entered();
        await resume;
      }
      return super.compareAndSwap(...args);
    }
  }
  const fixture = setup(new DelayedCancellationStore());
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await fixture.runtime().advance(created.job.jobId, caller);
  fixture.provider.cancel = () => { delayNegative = true; return Promise.resolve({ acknowledged: false }); };
  const firstCancel = fixture.runtime().cancel(created.job.jobId, caller, true, new Deadline(1_000));
  await waiting;
  fixture.provider.cancel = () => Promise.resolve({ acknowledged: true });
  await fixture.runtime().reconcileCancellation(created.job.jobId, caller, new Deadline(1_000));
  release();
  await firstCancel;
  assert.equal((await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000))).upstreamAcknowledged, true);
});

for (const firstOutcome of ["unacknowledged", "rejected", "legacy-unacknowledged"] as const) {
  void test(`SQLite restart retries ${firstOutcome} cancellation without repeating billable submission`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "groundlane-cancel-replay-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "state.sqlite");
    const firstStore = new SqliteDurableRecordStore(path, "async");
    const first = setup(firstStore);
    const created = await first.runtime().create(input, caller, new Deadline(1_000));
    await first.runtime().advance(created.job.jobId, caller);
    let cancelCalls = 0;
    first.provider.cancel = () => {
      cancelCalls += 1;
      return firstOutcome === "rejected" ? Promise.reject(new Error("ambiguous cancellation")) : Promise.resolve({ acknowledged: false });
    };
    const cancelling = first.runtime().cancel(created.job.jobId, caller, true, new Deadline(1_000));
    if (firstOutcome === "rejected") await assert.rejects(cancelling, /uncertain/u);
    else assert.equal((await cancelling).upstreamAcknowledged, false);
    assert.equal((await first.runtime().status(created.job.jobId, caller, new Deadline(1_000))).upstreamAcknowledged, false);
    if (firstOutcome === "legacy-unacknowledged") {
      const effects = new DurableEffectJournal(firstStore);
      const identity = { jobId: created.job.jobId, effectKind: "provider_task_cancel" as const, operationKey: "document-async-v1" };
      const prior = await effects.claim(identity.jobId, identity.effectKind, identity.operationKey, 1_000);
      await effects.transition(identity, prior.revision, "succeeded", 1_000, "not-acknowledged");
    }
    firstStore.close();

    const reopened = new SqliteDurableRecordStore(path, "async");
    t.after(() => reopened.close());
    const second = setup(reopened);
    second.provider.cancel = () => { cancelCalls += 1; return Promise.resolve({ acknowledged: true }); };
    await second.runtime().reconcileCancellation(created.job.jobId, caller, new Deadline(1_000));
    assert.equal((await second.runtime().status(created.job.jobId, caller, new Deadline(1_000))).upstreamAcknowledged, true);
    await second.runtime().reconcileCancellation(created.job.jobId, caller, new Deadline(1_000));
    assert.equal(cancelCalls, 2);
    assert.equal(first.counts().creates, 1);
    assert.equal(second.counts().creates, 0);
    assert.equal(second.counts().writes, 0);
  });
}

void test("create timeout invokes no provider; acknowledged job survives caller poll abort", async () => {
  const fixture = setup();
  const original = fixture.artifacts.inspectSource.bind(fixture.artifacts);
  fixture.artifacts.inspectSource = () => new Promise(() => undefined);
  await assert.rejects(fixture.runtime().create(input, caller, new Deadline(10)), /deadline/u);
  assert.equal(fixture.counts().creates, 0);
  fixture.artifacts.inspectSource = original;
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000), controller.signal), /cancelled/u);
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal((await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000))).job.status, "running");
});

for (const deadline of ["absolute", "total"] as const) {
  void test(`${deadline} execution deadline remains fixed after retry`, async () => {
    const fixture = setup();
    const policy = { ...input.policy, ...(deadline === "absolute" ? { absoluteDeadlineMs: 2_000 } : { totalExecutionBudgetMs: 1_000 }) };
    const created = await fixture.runtime().create({ ...input, policy }, caller, new Deadline(1_000));
    await fixture.runtime().advance(created.job.jobId, caller);
    fixture.setNow(2_000);
    await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /budget exhausted/u);
    assert.equal(fixture.counts().creates, 1);
    assert.equal(fixture.counts().polls, 1);
  });
}

void test("per-attempt timeout aborts polling without recreating provider work", async () => {
  const fixture = setup();
  let observed: AbortSignal | undefined;
  fixture.provider.poll = (_id, signal) => { observed = signal; return new Promise(() => undefined); };
  const created = await fixture.runtime().create({ ...input, policy: { ...input.policy, perAttemptDeadlineMs: 10 } }, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /deadline/u);
  assert.equal(observed?.aborted, true);
  fixture.provider.poll = () => Promise.resolve({ status: "running" });
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal(fixture.counts().creates, 1);
});

void test("owner explicit cancel durably stops dispatch and never invents upstream acknowledgment", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await fixture.runtime().advance(created.job.jobId, caller);
  const result = await fixture.runtime().cancel(created.job.jobId, caller, true, new Deadline(1_000));
  assert.equal(result.job.status, "cancelled");
  assert.equal(result.dispatchCancelled, true);
  assert.equal(result.upstreamRequested, true);
  assert.equal(result.upstreamAcknowledged, false);
  await fixture.runtime().advance(created.job.jobId, caller);
  assert.equal(fixture.counts().polls, 1);
});

void test("credential mismatch blocks status, dispatch and cancellation", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  const other = { ...caller, credentialBinding: "other" };
  await assert.rejects(fixture.runtime().status(created.job.jobId, other, new Deadline(1_000)), /binding mismatch/u);
  await assert.rejects(fixture.runtime().advance(created.job.jobId, other), /binding mismatch/u);
  await assert.rejects(fixture.runtime().cancel(created.job.jobId, other, true, new Deadline(1_000)), /binding mismatch/u);
});

void test("changed source bytes fail closed before any provider submission", async () => {
  const fixture = setup();
  fixture.artifacts.readSource = () => Promise.resolve(new TextEncoder().encode("tampered"));
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /outcome is uncertain/u);
  assert.equal(fixture.counts().creates, 0);
});

void test("cancel persists terminal lifecycle even when upstream cancellation times out", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await fixture.runtime().advance(created.job.jobId, caller);
  fixture.provider.cancel = () => new Promise(() => undefined);
  await assert.rejects(fixture.runtime().cancel(created.job.jobId, caller, true, new Deadline(10)), /deadline/u);
  const status = await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000));
  assert.equal(status.job.status, "cancelled");
  assert.equal(status.upstreamRequested, true);
  assert.equal(status.upstreamAcknowledged, false);
});

void test("absolute deadline is materialized in read status", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  fixture.setNow(22_000);
  const status = await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000));
  assert.equal(status.job.status, "expired");
});

void test("uncertain output writes never repeat even if dispatcher restarts", async () => {
  const fixture = setup();
  fixture.complete();
  let writes = 0;
  fixture.artifacts.writeResult = () => { writes += 1; return Promise.reject(new Error("storage response lost")); };
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /uncertain/u);
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /automatic repeat/u);
  assert.equal(writes, 1);
  assert.equal(fixture.counts().creates, 1);
});

void test("canonical output byte cap rejects before artifact persistence", async () => {
  const fixture = setup();
  fixture.complete();
  const created = await fixture.runtime().create({ ...input, policy: { ...input.policy, maxOutputBytes: 10 } }, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /exceeds byte limit/u);
  assert.equal(fixture.counts().writes, 0);
});

void test("acknowledged upstream cancellation survives restart", async () => {
  const fixture = setup();
  fixture.provider.cancel = () => Promise.resolve({ acknowledged: true });
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await fixture.runtime().advance(created.job.jobId, caller);
  await fixture.runtime().cancel(created.job.jobId, caller, true, new Deadline(1_000));
  assert.equal((await fixture.runtime().status(created.job.jobId, caller, new Deadline(1_000))).upstreamAcknowledged, true);
});

void test("source revocation during provider poll prevents result artifact writes", async () => {
  const fixture = setup();
  fixture.provider.poll = () => {
    fixture.artifacts.inspectSource = () => Promise.reject(new GroundlaneError("INVALID_INPUT", "artifact", "Source revoked"));
    return Promise.resolve({ status: "completed", envelope });
  };
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), /revoked/u);
  assert.equal(fixture.counts().writes, 0);
});

void test("provider rate limits retain stable code without exposing upstream message", async () => {
  const fixture = setup();
  fixture.provider.poll = () => Promise.reject(new GroundlaneError("RATE_LIMITED", "provider", "private response body"));
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  await assert.rejects(fixture.runtime().advance(created.job.jobId, caller), (error: unknown) =>
    error instanceof GroundlaneError && error.code === "RATE_LIMITED" && !error.message.includes("private"));
});

void test("submission acknowledgment racing with explicit cancel retains provider mapping for later upstream cancel", async () => {
  const fixture = setup();
  let acknowledge: (value: string) => void = () => undefined;
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  fixture.provider.create = () => new Promise<string>((resolve) => { acknowledge = resolve; entered(); });
  fixture.provider.cancel = (id) => { assert.equal(id, "late-provider-job"); return Promise.resolve({ acknowledged: true }); };
  const runtime = fixture.runtime();
  const created = await runtime.create(input, caller, new Deadline(1_000));
  const attempt = assert.rejects(runtime.advance(created.job.jobId, caller), /cancelled/u);
  await started;
  await runtime.cancel(created.job.jobId, caller, false, new Deadline(1_000));
  acknowledge("late-provider-job");
  await attempt;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelled = await fixture.runtime().cancel(created.job.jobId, caller, true, new Deadline(1_000));
  assert.equal(cancelled.upstreamAcknowledged, true);
});

void test("late provider create acknowledgment reconciles an already requested upstream cancel", async () => {
  const fixture = setup();
  let acknowledge: (value: string) => void = () => undefined;
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  fixture.provider.create = () => new Promise<string>((resolve) => { acknowledge = resolve; entered(); });
  const runtime = fixture.runtime();
  const created = await runtime.create(input, caller, new Deadline(1_000));
  const attempt = assert.rejects(runtime.advance(created.job.jobId, caller), /cancelled/u);
  await started;
  await runtime.cancel(created.job.jobId, caller, true, new Deadline(1_000));
  acknowledge("late-provider-job");
  await attempt;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.counts().cancels, 1);
});

void test("late artifact acknowledgment preserves receipt without completing a timed-out attempt", async () => {
  const fixture = setup();
  fixture.complete();
  let acknowledge: (value: string) => void = () => undefined;
  fixture.artifacts.writeResult = () => new Promise<string>((resolve) => { acknowledge = resolve; });
  const runtime = fixture.runtime();
  const created = await runtime.create({ ...input, policy: { ...input.policy, perAttemptDeadlineMs: 10 } }, caller, new Deadline(1_000));
  await assert.rejects(runtime.advance(created.job.jobId, caller), /deadline/u);
  acknowledge("late-artifact");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await runtime.status(created.job.jobId, caller, new Deadline(1_000))).job.status, "running");
  await runtime.advance(created.job.jobId, caller);
  assert.equal((await runtime.status(created.job.jobId, caller, new Deadline(1_000))).job.resultArtifactRef, "late-artifact");
});

void test("cancel deadline also bounds metadata lookup", async () => {
  const fixture = setup();
  const created = await fixture.runtime().create(input, caller, new Deadline(1_000));
  fixture.store.get = () => new Promise(() => undefined);
  const result = await Promise.race([
    fixture.runtime().cancel(created.job.jobId, caller, true, new Deadline(5)).then(() => "resolved", (error: unknown) =>
      error instanceof GroundlaneError ? error.code : "unexpected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("unbounded"), 30)),
  ]);
  assert.equal(result, "DEADLINE_EXCEEDED");
});
