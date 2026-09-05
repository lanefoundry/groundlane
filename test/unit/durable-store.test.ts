import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { DurableEffectJournal } from "../../src/core/durable-effects.js";
import { MAX_DURABLE_METADATA_BYTES } from "../../src/core/durable-store.js";

async function databaseFixture(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-durable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "state.sqlite");
}

void test("durable metadata survives closing and reopening the adapter", async (t) => {
  const path = await databaseFixture(t);
  const first = new SqliteDurableRecordStore(path, "jobs");
  const created = await first.createIfAbsent({ key: "job:one", value: '{"schemaVersion":"1"}', nowMs: 100, expiresAt: 1000 });
  assert.equal(created.status, "created");
  first.close();

  const reopened = new SqliteDurableRecordStore(path, "jobs");
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.get("job:one"), created.record);
});

void test("concurrent create-if-absent has one winner and one replay", async (t) => {
  const path = await databaseFixture(t);
  const left = new SqliteDurableRecordStore(path, "jobs");
  const right = new SqliteDurableRecordStore(path, "jobs");
  t.after(() => { left.close(); right.close(); });
  const results = await Promise.all([
    left.createIfAbsent({ key: "job:idempotent", value: "left", nowMs: 100 }),
    right.createIfAbsent({ key: "job:idempotent", value: "right", nowMs: 100 }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["created", "exists"]);
  assert.equal((await left.get("job:idempotent"))?.revision, 1);
});

void test("compare-and-swap fences stale writers and terminal deletion", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "jobs");
  t.after(() => store.close());
  await store.createIfAbsent({ key: "job:fenced", value: "created", nowMs: 100 });
  const updated = await store.compareAndSwap("job:fenced", 1, { value: "completed", nowMs: 200 });
  assert.equal(updated.status, "updated");
  const stale = await store.compareAndSwap("job:fenced", 1, { value: "stale", nowMs: 300 });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.status === "conflict" ? stale.record.value : "", "completed");
  assert.equal(await store.deleteIfRevision("job:fenced", 1), "conflict");
  assert.equal(await store.deleteIfRevision("job:fenced", 2), "deleted");
});

void test("expiry scans are bounded and cursor-stable", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "jobs");
  t.after(() => store.close());
  for (const key of ["job:a", "job:b", "job:c"]) {
    await store.createIfAbsent({ key, value: key, nowMs: 10, expiresAt: 20 });
  }
  const first = await store.scanExpired(30, null, 2);
  assert.deepEqual(first.records.map((record) => record.key), ["job:a", "job:b"]);
  assert.equal(first.nextCursor, "job:b");
  const second = await store.scanExpired(30, first.nextCursor, 2);
  assert.deepEqual(second.records.map((record) => record.key), ["job:c"]);
  assert.equal(second.nextCursor, null);
});

void test("durable metadata rejects large inline payloads", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "jobs");
  t.after(() => store.close());
  await assert.rejects(
    store.createIfAbsent({ key: "job:large", value: "x".repeat(MAX_DURABLE_METADATA_BYTES + 1), nowMs: 10 }),
    /ArtifactRef/u,
  );
});

void test("side-effect journal claims once and preserves terminal receipt after reopen", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "effects");
  const journal = new DurableEffectJournal(store);
  const identity = { jobId: "job-1", effectKind: "provider_task_create" as const, operationKey: "create-1" };
  const claim = await journal.claim(identity.jobId, identity.effectKind, identity.operationKey, 100);
  assert.equal(claim.status, "claimed");
  const replay = await journal.claim(identity.jobId, identity.effectKind, identity.operationKey, 101);
  assert.equal(replay.status, "existing");
  const inflight = await journal.transition(identity, claim.revision, "inflight", 110);
  const succeeded = await journal.transition(identity, inflight.revision, "succeeded", 120, "provider-receipt-digest");
  assert.equal(succeeded.effect.receipt, "provider-receipt-digest");
  store.close();

  const reopened = new SqliteDurableRecordStore(path, "effects");
  t.after(() => reopened.close());
  const afterRestart = await new DurableEffectJournal(reopened).claim(identity.jobId, identity.effectKind, identity.operationKey, 130);
  assert.equal(afterRestart.status, "existing");
  assert.equal(afterRestart.effect.status, "succeeded");
  assert.equal(afterRestart.effect.receipt, "provider-receipt-digest");
});

void test("side-effect journal exposes crash uncertainty and rejects stale completion", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "effects");
  t.after(() => store.close());
  const journal = new DurableEffectJournal(store);
  const identity = { jobId: "job-2", effectKind: "paid_upstream_call" as const, operationKey: "paid-1" };
  const claim = await journal.claim(identity.jobId, identity.effectKind, identity.operationKey, 100);
  const uncertain = await journal.transition(identity, claim.revision, "uncertain", 110);
  assert.equal(uncertain.effect.status, "uncertain");
  await assert.rejects(journal.transition(identity, claim.revision, "succeeded", 120, "late"), /revision conflict/u);
});
