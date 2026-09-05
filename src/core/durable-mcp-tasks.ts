import { createHash, randomUUID } from "node:crypto";

import { sanitizeUpstreamError, type AsyncJobCaller, type BillingUnits } from "./async-lifecycle.js";
import { DurableEffectJournal } from "./durable-effects.js";
import type { DurableRecord, DurableRecordStorePort } from "./durable-store.js";
import { GroundlaneError } from "./errors.js";
import {
  DEFAULT_MCP_TASK_POLL_INTERVAL_MS,
  DEFAULT_MCP_TASK_TTL_MS,
  type AsyncTaskPollOutcome,
  type AsyncTaskProviderPort,
  type DetailedMcpTask,
  type McpTaskOperationalDetails,
  type StartMcpTaskOptions,
} from "./mcp-tasks.js";

const SCHEMA_VERSION = "1" as const;
const TASK_KEY_PREFIX = "mcp-task:";
const MAX_ENCODED_STATE_BYTES = 48 * 1024;
const MAX_IDENTITY_CHARS = 256;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type DurableTaskStatus = "creating" | "working" | "input_required" | "completed" | "failed" | "cancelled";

interface DurableTaskState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly taskId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly providerId: string;
  readonly providerTaskId: string | null;
  readonly operationInput: unknown;
  readonly idempotencyKey: string | null;
  readonly status: DurableTaskStatus;
  readonly result: Record<string, unknown> | null;
  readonly inputRequests: Record<string, unknown>;
  readonly usedInputKeys: readonly string[];
  readonly sanitizedError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly ttlMs: number;
  readonly pollIntervalMs: number;
  readonly nextPollAt: number;
  readonly billing: BillingUnits | null;
  readonly callerCancelled: boolean;
  readonly groundlanePollingCancelled: boolean;
  readonly upstreamCancelRequested: boolean;
  readonly upstreamCancelled: boolean;
}

interface VersionedTask {
  readonly state: DurableTaskState;
  readonly revision: number;
}

function taskError(
  message: string,
  code: "INVALID_INPUT" | "DEADLINE_EXCEEDED" | "UPSTREAM_ERROR" = "INVALID_INPUT",
): GroundlaneError {
  return new GroundlaneError(code, "mcp-tasks", message);
}

function uncertainUpdateError(): GroundlaneError {
  return taskError("Provider task update outcome is uncertain", "UPSTREAM_ERROR");
}

function assertIdentity(value: string, field: string): void {
  if (value.length === 0 || value.length > MAX_IDENTITY_CHARS) {
    throw taskError(`${field} must be non-empty within ${String(MAX_IDENTITY_CHARS)} characters`);
  }
}

function newTaskId(): string {
  return `ajob-${randomUUID()}`;
}

function idempotencyRecordKey(
  ownerId: string,
  credentialBinding: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(ownerId)
    .update("\0")
    .update(credentialBinding)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
  return `mcp-task-idempotency:${digest}`;
}

function inputFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function taskKey(taskId: string): string {
  return `${TASK_KEY_PREFIX}${taskId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is DurableTaskStatus {
  return typeof value === "string" && [
    "creating",
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
  ].includes(value);
}

function encode(state: DurableTaskState): string {
  const value = JSON.stringify(state);
  if (new TextEncoder().encode(value).byteLength > MAX_ENCODED_STATE_BYTES) {
    throw taskError("Durable task metadata exceeds 48 KiB; store large output as an ArtifactRef");
  }
  return value;
}

function decode(record: DurableRecord): VersionedTask {
  let value: unknown;
  try {
    value = JSON.parse(record.value) as unknown;
  } catch {
    throw taskError("Durable task record is malformed");
  }
  if (!isObject(value)) throw taskError("Durable task record is malformed");
  const item = value as Partial<DurableTaskState>;
  if (
    item.schemaVersion !== SCHEMA_VERSION || typeof item.taskId !== "string" ||
    typeof item.ownerId !== "string" || typeof item.credentialBinding !== "string" ||
    typeof item.providerId !== "string" ||
    !(item.providerTaskId === null || typeof item.providerTaskId === "string") ||
    !(item.idempotencyKey === null || typeof item.idempotencyKey === "string") ||
    !isStatus(item.status) || !(item.result === null || isObject(item.result)) ||
    !isObject(item.inputRequests) || !Array.isArray(item.usedInputKeys) ||
    !item.usedInputKeys.every((key) => typeof key === "string") ||
    !(item.sanitizedError === null || typeof item.sanitizedError === "string") ||
    typeof item.createdAt !== "number" || typeof item.updatedAt !== "number" ||
    typeof item.expiresAt !== "number" || typeof item.ttlMs !== "number" ||
    typeof item.pollIntervalMs !== "number" || typeof item.nextPollAt !== "number" ||
    !(item.billing === null || (isObject(item.billing) &&
      Number.isInteger(item.billing.inputUnits) && Number.isInteger(item.billing.outputUnits))) ||
    typeof item.callerCancelled !== "boolean" ||
    typeof item.groundlanePollingCancelled !== "boolean" ||
    typeof item.upstreamCancelRequested !== "boolean" ||
    typeof item.upstreamCancelled !== "boolean" || !("operationInput" in item)
  ) throw taskError("Durable task record is malformed");
  assertIdentity(item.taskId, "taskId");
  assertIdentity(item.ownerId, "ownerId");
  assertIdentity(item.credentialBinding, "credentialBinding");
  return { state: item as DurableTaskState, revision: record.revision };
}

function assertCaller(state: DurableTaskState, caller: AsyncJobCaller): void {
  // Deliberately use one indistinguishable response for unknown and unauthorized IDs.
  if (state.ownerId !== caller.ownerId || state.credentialBinding !== caller.credentialBinding) {
    throw taskError("Unknown or unavailable task");
  }
}

function validateTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw taskError("Task timestamp is invalid");
}

function toDetailed(state: DurableTaskState): DetailedMcpTask {
  const base = {
    taskId: state.taskId,
    createdAt: new Date(state.createdAt).toISOString(),
    lastUpdatedAt: new Date(state.updatedAt).toISOString(),
    ttlMs: state.ttlMs,
    pollIntervalMs: state.pollIntervalMs,
  };
  if (state.status === "completed") {
    return { ...base, status: "completed", result: state.result ?? {} };
  }
  if (state.status === "failed") {
    const message = state.sanitizedError ?? "Task execution failed";
    return { ...base, status: "failed", statusMessage: message, error: { code: -32603, message } };
  }
  if (state.status === "cancelled") return { ...base, status: "cancelled" };
  if (state.status === "input_required") {
    return { ...base, status: "input_required", inputRequests: state.inputRequests };
  }
  return { ...base, status: "working" };
}

/** CAS-backed MCP task runtime shared by SQLite and D1 durable stores. */
export class DurableMcpTaskRuntime<Input> {
  private readonly effects: DurableEffectJournal;

  constructor(
    private readonly store: DurableRecordStorePort,
    private readonly provider: AsyncTaskProviderPort<Input>,
    private readonly pollIntervalMs = DEFAULT_MCP_TASK_POLL_INTERVAL_MS,
  ) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 5_000 || pollIntervalMs > 60_000) {
      throw taskError("pollIntervalMs must be 5000..60000");
    }
    this.effects = new DurableEffectJournal(store);
  }

  async start(
    input: Input,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    options: StartMcpTaskOptions = {},
  ): Promise<DetailedMcpTask> {
    assertIdentity(caller.ownerId, "ownerId");
    assertIdentity(caller.credentialBinding, "credentialBinding");
    const ttlMs = options.ttlMs ?? DEFAULT_MCP_TASK_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000) {
      throw taskError("ttlMs must be 60000..86400000");
    }
    if (options.idempotencyKey !== undefined) assertIdentity(options.idempotencyKey, "idempotencyKey");
    const nowMs = (options.now ?? new Date()).getTime();
    validateTime(nowMs);
    let taskId = newTaskId();
    if (options.idempotencyKey !== undefined) {
      const fingerprint = inputFingerprint(input);
      const index = await this.store.createIfAbsent({
        key: idempotencyRecordKey(
          caller.ownerId,
          caller.credentialBinding,
          options.idempotencyKey,
        ),
        value: JSON.stringify({ taskId, fingerprint }),
        nowMs,
        expiresAt: nowMs + ttlMs,
      });
      const indexed: unknown = JSON.parse(index.record.value);
      if (!isObject(indexed) || typeof indexed.taskId !== "string" ||
        typeof indexed.fingerprint !== "string") {
        throw taskError("Durable task idempotency record is malformed");
      }
      if (indexed.fingerprint !== fingerprint) {
        throw taskError("Idempotency key is already bound to a different task request");
      }
      taskId = indexed.taskId;
    }
    const initial: DurableTaskState = {
      schemaVersion: SCHEMA_VERSION,
      taskId,
      ownerId: caller.ownerId,
      credentialBinding: caller.credentialBinding,
      providerId: this.provider.id,
      providerTaskId: null,
      operationInput: input,
      idempotencyKey: options.idempotencyKey ?? null,
      status: "creating",
      result: null,
      inputRequests: {},
      usedInputKeys: [],
      sanitizedError: null,
      createdAt: nowMs,
      updatedAt: nowMs,
      expiresAt: nowMs + ttlMs,
      ttlMs,
      pollIntervalMs: this.pollIntervalMs,
      nextPollAt: nowMs,
      billing: null,
      callerCancelled: false,
      groundlanePollingCancelled: false,
      upstreamCancelRequested: false,
      upstreamCancelled: false,
    };
    const created = await this.store.createIfAbsent({
      key: taskKey(taskId),
      value: encode(initial),
      nowMs,
      expiresAt: initial.expiresAt,
    });
    let current = decode(created.record);
    assertCaller(current.state, caller);
    if (current.state.idempotencyKey !== initial.idempotencyKey ||
      JSON.stringify(current.state.operationInput) !== JSON.stringify(input)) {
      throw taskError("Idempotency key is already bound to a different task request");
    }
    if (created.status === "exists") {
      return current.state.status === "creating"
        ? this.failUncertain(current, caller, nowMs)
        : toDetailed(current.state);
    }

    const claim = await this.effects.claim(taskId, "provider_task_create", "initial", nowMs);
    if (claim.status !== "claimed") {
      return this.failUncertain(current, caller, nowMs);
    }
    const inflight = await this.effects.transition(
      { jobId: taskId, effectKind: "provider_task_create", operationKey: "initial" },
      claim.revision,
      "inflight",
      nowMs,
    );
    try {
      const providerTaskId = await this.provider.create(input, signal);
      const next: DurableTaskState = {
        ...current.state,
      providerTaskId,
      status: "working",
      updatedAt: nowMs,
      nextPollAt: nowMs,
      };
      const saved = await this.store.compareAndSwap(taskKey(taskId), current.revision, {
        value: encode(next),
        nowMs,
        expiresAt: next.expiresAt,
      });
      if (saved.status !== "updated") throw taskError("Provider task creation outcome is uncertain");
      current = decode(saved.record);
      await this.effects.transition(
        { jobId: taskId, effectKind: "provider_task_create", operationKey: "initial" },
        inflight.revision,
        "succeeded",
        nowMs,
        "provider-handle-persisted",
      );
      return toDetailed(current.state);
    } catch (error) {
      await this.markEffectUncertain(taskId, inflight.revision, nowMs);
      return this.failUncertain(current, caller, nowMs, error);
    }
  }

  async get(
    taskId: string,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<DetailedMcpTask> {
    const current = await this.read(taskId, caller, now.getTime());
    if (TERMINAL.has(current.state.status) || current.state.status === "input_required" ||
      now.getTime() < current.state.nextPollAt) return toDetailed(current.state);
    if (current.state.status === "creating" || current.state.providerTaskId === null) {
      return this.failUncertain(current, caller, now.getTime());
    }

    // Persist the next allowed poll before network I/O. Concurrent readers and
    // a crash therefore cannot fan out duplicate provider polls.
    const leased: DurableTaskState = {
      ...current.state,
      updatedAt: now.getTime(),
      nextPollAt: now.getTime() + current.state.pollIntervalMs,
    };
    const lease = await this.store.compareAndSwap(taskKey(taskId), current.revision, {
      value: encode(leased),
      nowMs: now.getTime(),
      expiresAt: leased.expiresAt,
    });
    if (lease.status !== "updated") {
      return toDetailed((await this.read(taskId, caller, now.getTime())).state);
    }
    const versionedLease = decode(lease.record);
    try {
      const parsedInput = this.provider.parseInput(versionedLease.state.operationInput);
      const outcome = await this.provider.poll(
        versionedLease.state.providerTaskId ?? "",
        parsedInput,
        signal,
      );
      return this.persistPollOutcome(versionedLease, outcome, caller, now.getTime());
    } catch (error) {
      if (signal.aborted) throw error;
      return this.persistPollOutcome(versionedLease, {
        status: "failed",
        error: sanitizeUpstreamError(error, "mcp-tasks"),
      }, caller, now.getTime());
    }
  }

  async update(
    taskId: string,
    inputResponses: Record<string, unknown>,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<void> {
    let current = await this.read(taskId, caller, now.getTime());
    if (current.state.status !== "input_required") {
      throw taskError("Task is not waiting for input");
    }
    const used = new Set(current.state.usedInputKeys);
    const accepted = Object.fromEntries(Object.entries(inputResponses).filter(([key]) =>
      Object.hasOwn(current.state.inputRequests, key) && !used.has(key)
    ));
    if (Object.keys(accepted).length === 0) return;
    if (this.provider.update === undefined || current.state.providerTaskId === null) {
      throw taskError("Provider task does not accept updates");
    }
    const acceptedKeys = Object.keys(accepted);
    const operationKey = `input-${inputFingerprint({
      inputRequests: current.state.inputRequests,
      usedInputKeys: current.state.usedInputKeys,
    })}`;
    const receipt = `response-${inputFingerprint(accepted)}`;
    const identity = {
      jobId: taskId,
      effectKind: "provider_task_update" as const,
      operationKey,
    };
    const claim = await this.effects.claim(
      identity.jobId,
      identity.effectKind,
      identity.operationKey,
      now.getTime(),
    );
    if (claim.status === "existing") {
      if (claim.effect.status !== "succeeded" || claim.effect.receipt !== receipt) {
        throw uncertainUpdateError();
      }
    } else {
      const inflight = await this.effects.transition(
        identity,
        claim.revision,
        "inflight",
        now.getTime(),
      );
      try {
        await this.provider.update(current.state.providerTaskId, accepted, signal);
      } catch {
        try {
          await this.effects.transition(
            identity,
            inflight.revision,
            "uncertain",
            now.getTime(),
          );
        } catch {
          // The existing inflight evidence is already sufficient to prevent replay.
        }
        throw uncertainUpdateError();
      }
      try {
        await this.effects.transition(
          identity,
          inflight.revision,
          "succeeded",
          now.getTime(),
          receipt,
        );
      } catch {
        throw uncertainUpdateError();
      }
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remaining = Object.fromEntries(Object.entries(current.state.inputRequests).filter(
        ([key]) => !acceptedKeys.includes(key),
      ));
      const next: DurableTaskState = {
        ...current.state,
        status: Object.keys(remaining).length === 0 ? "working" : "input_required",
        inputRequests: remaining,
        usedInputKeys: [...current.state.usedInputKeys, ...acceptedKeys],
        updatedAt: now.getTime(),
        nextPollAt: now.getTime(),
      };
      const saved = await this.store.compareAndSwap(taskKey(taskId), current.revision, {
        value: encode(next),
        nowMs: now.getTime(),
        expiresAt: next.expiresAt,
      });
      if (saved.status === "updated") return;
      if (saved.status === "missing") throw taskError("Unknown or unavailable task");
      current = decode(saved.record);
      assertCaller(current.state, caller);
      if (acceptedKeys.every((key) => current.state.usedInputKeys.includes(key))) return;
      if (current.state.status !== "input_required" ||
        `input-${inputFingerprint({
          inputRequests: current.state.inputRequests,
          usedInputKeys: current.state.usedInputKeys,
        })}` !== operationKey) {
        throw taskError("Task update conflicted; retry with fresh state");
      }
    }
    throw taskError("Task update conflicted; retry with fresh state");
  }

  async cancel(
    taskId: string,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<void> {
    let current = await this.read(taskId, caller, now.getTime());
    if (current.state.status !== "cancelled") {
      if (TERMINAL.has(current.state.status)) throw taskError("Task is already terminal");
      const cancelled: DurableTaskState = {
        ...current.state,
        status: "cancelled",
        groundlanePollingCancelled: true,
        upstreamCancelRequested: true,
        updatedAt: now.getTime(),
      };
      const saved = await this.store.compareAndSwap(taskKey(taskId), current.revision, {
        value: encode(cancelled),
        nowMs: now.getTime(),
        expiresAt: cancelled.expiresAt,
      });
      if (saved.status === "missing") throw taskError("Unknown or unavailable task");
      current = decode(saved.record);
      assertCaller(current.state, caller);
      if (current.state.status !== "cancelled") return;
    }
    if (current.state.upstreamCancelled || this.provider.cancel === undefined ||
      current.state.providerTaskId === null) return;

    const identity = {
      jobId: taskId,
      effectKind: "provider_task_cancel" as const,
      operationKey: "cancel",
    };
    const claim = await this.effects.claim(
      identity.jobId,
      identity.effectKind,
      identity.operationKey,
      now.getTime(),
    );
    let claimedRevision: number;
    if (claim.status === "claimed") {
      claimedRevision = claim.revision;
    } else if (claim.effect.status === "succeeded") {
      await this.markUpstreamCancelled(taskId, caller, now.getTime());
      return;
    } else if (claim.effect.status === "uncertain") {
      const retried = await this.effects.retry(identity, claim.revision, now.getTime());
      if (retried.status === "blocked") return;
      claimedRevision = retried.revision;
    } else {
      return;
    }

    let inflightRevision: number;
    try {
      const inflight = await this.effects.transition(
        identity,
        claimedRevision,
        "inflight",
        now.getTime(),
      );
      inflightRevision = inflight.revision;
    } catch {
      return;
    }
    let acknowledged = false;
    try {
      acknowledged = await this.provider.cancel(current.state.providerTaskId, signal) !== null;
    } catch {
      // A transient provider failure does not undo the public cancellation.
    }
    if (!acknowledged) {
      try {
        await this.effects.transition(
          identity,
          inflightRevision,
          "uncertain",
          now.getTime(),
        );
      } catch {
        // A concurrent retry or storage failure leaves upstreamCancelled false.
      }
      return;
    }
    try {
      await this.effects.transition(
        identity,
        inflightRevision,
        "succeeded",
        now.getTime(),
        "provider-cancel-acknowledged",
      );
    } catch {
      return;
    }
    await this.markUpstreamCancelled(taskId, caller, now.getTime());
  }

  /** Record only that a compatibility caller stopped waiting; task work continues. */
  async stopWaiting(
    taskId: string,
    caller: AsyncJobCaller,
    now = new Date(),
  ): Promise<void> {
    const current = await this.read(taskId, caller, now.getTime());
    if (current.state.callerCancelled) return;
    const next: DurableTaskState = {
      ...current.state,
      callerCancelled: true,
      updatedAt: now.getTime(),
    };
    await this.store.compareAndSwap(taskKey(taskId), current.revision, {
      value: encode(next),
      nowMs: now.getTime(),
      expiresAt: next.expiresAt,
    });
  }

  async describe(
    taskId: string,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<McpTaskOperationalDetails> {
    const task = await this.get(taskId, caller, signal, now);
    const { state } = await this.read(taskId, caller, now.getTime());
    return {
      task,
      billingProvenance: state.billing === null
        ? { providerId: state.providerId, reported: false }
        : {
            providerId: state.providerId,
            reported: true,
            inputUnits: state.billing.inputUnits,
            outputUnits: state.billing.outputUnits,
          },
      cancellation: {
        callerStoppedWaiting: state.callerCancelled,
        groundlanePollingCancelled: state.groundlanePollingCancelled,
        upstreamCancelRequested: state.upstreamCancelRequested,
        upstreamCancelled: state.upstreamCancelled,
      },
    };
  }

  private async markUpstreamCancelled(
    taskId: string,
    caller: AsyncJobCaller,
    nowMs: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.read(taskId, caller, nowMs);
      if (current.state.upstreamCancelled) return;
      const acknowledged: DurableTaskState = {
        ...current.state,
        upstreamCancelled: true,
        updatedAt: nowMs,
      };
      const saved = await this.store.compareAndSwap(taskKey(taskId), current.revision, {
        value: encode(acknowledged),
        nowMs,
        expiresAt: acknowledged.expiresAt,
      });
      if (saved.status === "updated") return;
      if (saved.status === "missing") throw taskError("Unknown or unavailable task");
    }
    throw taskError("Task cancellation acknowledgment conflicted", "UPSTREAM_ERROR");
  }

  private async read(taskId: string, caller: AsyncJobCaller, nowMs: number): Promise<VersionedTask> {
    assertIdentity(taskId, "taskId");
    validateTime(nowMs);
    const record = await this.store.get(taskKey(taskId));
    if (record === null) throw taskError("Unknown or unavailable task");
    const current = decode(record);
    assertCaller(current.state, caller);
    if (nowMs >= current.state.expiresAt) throw taskError("Unknown or unavailable task");
    return current;
  }

  private async persistPollOutcome(
    current: VersionedTask,
    outcome: AsyncTaskPollOutcome,
    caller: AsyncJobCaller,
    nowMs: number,
  ): Promise<DetailedMcpTask> {
    let next: DurableTaskState;
    if (outcome.status === "completed") {
      next = { ...current.state, status: "completed", result: outcome.result ?? {}, billing: outcome.billing ?? null, updatedAt: nowMs };
    } else if (outcome.status === "failed") {
      next = { ...current.state, status: "failed", sanitizedError: sanitizeUpstreamError(outcome.error ?? "The provider task failed", "mcp-tasks"), updatedAt: nowMs };
    } else if (outcome.status === "input_required") {
      const used = new Set(current.state.usedInputKeys);
      const requests = Object.fromEntries(Object.entries(outcome.inputRequests ?? {}).filter(([key]) => !used.has(key)));
      next = { ...current.state, status: "input_required", inputRequests: requests, updatedAt: nowMs };
    } else {
      next = { ...current.state, status: "working", updatedAt: nowMs };
    }
    const result = await this.store.compareAndSwap(taskKey(current.state.taskId), current.revision, {
      value: encode(next),
      nowMs,
      expiresAt: next.expiresAt,
    });
    if (result.status === "updated") return toDetailed(decode(result.record).state);
    return toDetailed((await this.read(current.state.taskId, caller, nowMs)).state);
  }

  private async failUncertain(
    current: VersionedTask,
    caller: AsyncJobCaller,
    nowMs: number,
    cause?: unknown,
  ): Promise<DetailedMcpTask> {
    const failed: DurableTaskState = {
      ...current.state,
      status: "failed",
      sanitizedError: "Provider task creation outcome is uncertain",
      updatedAt: nowMs,
    };
    const saved = await this.store.compareAndSwap(taskKey(current.state.taskId), current.revision, {
      value: encode(failed),
      nowMs,
      expiresAt: failed.expiresAt,
    });
    if (saved.status === "updated") return toDetailed(decode(saved.record).state);
    if (cause !== undefined && saved.status === "missing") {
      throw taskError("Provider task creation outcome is uncertain");
    }
    return toDetailed((await this.read(current.state.taskId, caller, nowMs)).state);
  }

  private async markEffectUncertain(taskId: string, revision: number, nowMs: number): Promise<void> {
    try {
      await this.effects.transition(
        { jobId: taskId, effectKind: "provider_task_create", operationKey: "initial" },
        revision,
        "uncertain",
        nowMs,
      );
    } catch {
      // The task record remains fail-closed even if evidence persistence races.
    }
  }
}
