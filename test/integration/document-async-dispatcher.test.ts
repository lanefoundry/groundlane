import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { DocumentAsyncDispatcher, type DocumentDispatchRuntime } from "../../src/core/document-async-dispatcher.js";
import { InMemoryDurableRecordStore, type DurableRecordStorePort } from "../../src/core/durable-store.js";

const caller = { ownerId: "owner", credentialBinding: "private-binding" };
const options = { attemptTimeoutMs: 100, leaseMs: 200, pollIntervalMs: 10, maxBackoffMs: 100 };
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(store: DurableRecordStorePort = new InMemoryDurableRecordStore()) {
  let now = 1_000;
  let calls = 0;
  const state = { job: { status: "running", expiresAt: 2_000 }, resultCleanupPending: false, upstreamRequested: false, upstreamAcknowledged: false };
  const runtime: DocumentDispatchRuntime = {
    advance: (_id, identity) => { assert.deepEqual(identity, caller); calls += 1; return Promise.resolve(); },
    status: () => Promise.resolve(state),
  };
  return { store, runtime, state, now: (value: number) => { now = value; }, calls: () => calls,
    dispatcher: () => new DocumentAsyncDispatcher(store, runtime, options, () => now) };
}

void test("schedule survives SQLite restart and runs without client polling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-dispatch-"));
  try {
    const path = join(directory, "state.sqlite");
    const first = new SqliteDurableRecordStore(path, "document-dispatch-v1");
    await fixture(first).dispatcher().enqueue("job", caller);
    first.close();
    const second = new SqliteDurableRecordStore(path, "document-dispatch-v1");
    try {
      const f = fixture(second); f.now(1_001);
      const result = await f.dispatcher().drain();
      assert.equal(result.advanced, 1); assert.equal(f.calls(), 1);
      assert.equal(JSON.stringify(result).includes(caller.credentialBinding), false);
    } finally { second.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test("concurrent drains claim one lease and duplicate enqueue cannot steal it", async () => {
  const f = fixture();
  const entered = deferred(); const release = deferred(); let calls = 0;
  f.runtime.advance = async () => { calls++; entered.resolve(); await release.promise; };
  const first = f.dispatcher(); const second = f.dispatcher();
  await first.enqueue("job", caller); f.now(1_001);
  const running = first.drain(); await entered.promise;
  await second.enqueue("job", caller);
  assert.equal((await second.drain()).claimed, 0);
  release.resolve(); await running; assert.equal(calls, 1);
});

void test("failed attempt backoff is durable and does not retry in same drain", async () => {
  const f = fixture(); let calls = 0;
  f.runtime.advance = () => { calls++; return Promise.reject(new Error("private upstream body")); };
  await f.dispatcher().enqueue("job", caller); f.now(1_001);
  const first = await f.dispatcher().drain();
  assert.equal(first.failed, 1); assert.equal(first.rescheduled, 1);
  assert.equal(JSON.stringify(first).includes("upstream"), false);
  f.now(1_010); assert.equal((await f.dispatcher().drain()).claimed, 0);
  f.now(1_011); assert.equal((await f.dispatcher().drain()).failed, 1);
  f.now(1_030); assert.equal((await f.dispatcher().drain()).claimed, 0);
  f.now(1_031); await f.dispatcher().drain(); assert.equal(calls, 3);
});

void test("terminal compensation and unacknowledged upstream cancellation remain scheduled", async () => {
  const f = fixture(); f.state.job.status = "cancelled"; f.state.resultCleanupPending = true;
  await f.dispatcher().enqueue("job", caller); f.now(1_001);
  assert.equal((await f.dispatcher().drain()).rescheduled, 1);
  f.state.resultCleanupPending = false; f.state.upstreamRequested = true; f.now(1_011);
  assert.equal((await f.dispatcher().drain()).rescheduled, 1);
  f.state.upstreamAcknowledged = true; f.now(1_021);
  assert.equal((await f.dispatcher().drain()).idle, 1);
  f.now(3_000); assert.equal((await f.dispatcher().drain()).claimed, 0);
});

void test("successful completion schedules retention expiry rather than deleting durable record", async () => {
  const f = fixture(); f.state.job.status = "completed";
  await f.dispatcher().enqueue("job", caller); f.now(1_001);
  assert.equal((await f.dispatcher().drain()).rescheduled, 1);
  f.now(1_999); assert.equal((await f.dispatcher().drain()).claimed, 0);
  f.now(2_000); f.state.job.status = "expired";
  assert.equal((await f.dispatcher().drain()).idle, 1);
  await f.dispatcher().enqueue("job", caller); f.now(2_001);
  assert.equal((await f.dispatcher().drain()).claimed, 1);
});

void test("stale lease owner cannot overwrite newer worker schedule", async () => {
  const f = fixture(); const entered = deferred(); const release = deferred(); let calls = 0;
  f.runtime.advance = async () => { calls++; if (calls === 1) { entered.resolve(); await release.promise; } };
  await f.dispatcher().enqueue("job", caller); f.now(1_001);
  const stale = f.dispatcher().drain(); await entered.promise;
  f.now(1_202); const fresh = await f.dispatcher().drain();
  assert.equal(fresh.advanced, 1); release.resolve();
  assert.equal((await stale).leaseLost, 1);
  f.now(1_211); assert.equal((await f.dispatcher().drain()).claimed, 0);
  f.now(1_212); assert.equal((await f.dispatcher().drain()).claimed, 1);
});

void test("bounded page cursor skips malformed entry and advances all jobs fairly", async () => {
  const f = fixture();
  await f.store.createIfAbsent({ key: "dispatch:000", value: "malformed", nowMs: 1_000, expiresAt: 1_001 });
  await f.dispatcher().enqueue("one", caller); await f.dispatcher().enqueue("two", caller);
  f.now(1_001);
  const first = await f.dispatcher().drain({ limit: 1 }); assert.equal(first.malformed, 1);
  assert.notEqual(first.nextCursor, null);
  await f.dispatcher().drain({ limit: 1 }); await f.dispatcher().drain({ limit: 1 });
  assert.equal(f.calls(), 2);
});

void test("enqueue validates identity and does not delay already scheduled job", async () => {
  const f = fixture(); await f.dispatcher().enqueue("job", caller);
  await assert.rejects(f.dispatcher().enqueue("job", { ...caller, ownerId: "other" }), /mismatch/u);
  await assert.rejects(f.dispatcher().enqueue("job", { ...caller, credentialBinding: "other" }), /mismatch/u);
  await f.dispatcher().enqueue("job", caller, { nextAttemptAt: 9_000 });
  f.now(1_001); assert.equal((await f.dispatcher().drain()).claimed, 1);
  await assert.rejects(f.dispatcher().enqueue("bad", caller, { nextAttemptAt: 1_000 }));
  assert.throws(() => new DocumentAsyncDispatcher(f.store, f.runtime, { attemptTimeoutMs: 100, leaseMs: 100 }));
  await assert.rejects(f.dispatcher().drain({ limit: 101 }));
  await assert.rejects(f.dispatcher().drain({ concurrency: 0 }));
});

void test("attempt timeout aborts runtime and retains recoverable schedule", async () => {
  const f = fixture();
  let aborted = false;
  f.runtime.advance = (_job, _caller, signal) => new Promise<void>((_resolve, reject) => {
    signal?.addEventListener("abort", () => { aborted = true; reject(new Error("dispatch aborted")); }, { once: true });
  });
  const dispatcher = new DocumentAsyncDispatcher(f.store, f.runtime, { ...options, attemptTimeoutMs: 5 }, () => 1_001);
  await dispatcher.enqueue("job", caller, { nextAttemptAt: 1_002 });
  const result = await dispatcher.drain({ nowMs: 1_002 });
  assert.equal(aborted, true); assert.equal(result.failed, 1); assert.equal(result.rescheduled, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(dispatcher.drain({ signal: controller.signal }));
});
