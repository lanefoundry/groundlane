import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { DurableMcpTaskRuntime } from "../../src/core/durable-mcp-tasks.js";
import { InMemoryDurableRecordStore } from "../../src/core/durable-store.js";
import type {
  DurableCasResult,
  DurableCreateResult,
  DurableDeleteResult,
  DurableExpiredPage,
  DurableRecord,
  DurableRecordStorePort,
  DurableRecordUpdate,
  NewDurableRecord,
} from "../../src/core/durable-store.js";
import { type AsyncTaskProviderPort } from "../../src/core/mcp-tasks.js";

interface Input { readonly value: string }

function fakeProvider(): AsyncTaskProviderPort<Input> & {
  status: "working" | "input_required" | "completed";
  created: string[];
  updates: Record<string, unknown>[];
  cancelled: string[];
} {
  const provider = {
    id: "fake",
    status: "working" as "working" | "input_required" | "completed",
    created: [] as string[],
    updates: [] as Record<string, unknown>[],
    cancelled: [] as string[],
    parseInput(value: unknown): Input {
      if (typeof value !== "object" || value === null || !("value" in value) || typeof value.value !== "string") {
        throw new Error("invalid persisted task input");
      }
      return { value: value.value };
    },
    create: (input: Input) => {
      provider.created.push(input.value);
      return Promise.resolve("provider-secret-id");
    },
    poll: (_providerTaskId: string, input: Input) => {
      if (provider.status === "input_required") {
        return Promise.resolve({
          status: "input_required" as const,
          inputRequests: { confirmation: { method: "elicitation/create" } },
        });
      }
      if (provider.status === "completed") {
        return Promise.resolve({
          status: "completed" as const,
          result: { content: [], structuredContent: { value: input.value } },
        });
      }
      return Promise.resolve({ status: "working" as const });
    },
    update: (_providerTaskId: string, responses: Record<string, unknown>) => {
      provider.updates.push(responses);
      provider.status = "completed";
      return Promise.resolve();
    },
    cancel: (providerTaskId: string) => {
      provider.cancelled.push(providerTaskId);
      return Promise.resolve(null);
    },
  };
  return provider;
}

const caller = { ownerId: "owner", credentialBinding: "credential-1" };

void test("same owner and idempotency key remain isolated by credential binding", async () => {
  const store = new InMemoryDurableRecordStore();
  const firstProvider = fakeProvider();
  const secondProvider = fakeProvider();
  const firstRuntime = new DurableMcpTaskRuntime(store, firstProvider, 5_000);
  const secondRuntime = new DurableMcpTaskRuntime(store, secondProvider, 5_000);
  const firstCaller = { ownerId: "owner", credentialBinding: "credential-1" };
  const secondCaller = { ownerId: "owner", credentialBinding: "credential-2" };
  const options = { idempotencyKey: "shared-key" };

  const [first, second] = await Promise.all([
    firstRuntime.start(
      { value: "first" },
      firstCaller,
      new AbortController().signal,
      options,
    ),
    secondRuntime.start(
      { value: "second" },
      secondCaller,
      new AbortController().signal,
      options,
    ),
  ]);

  assert.notEqual(first.taskId, second.taskId);
  assert.deepEqual(firstProvider.created, ["first"]);
  assert.deepEqual(secondProvider.created, ["second"]);
  assert.doesNotMatch(JSON.stringify([first, second]), /provider-secret-id/u);
  await assert.rejects(
    firstRuntime.get(first.taskId, secondCaller, new AbortController().signal),
    /Unknown or unavailable task/u,
  );
  await assert.rejects(
    secondRuntime.get(second.taskId, firstCaller, new AbortController().signal),
    /Unknown or unavailable task/u,
  );

  assert.equal((await firstRuntime.start(
    { value: "first" },
    firstCaller,
    new AbortController().signal,
    options,
  )).taskId, first.taskId);
  assert.equal((await secondRuntime.start(
    { value: "second" },
    secondCaller,
    new AbortController().signal,
    options,
  )).taskId, second.taskId);
  assert.deepEqual(firstProvider.created, ["first"]);
  assert.deepEqual(secondProvider.created, ["second"]);
});

void test("official task runtime survives SQLite reopen without exposing provider IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-mcp-tasks-"));
  const path = join(directory, "tasks.sqlite");
  const provider = fakeProvider();
  const firstStore = new SqliteDurableRecordStore(path, "mcp-tasks-v1");
  const first = new DurableMcpTaskRuntime(firstStore, provider, 5_000);
  try {
    const created = await first.start(
      { value: "durable" },
      caller,
      new AbortController().signal,
      { idempotencyKey: "stable-create" },
    );
    assert.equal(created.status, "working");
    assert.match(created.taskId, /^ajob-[0-9a-f-]{36}$/u);
    assert.doesNotMatch(JSON.stringify(created), /provider-secret-id/u);
    firstStore.close();

    const reopenedStore = new SqliteDurableRecordStore(path, "mcp-tasks-v1");
    const reopened = new DurableMcpTaskRuntime(reopenedStore, provider, 5_000);
    try {
      provider.status = "completed";
      const completed = await reopened.get(
        created.taskId,
        caller,
        new AbortController().signal,
      );
      assert.equal(completed.status, "completed");
      assert.deepEqual(completed.result.structuredContent, { value: "durable" });
      await assert.rejects(
        reopened.get(
          created.taskId,
          { ...caller, credentialBinding: "other" },
          new AbortController().signal,
        ),
        /Unknown or unavailable task/u,
      );
    } finally {
      reopenedStore.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("tasks/update resumes input-required work and cancel preserves missing upstream acknowledgment", async () => {
  const provider = fakeProvider();
  const runtime = new DurableMcpTaskRuntime(new InMemoryDurableRecordStore(), provider, 5_000);
  const created = await runtime.start(
    { value: "round-trip" },
    caller,
    new AbortController().signal,
  );

  provider.status = "input_required";
  const waiting = await runtime.get(created.taskId, caller, new AbortController().signal);
  assert.equal(waiting.status, "input_required");
  assert.ok("inputRequests" in waiting);
  await runtime.update(
    created.taskId,
    { confirmation: { action: "accept", content: { approved: true } } },
    caller,
    new AbortController().signal,
  );
  assert.equal(provider.updates.length, 1);

  const completed = await runtime.get(created.taskId, caller, new AbortController().signal);
  assert.equal(completed.status, "completed");
  const completedDetails = await runtime.describe(
    created.taskId,
    caller,
    new AbortController().signal,
  );
  assert.deepEqual(completedDetails.billingProvenance, {
    providerId: "fake",
    reported: false,
  });

  const cancelProvider = fakeProvider();
  const cancelRuntime = new DurableMcpTaskRuntime(
    new InMemoryDurableRecordStore(),
    cancelProvider,
    5_000,
  );
  const cancellable = await cancelRuntime.start(
    { value: "cancel" },
    caller,
    new AbortController().signal,
  );
  await cancelRuntime.cancel(cancellable.taskId, caller, new AbortController().signal);
  const cancelled = await cancelRuntime.get(
    cancellable.taskId,
    caller,
    new AbortController().signal,
  );
  assert.equal(cancelled.status, "cancelled");
  const cancelledDetails = await cancelRuntime.describe(
    cancellable.taskId,
    caller,
    new AbortController().signal,
  );
  assert.deepEqual(cancelledDetails.cancellation, {
    callerStoppedWaiting: false,
    groundlanePollingCancelled: true,
    upstreamCancelRequested: true,
    upstreamCancelled: false,
  });
  assert.deepEqual(cancelProvider.cancelled, ["provider-secret-id"]);
});

void test("caller stop-waiting is independent and does not terminalize durable work", async () => {
  const runtime = new DurableMcpTaskRuntime(
    new InMemoryDurableRecordStore(),
    fakeProvider(),
    5_000,
  );
  const created = await runtime.start(
    { value: "continue" }, caller, new AbortController().signal,
  );
  await runtime.stopWaiting(created.taskId, caller);
  const details = await runtime.describe(
    created.taskId,
    caller,
    new AbortController().signal,
  );
  assert.equal(details.task.status, "working");
  assert.deepEqual(details.cancellation, {
    callerStoppedWaiting: true,
    groundlanePollingCancelled: false,
    upstreamCancelRequested: false,
    upstreamCancelled: false,
  });
});

void test("reported provider billing remains distinct from unknown usage", async () => {
  const provider: AsyncTaskProviderPort<Input> = {
    id: "metered",
    parseInput: (value) => value as Input,
    create: () => Promise.resolve("private-metered-handle"),
    poll: () => Promise.resolve({
      status: "completed",
      result: { content: [] },
      billing: { inputUnits: 7, outputUnits: 11 },
    }),
  };
  const runtime = new DurableMcpTaskRuntime(
    new InMemoryDurableRecordStore(),
    provider,
    5_000,
  );
  const created = await runtime.start(
    { value: "metered" }, caller, new AbortController().signal,
  );
  const details = await runtime.describe(
    created.taskId,
    caller,
    new AbortController().signal,
  );
  assert.deepEqual(details.billingProvenance, {
    providerId: "metered",
    reported: true,
    inputUnits: 7,
    outputUnits: 11,
  });
});

void test("concurrent reconnect polls are CAS-fenced and terminal cancellation wins", async () => {
  let pollCalls = 0;
  let releasePoll: (() => void) | undefined;
  const provider: AsyncTaskProviderPort<Input> = {
    id: "concurrent",
    parseInput: (value) => value as Input,
    create: () => Promise.resolve("private-handle"),
    poll: () => new Promise((resolve) => {
      pollCalls += 1;
      releasePoll = () => resolve({ status: "completed", result: { content: [] } });
    }),
  };
  const runtime = new DurableMcpTaskRuntime(new InMemoryDurableRecordStore(), provider, 5_000);
  const createdAt = new Date("2026-09-05T00:00:00.000Z");
  const created = await runtime.start(
    { value: "race" },
    caller,
    new AbortController().signal,
    { now: createdAt },
  );
  const pollAt = new Date(createdAt.getTime() + 5_000);
  const left = runtime.get(created.taskId, caller, new AbortController().signal, pollAt);
  const right = runtime.get(created.taskId, caller, new AbortController().signal, pollAt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pollCalls, 1);
  await runtime.cancel(created.taskId, caller, new AbortController().signal, pollAt);
  releasePoll?.();
  assert.equal((await left).status, "cancelled");
  assert.equal((await right).status, "working");
  assert.equal((await runtime.get(
    created.taskId,
    caller,
    new AbortController().signal,
    pollAt,
  )).status, "cancelled");
});

class FailFirstTaskCasStore implements DurableRecordStorePort {
  private failed = false;

  constructor(private readonly inner: DurableRecordStorePort) {}

  get(key: string): Promise<DurableRecord | null> {
    return this.inner.get(key);
  }

  createIfAbsent(record: NewDurableRecord): Promise<DurableCreateResult> {
    return this.inner.createIfAbsent(record);
  }

  compareAndSwap(
    key: string,
    revision: number,
    update: DurableRecordUpdate,
  ): Promise<DurableCasResult> {
    if (!this.failed && key.startsWith("mcp-task:")) {
      this.failed = true;
      throw new Error("simulated crash before provider handle persistence");
    }
    return this.inner.compareAndSwap(key, revision, update);
  }

  deleteIfRevision(key: string, revision: number): Promise<DurableDeleteResult> {
    return this.inner.deleteIfRevision(key, revision);
  }

  scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage> {
    return this.inner.scanExpired(nowMs, cursor, limit);
  }
}

class SelectiveCasFailureStore implements DurableRecordStorePort {
  failNextTaskWrite = false;
  failNextUpdateEffectSuccess = false;

  constructor(private readonly inner: DurableRecordStorePort) {}

  get(key: string): Promise<DurableRecord | null> {
    return this.inner.get(key);
  }

  createIfAbsent(record: NewDurableRecord): Promise<DurableCreateResult> {
    return this.inner.createIfAbsent(record);
  }

  compareAndSwap(
    key: string,
    revision: number,
    update: DurableRecordUpdate,
  ): Promise<DurableCasResult> {
    if (this.failNextTaskWrite && key.startsWith("mcp-task:")) {
      this.failNextTaskWrite = false;
      throw new Error("simulated crash before task state persistence");
    }
    if (this.failNextUpdateEffectSuccess && key.startsWith("effect:") &&
      update.value.includes('"effectKind":"provider_task_update"') &&
      update.value.includes('"status":"succeeded"')) {
      this.failNextUpdateEffectSuccess = false;
      throw new Error("simulated crash before update receipt persistence");
    }
    return this.inner.compareAndSwap(key, revision, update);
  }

  deleteIfRevision(key: string, revision: number): Promise<DurableDeleteResult> {
    return this.inner.deleteIfRevision(key, revision);
  }

  scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage> {
    return this.inner.scanExpired(nowMs, cursor, limit);
  }
}

async function moveToInputRequired(
  runtime: DurableMcpTaskRuntime<Input>,
  provider: ReturnType<typeof fakeProvider>,
  value: string,
): Promise<string> {
  const created = await runtime.start(
    { value },
    caller,
    new AbortController().signal,
  );
  provider.status = "input_required";
  const waiting = await runtime.get(
    created.taskId,
    caller,
    new AbortController().signal,
  );
  assert.equal(waiting.status, "input_required");
  return created.taskId;
}

const acceptedInput = {
  confirmation: { action: "accept", content: { approved: true } },
};

void test("provider update receipt completes local state after task-CAS crash without redispatch", async () => {
  const provider = fakeProvider();
  const store = new SelectiveCasFailureStore(new InMemoryDurableRecordStore());
  const runtime = new DurableMcpTaskRuntime(store, provider, 5_000);
  const taskId = await moveToInputRequired(runtime, provider, "update-receipt");
  store.failNextTaskWrite = true;

  await assert.rejects(
    runtime.update(taskId, acceptedInput, caller, new AbortController().signal),
    /simulated crash/u,
  );
  assert.equal(provider.updates.length, 1);
  await runtime.update(taskId, acceptedInput, caller, new AbortController().signal);
  assert.equal(provider.updates.length, 1);
  assert.equal((await runtime.get(
    taskId,
    caller,
    new AbortController().signal,
  )).status, "completed");
});

void test("ambiguous provider update remains uncertain after SQLite reopen and never repeats", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-mcp-update-"));
  const path = join(directory, "tasks.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = fakeProvider();
  const firstStore = new SqliteDurableRecordStore(path, "mcp-tasks-v1");
  const failingStore = new SelectiveCasFailureStore(firstStore);
  const first = new DurableMcpTaskRuntime(failingStore, provider, 5_000);
  const taskId = await moveToInputRequired(first, provider, "uncertain-update");
  failingStore.failNextUpdateEffectSuccess = true;

  await assert.rejects(
    first.update(taskId, acceptedInput, caller, new AbortController().signal),
    /update outcome is uncertain/u,
  );
  assert.equal(provider.updates.length, 1);
  firstStore.close();

  const reopenedStore = new SqliteDurableRecordStore(path, "mcp-tasks-v1");
  t.after(() => reopenedStore.close());
  const reopened = new DurableMcpTaskRuntime(reopenedStore, provider, 5_000);
  await assert.rejects(
    reopened.update(taskId, acceptedInput, caller, new AbortController().signal),
    /update outcome is uncertain/u,
  );
  assert.equal(provider.updates.length, 1);
});

void test("provider update rejection becomes durable uncertainty and is not retried", async () => {
  const provider = fakeProvider();
  let calls = 0;
  provider.update = () => {
    calls += 1;
    return Promise.reject(new Error("provider detail must be sanitized"));
  };
  const runtime = new DurableMcpTaskRuntime(new InMemoryDurableRecordStore(), provider, 5_000);
  const taskId = await moveToInputRequired(runtime, provider, "failed-update");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      runtime.update(taskId, acceptedInput, caller, new AbortController().signal),
      (error: unknown) => error instanceof Error &&
        /update outcome is uncertain/u.test(error.message) &&
        !/provider detail/u.test(error.message),
    );
  }
  assert.equal(calls, 1);
});

void test("cancel retries transient and unacknowledged attempts after reopen with concurrency fencing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-mcp-cancel-"));
  const path = join(directory, "tasks.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let cancelCalls = 0;
  let acknowledge: (() => void) | undefined;
  const provider: AsyncTaskProviderPort<Input> = {
    id: "cancel-retry",
    parseInput: (value) => value as Input,
    create: () => Promise.resolve("private-cancel-handle"),
    poll: () => Promise.resolve({ status: "working" }),
    cancel: () => {
      cancelCalls += 1;
      if (cancelCalls === 1) return Promise.reject(new Error("transient provider failure"));
      if (cancelCalls === 2) return Promise.resolve(null);
      return new Promise((resolve) => {
        acknowledge = () => resolve({
          providerResponseCode: 202,
          acknowledgedAt: "2026-09-05T00:00:00.000Z",
        });
      });
    },
  };
  const firstStore = new SqliteDurableRecordStore(path, "mcp-tasks-v1");
  const first = new DurableMcpTaskRuntime(firstStore, provider, 5_000);
  const created = await first.start(
    { value: "cancel-retry" },
    caller,
    new AbortController().signal,
  );
  await first.cancel(created.taskId, caller, new AbortController().signal);
  let details = await first.describe(
    created.taskId,
    caller,
    new AbortController().signal,
  );
  assert.equal(details.task.status, "cancelled");
  assert.equal(details.cancellation.upstreamCancelled, false);
  assert.equal(cancelCalls, 1);
  firstStore.close();

  const leftStore = new SqliteDurableRecordStore(path, "mcp-tasks-v1");
  const rightStore = new SqliteDurableRecordStore(path, "mcp-tasks-v1");
  t.after(() => {
    leftStore.close();
    rightStore.close();
  });
  const left = new DurableMcpTaskRuntime(leftStore, provider, 5_000);
  const right = new DurableMcpTaskRuntime(rightStore, provider, 5_000);
  await left.cancel(created.taskId, caller, new AbortController().signal);
  assert.equal(cancelCalls, 2);
  const [leftRetry, rightRetry] = [
    left.cancel(created.taskId, caller, new AbortController().signal),
    right.cancel(created.taskId, caller, new AbortController().signal),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 3);
  acknowledge?.();
  await Promise.all([leftRetry, rightRetry]);
  details = await right.describe(
    created.taskId,
    caller,
    new AbortController().signal,
  );
  assert.equal(details.task.status, "cancelled");
  assert.deepEqual(details.cancellation, {
    callerStoppedWaiting: false,
    groundlanePollingCancelled: true,
    upstreamCancelRequested: true,
    upstreamCancelled: true,
  });
  assert.equal(cancelCalls, 3);
});

void test("uncertain provider creation is terminal and idempotent retry never posts twice", async () => {
  let creates = 0;
  const provider = fakeProvider();
  provider.create = () => {
    creates += 1;
    return Promise.resolve("private-ambiguous-handle");
  };
  const runtime = new DurableMcpTaskRuntime(
    new FailFirstTaskCasStore(new InMemoryDurableRecordStore()),
    provider,
    5_000,
  );
  const options = {
    idempotencyKey: "same-request",
    now: new Date("2026-09-05T00:00:00.000Z"),
  };
  const first = await runtime.start(
    { value: "ambiguous" }, caller, new AbortController().signal, options,
  );
  assert.equal(first.status, "failed");
  assert.match(first.statusMessage ?? "", /outcome is uncertain/u);
  const retry = await runtime.start(
    { value: "ambiguous" }, caller, new AbortController().signal, options,
  );
  assert.equal(retry.status, "failed");
  assert.equal(creates, 1);
});

void test("expired, unknown, and unauthorized task IDs are indistinguishable", async () => {
  const runtime = new DurableMcpTaskRuntime(
    new InMemoryDurableRecordStore(),
    fakeProvider(),
    5_000,
  );
  const now = new Date("2026-09-05T00:00:00.000Z");
  const created = await runtime.start(
    { value: "expires" }, caller, new AbortController().signal, { now, ttlMs: 60_000 },
  );
  for (const attempt of [
    runtime.get("task-unknown", caller, new AbortController().signal, now),
    runtime.get(created.taskId, { ...caller, ownerId: "other" }, new AbortController().signal, now),
    runtime.get(created.taskId, caller, new AbortController().signal, new Date(now.getTime() + 60_000)),
  ]) {
    await assert.rejects(attempt, /Unknown or unavailable task/u);
  }
});
