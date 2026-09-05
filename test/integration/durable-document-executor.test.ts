import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { SqliteImmutableBlobStore } from "../../src/adapters/state/sqlite-immutable-blob.js";
import { createHash } from "node:crypto";
import { DurableDocumentExecutor } from "../../src/core/durable-document-executor.js";
import { DurableDocumentJobRepository } from "../../src/core/durable-document-jobs.js";
import { DurableEffectJournal } from "../../src/core/durable-effects.js";
import { InMemoryDurableRecordStore } from "../../src/core/durable-store.js";

const caller = { ownerId: "owner", credentialBinding: "managed:credential" };

for (const lostAcknowledgment of ["provider", "paid", "artifact"] as const) {
  void test(`SQLite crash/reopen fences ${lostAcknowledgment} acknowledgment loss and replays earlier effects`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "groundlane-effect-crash-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "state.sqlite");
    const calls = { provider: 0, paid: 0, artifact: 0 };
    const bytes = new TextEncoder().encode("immutable result persisted before acknowledgment loss");
    const digest = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    const blobKey = `blobs/${digest.slice(7)}`;
    const blobs = new SqliteImmutableBlobStore(path, "results");
    const ports = {
      createProviderTask: () => {
        calls.provider += 1;
        return lostAcknowledgment === "provider" ? Promise.reject(new Error("provider accepted but response lost")) : Promise.resolve("provider-ack");
      },
      performPaidCall: () => {
        calls.paid += 1;
        return lostAcknowledgment === "paid" ? Promise.reject(new Error("charge accepted but response lost")) : Promise.resolve("paid-ack");
      },
      writeResultArtifact: async () => {
        calls.artifact += 1;
        await blobs.putIfAbsent({ blobKey, ownerId: caller.ownerId, digest, bytes });
        throw new Error("immutable write accepted but response lost");
      },
    };
    const first = new SqliteDurableRecordStore(path, "jobs");
    const repository = new DurableDocumentJobRepository(first, new DurableEffectJournal(first));
    const created = await repository.createIfAbsent({ ...caller, idempotencyKey: lostAcknowledgment,
      requestFingerprint: "fixed-request", nowMs: 1_000, expiresAt: 100_000 });
    await assert.rejects(new DurableDocumentExecutor(repository, ports, () => 2_000).execute({
      jobId: created.value.job.jobId, operationKey: "first", nowMs: 2_000,
    }, caller, new AbortController().signal), /outcome is uncertain/u);
    first.close();
    blobs.close();

    const reopened = new SqliteDurableRecordStore(path, "jobs");
    const reopenedBlobs = new SqliteImmutableBlobStore(path, "results");
    t.after(() => { reopened.close(); reopenedBlobs.close(); });
    const recovered = new DurableDocumentJobRepository(reopened, new DurableEffectJournal(reopened));
    for (const attempt of ["restarted", "caller-changed-retry-key"]) {
      await assert.rejects(new DurableDocumentExecutor(recovered, ports, () => 3_000).execute({
        jobId: created.value.job.jobId, operationKey: attempt, nowMs: 3_000,
      }, caller, new AbortController().signal), /outcome is uncertain/u);
    }
    assert.deepEqual(calls, { provider: 1, paid: lostAcknowledgment === "provider" ? 0 : 1,
      artifact: lostAcknowledgment === "artifact" ? 1 : 0 });
    const persisted = await reopenedBlobs.get({ blobKey, ownerId: caller.ownerId, digest, maxBytes: 1_000 });
    if (lostAcknowledgment === "artifact") assert.deepEqual(persisted, bytes);
    else assert.equal(persisted, null);
    assert.equal((await recovered.get(created.value.job.jobId, caller, 3_000)).job.resultArtifactRef, null);
  });
}

void test("PRD 737: executor invokes provider, paid, and artifact ports once across reopen and replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-executor-"));
  const path = join(directory, "state.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = { provider: 0, paid: 0, artifact: 0 };
  const ports = {
    createProviderTask: () => { calls.provider += 1; return Promise.resolve("provider-receipt"); },
    performPaidCall: () => { calls.paid += 1; return Promise.resolve("billing-receipt"); },
    writeResultArtifact: () => { calls.artifact += 1; return Promise.resolve("art_result_opaque"); },
  };

  const firstStore = new SqliteDurableRecordStore(path, "document-executor");
  const firstRepository = new DurableDocumentJobRepository(firstStore, new DurableEffectJournal(firstStore));
  const created = await firstRepository.createIfAbsent({
    ...caller,
    idempotencyKey: "one",
    requestFingerprint: "sha256-request",
    nowMs: 1_000,
    expiresAt: 100_000,
  });
  const first = new DurableDocumentExecutor(firstRepository, ports, () => 2_000);
  assert.equal(await first.execute({
    jobId: created.value.job.jobId,
    operationKey: "attempt-one",
    nowMs: 2_000,
  }, caller, new AbortController().signal), "art_result_opaque");
  firstStore.close();

  const reopenedStore = new SqliteDurableRecordStore(path, "document-executor");
  t.after(() => reopenedStore.close());
  const reopenedRepository = new DurableDocumentJobRepository(reopenedStore, new DurableEffectJournal(reopenedStore));
  const replay = new DurableDocumentExecutor(reopenedRepository, ports, () => 3_000);
  assert.equal(await replay.execute({
    jobId: created.value.job.jobId,
    operationKey: "attempt-one",
    nowMs: 3_000,
  }, caller, new AbortController().signal), "art_result_opaque");
  assert.deepEqual(calls, { provider: 1, paid: 1, artifact: 1 });
});

void test("PRD 737: uncertain side effects are never automatically repeated", async () => {
  const store = new InMemoryDurableRecordStore();
  const repository = new DurableDocumentJobRepository(store, new DurableEffectJournal(store));
  const created = await repository.createIfAbsent({
    ...caller,
    idempotencyKey: "uncertain",
    requestFingerprint: "sha256-uncertain",
    nowMs: 1_000,
    expiresAt: 100_000,
  });
  let providerCalls = 0;
  const executor = new DurableDocumentExecutor(repository, {
    createProviderTask: () => {
      providerCalls += 1;
      return Promise.reject(new Error("ambiguous provider failure"));
    },
    performPaidCall: () => Promise.resolve("not-called"),
    writeResultArtifact: () => Promise.resolve("not-called"),
  }, () => 2_000);
  const input = { jobId: created.value.job.jobId, operationKey: "attempt", nowMs: 2_000 };
  await assert.rejects(executor.execute(input, caller, new AbortController().signal), /outcome is uncertain/u);
  await assert.rejects(executor.execute(input, caller, new AbortController().signal), /outcome is uncertain/u);
  assert.equal(providerCalls, 1);
});

void test("changing the retry key cannot repeat an uncertain provider effect", async () => {
  const store = new InMemoryDurableRecordStore();
  const repository = new DurableDocumentJobRepository(store, new DurableEffectJournal(store));
  const created = await repository.createIfAbsent({
    ...caller, idempotencyKey: "retry-key", requestFingerprint: "same-request",
    nowMs: 1_000, expiresAt: Number.MAX_SAFE_INTEGER,
  });
  let calls = 0;
  const executor = new DurableDocumentExecutor(repository, {
    createProviderTask: () => { calls += 1; return Promise.reject(new Error("unknown outcome")); },
    performPaidCall: () => Promise.resolve("paid"),
    writeResultArtifact: () => Promise.resolve("artifact"),
  });
  for (const operationKey of ["attempt-one", "attempt-two"]) {
    await assert.rejects(executor.execute({
      jobId: created.value.job.jobId, operationKey, nowMs: 2_000,
    }, caller, new AbortController().signal));
  }
  assert.equal(calls, 1);
});

void test("an already aborted dispatch invokes no provider and leaves the job resumable", async () => {
  const store = new InMemoryDurableRecordStore();
  const repository = new DurableDocumentJobRepository(store, new DurableEffectJournal(store));
  const created = await repository.createIfAbsent({
    ...caller, idempotencyKey: "abort", requestFingerprint: "abort-request",
    nowMs: 1_000, expiresAt: Number.MAX_SAFE_INTEGER,
  });
  let calls = 0;
  const executor = new DurableDocumentExecutor(repository, {
    createProviderTask: () => { calls += 1; return Promise.resolve("provider"); },
    performPaidCall: () => Promise.resolve("paid"),
    writeResultArtifact: () => Promise.resolve("artifact"),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executor.execute({
    jobId: created.value.job.jobId, operationKey: "attempt", nowMs: 2_000,
  }, caller, controller.signal));
  assert.equal(calls, 0);
  assert.equal((await repository.get(created.value.job.jobId, caller, 2_000)).job.status, "created");
});

void test("provider completion after job expiry cannot dispatch billing or artifact writes", async () => {
  let nowMs = 2_000;
  const store = new InMemoryDurableRecordStore();
  const repository = new DurableDocumentJobRepository(store, new DurableEffectJournal(store));
  const created = await repository.createIfAbsent({
    ...caller, idempotencyKey: "expiry", requestFingerprint: "expiry-request",
    nowMs: 1_000, expiresAt: 3_000,
  });
  const calls = { provider: 0, paid: 0, artifact: 0 };
  const executor = new DurableDocumentExecutor(repository, {
    createProviderTask: () => { calls.provider += 1; nowMs = 3_000; return Promise.resolve("provider"); },
    performPaidCall: () => { calls.paid += 1; return Promise.resolve("paid"); },
    writeResultArtifact: () => { calls.artifact += 1; return Promise.resolve("artifact"); },
  }, () => nowMs);
  await assert.rejects(executor.execute({
    jobId: created.value.job.jobId, operationKey: "attempt", nowMs: 2_000,
  }, caller, new AbortController().signal));
  assert.deepEqual(calls, { provider: 1, paid: 0, artifact: 0 });
  assert.equal((await repository.get(created.value.job.jobId, caller, nowMs)).job.status, "expired");
});

for (const uncertainPhase of ["paid", "artifact"] as const) {
  void test(`changed retry keys replay earlier receipts and cannot repeat uncertain ${uncertainPhase}`, async () => {
    const store = new InMemoryDurableRecordStore();
    const repository = new DurableDocumentJobRepository(store, new DurableEffectJournal(store));
    const created = await repository.createIfAbsent({
      ...caller, idempotencyKey: uncertainPhase, requestFingerprint: "phase-request",
      nowMs: 1_000, expiresAt: 100_000,
    });
    const calls = { provider: 0, paid: 0, artifact: 0 };
    const executor = new DurableDocumentExecutor(repository, {
      createProviderTask: () => { calls.provider += 1; return Promise.resolve("provider"); },
      performPaidCall: () => {
        calls.paid += 1;
        return uncertainPhase === "paid"
          ? Promise.reject(new Error("unknown billing outcome")) : Promise.resolve("paid");
      },
      writeResultArtifact: () => { calls.artifact += 1; return Promise.reject(new Error("unknown write outcome")); },
    }, () => 2_000);
    for (const operationKey of ["first", "second"]) {
      await assert.rejects(executor.execute({
        jobId: created.value.job.jobId, operationKey, nowMs: 2_000,
      }, caller, new AbortController().signal), /outcome is uncertain/u);
    }
    assert.deepEqual(calls, { provider: 1, paid: 1, artifact: uncertainPhase === "artifact" ? 1 : 0 });
  });
}

void test("abort between phases preserves successful receipts for a new dispatch", async () => {
  const store = new InMemoryDurableRecordStore();
  const repository = new DurableDocumentJobRepository(store, new DurableEffectJournal(store));
  const created = await repository.createIfAbsent({
    ...caller, idempotencyKey: "resume", requestFingerprint: "resume-request",
    nowMs: 1_000, expiresAt: 100_000,
  });
  const controller = new AbortController();
  const calls = { provider: 0, paid: 0, artifact: 0 };
  const executor = new DurableDocumentExecutor(repository, {
    createProviderTask: () => {
      calls.provider += 1;
      controller.abort();
      return Promise.resolve("provider");
    },
    performPaidCall: () => { calls.paid += 1; return Promise.resolve("paid"); },
    writeResultArtifact: () => { calls.artifact += 1; return Promise.resolve("artifact"); },
  }, () => 2_000);
  await assert.rejects(executor.execute({
    jobId: created.value.job.jobId, operationKey: "first", nowMs: 2_000,
  }, caller, controller.signal), /dispatch was cancelled/u);
  assert.deepEqual(calls, { provider: 1, paid: 0, artifact: 0 });
  assert.equal((await repository.get(created.value.job.jobId, caller, 2_000)).job.status, "running");
  assert.equal(await executor.execute({
    jobId: created.value.job.jobId, operationKey: "resume", nowMs: 2_000,
  }, caller, new AbortController().signal), "artifact");
  assert.deepEqual(calls, { provider: 1, paid: 1, artifact: 1 });
});
