import { createHash } from "node:crypto";

import {
  DurableEffectJournal,
  type DurableEffect,
  type DurableEffectKind,
  type DurableEffectStatus,
} from "./durable-effects.js";
import type { DurableRecord, DurableRecordStorePort } from "./durable-store.js";
import { GroundlaneError } from "./errors.js";

export const DURABLE_DOCUMENT_JOB_SCHEMA_VERSION = "1" as const;
export const MAX_DOCUMENT_JOB_IDENTITY_CHARS = 256;
export const MAX_DOCUMENT_JOB_FINGERPRINT_CHARS = 512;
export const MAX_DOCUMENT_JOB_ERROR_CHARS = 500;

export type DurableDocumentJobStatus =
  | "created"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface DurableDocumentJob {
  readonly schemaVersion: typeof DURABLE_DOCUMENT_JOB_SCHEMA_VERSION;
  readonly jobId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly status: DurableDocumentJobStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly resultArtifactRef: string | null;
  readonly sanitizedError: string | null;
}

export interface VersionedDurableDocumentJob {
  readonly job: DurableDocumentJob;
  readonly revision: number;
}

export interface DurableDocumentJobCaller {
  readonly ownerId: string;
  readonly credentialBinding: string;
}

export interface CreateDurableDocumentJobInput extends DurableDocumentJobCaller {
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly nowMs: number;
  readonly expiresAt: number;
}

export type CreateDurableDocumentJobResult =
  | { readonly status: "created"; readonly value: VersionedDurableDocumentJob }
  | { readonly status: "reused"; readonly value: VersionedDurableDocumentJob };

export interface DurableDocumentJobTransitionPatch {
  readonly resultArtifactRef?: string | null;
  readonly sanitizedError?: string | null;
}

export type DurableDocumentJobTransitionResult =
  | { readonly status: "updated"; readonly value: VersionedDurableDocumentJob }
  | { readonly status: "conflict"; readonly value: VersionedDurableDocumentJob };

export interface DurableDocumentEffectIdentity {
  readonly jobId: string;
  readonly effectKind: DurableEffectKind;
  readonly operationKey: string;
}

export type BeginDurableDocumentEffectResult =
  | {
      readonly status: "execute";
      readonly effect: DurableEffect;
      readonly revision: number;
    }
  | {
      readonly status: "replay";
      readonly effect: DurableEffect;
      readonly revision: number;
      readonly receipt: string;
    }
  | {
      readonly status: "blocked";
      readonly effect: DurableEffect;
      readonly revision: number;
      readonly reason: "claimed" | "inflight" | "uncertain";
    };

const TERMINAL_STATUSES: ReadonlySet<DurableDocumentJobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const STATUS_ORDER: Readonly<Record<DurableDocumentJobStatus, number>> = {
  created: 0,
  pending: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
  expired: 3,
};

function jobError(
  message: string,
  code: "INVALID_INPUT" | "DEADLINE_EXCEEDED" = "INVALID_INPUT",
): GroundlaneError {
  return new GroundlaneError(code, "durable-document-job", message);
}

function assertBounded(value: string, field: string, max: number): void {
  if (value.length === 0 || value.length > max) {
    throw jobError(`${field} must be non-empty within ${String(max)} characters`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw jobError(`${field} must be a non-negative safe integer timestamp`);
  }
}

function jobIdFor(ownerId: string, idempotencyKey: string): string {
  return `djob-${createHash("sha256")
    .update(ownerId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 32)}`;
}

function recordKey(jobId: string): string {
  return `document-job:${jobId}`;
}

function encode(job: DurableDocumentJob): string {
  return JSON.stringify(job);
}

function isStatus(value: unknown): value is DurableDocumentJobStatus {
  return typeof value === "string" && [
    "created",
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ].includes(value);
}

function decode(record: DurableRecord): VersionedDurableDocumentJob {
  let value: unknown;
  try {
    value = JSON.parse(record.value) as unknown;
  } catch {
    throw jobError("Durable document job record is malformed");
  }
  if (typeof value !== "object" || value === null) {
    throw jobError("Durable document job record is malformed");
  }
  const item = value as Partial<DurableDocumentJob>;
  if (
    item.schemaVersion !== DURABLE_DOCUMENT_JOB_SCHEMA_VERSION ||
    typeof item.jobId !== "string" ||
    typeof item.ownerId !== "string" ||
    typeof item.credentialBinding !== "string" ||
    typeof item.idempotencyKey !== "string" ||
    typeof item.requestFingerprint !== "string" ||
    !isStatus(item.status) ||
    typeof item.createdAt !== "number" ||
    typeof item.updatedAt !== "number" ||
    typeof item.expiresAt !== "number" ||
    !(item.resultArtifactRef === null || typeof item.resultArtifactRef === "string") ||
    !(item.sanitizedError === null || typeof item.sanitizedError === "string")
  ) {
    throw jobError("Durable document job record is malformed");
  }
  assertBounded(item.jobId, "jobId", MAX_DOCUMENT_JOB_IDENTITY_CHARS);
  assertBounded(item.ownerId, "ownerId", MAX_DOCUMENT_JOB_IDENTITY_CHARS);
  assertBounded(
    item.credentialBinding,
    "credentialBinding",
    MAX_DOCUMENT_JOB_IDENTITY_CHARS,
  );
  assertBounded(item.idempotencyKey, "idempotencyKey", MAX_DOCUMENT_JOB_IDENTITY_CHARS);
  assertBounded(
    item.requestFingerprint,
    "requestFingerprint",
    MAX_DOCUMENT_JOB_FINGERPRINT_CHARS,
  );
  assertTimestamp(item.createdAt, "createdAt");
  assertTimestamp(item.updatedAt, "updatedAt");
  assertTimestamp(item.expiresAt, "expiresAt");
  return { job: item as DurableDocumentJob, revision: record.revision };
}

function assertCaller(job: DurableDocumentJob, caller: DurableDocumentJobCaller): void {
  if (job.ownerId !== caller.ownerId) {
    throw jobError("Owner mismatch: caller does not own this document job");
  }
  if (job.credentialBinding !== caller.credentialBinding) {
    throw jobError("Credential binding mismatch for this document job");
  }
}

function assertTransition(
  from: DurableDocumentJobStatus,
  to: DurableDocumentJobStatus,
): void {
  if (from === to) throw jobError(`Document job is already "${from}"`);
  if (TERMINAL_STATUSES.has(from)) {
    throw jobError(`Cannot transition from terminal document job status "${from}"`);
  }
  if (STATUS_ORDER[to] < STATUS_ORDER[from]) {
    throw jobError(`Non-monotonic document job transition "${from}" -> "${to}"`);
  }
}

/**
 * Durable, provider-neutral repository for async document jobs. The record
 * store owns small lifecycle metadata; large source/result bytes remain behind
 * an immutable blob port and are referenced only by opaque ArtifactRef IDs.
 */
export class DurableDocumentJobRepository {
  constructor(
    private readonly store: DurableRecordStorePort,
    private readonly effects: DurableEffectJournal,
  ) {}

  async createIfAbsent(
    input: CreateDurableDocumentJobInput,
  ): Promise<CreateDurableDocumentJobResult> {
    assertBounded(input.ownerId, "ownerId", MAX_DOCUMENT_JOB_IDENTITY_CHARS);
    assertBounded(
      input.credentialBinding,
      "credentialBinding",
      MAX_DOCUMENT_JOB_IDENTITY_CHARS,
    );
    assertBounded(
      input.idempotencyKey,
      "idempotencyKey",
      MAX_DOCUMENT_JOB_IDENTITY_CHARS,
    );
    assertBounded(
      input.requestFingerprint,
      "requestFingerprint",
      MAX_DOCUMENT_JOB_FINGERPRINT_CHARS,
    );
    assertTimestamp(input.nowMs, "nowMs");
    assertTimestamp(input.expiresAt, "expiresAt");
    if (input.expiresAt <= input.nowMs) {
      throw jobError("expiresAt must be later than nowMs");
    }

    const jobId = jobIdFor(input.ownerId, input.idempotencyKey);
    const job: DurableDocumentJob = {
      schemaVersion: DURABLE_DOCUMENT_JOB_SCHEMA_VERSION,
      jobId,
      ownerId: input.ownerId,
      credentialBinding: input.credentialBinding,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      status: "created",
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
      expiresAt: input.expiresAt,
      resultArtifactRef: null,
      sanitizedError: null,
    };
    const result = await this.store.createIfAbsent({
      key: recordKey(jobId),
      value: encode(job),
      nowMs: input.nowMs,
      expiresAt: input.expiresAt,
    });
    const value = decode(result.record);
    if (result.status === "exists") {
      assertCaller(value.job, input);
      if (
        value.job.idempotencyKey !== input.idempotencyKey ||
        value.job.requestFingerprint !== input.requestFingerprint
      ) {
        throw jobError(
          "Idempotency key is already bound to a different document request",
        );
      }
      return { status: "reused", value };
    }
    return { status: "created", value };
  }

  async get(
    jobId: string,
    caller: DurableDocumentJobCaller,
    nowMs: number,
  ): Promise<VersionedDurableDocumentJob> {
    assertBounded(jobId, "jobId", MAX_DOCUMENT_JOB_IDENTITY_CHARS);
    assertTimestamp(nowMs, "nowMs");
    for (;;) {
      const record = await this.store.get(recordKey(jobId));
      if (record === null) throw jobError("Unknown durable document job");
      const current = decode(record);
      assertCaller(current.job, caller);
      if (nowMs < current.job.expiresAt || current.job.status === "expired") {
        return current;
      }
      const expired: DurableDocumentJob = {
        ...current.job,
        status: "expired",
        updatedAt: nowMs,
      };
      const result = await this.store.compareAndSwap(record.key, current.revision, {
        value: encode(expired),
        nowMs,
        // The metadata store rejects writes whose scan expiry is already in
        // the past. The lifecycle value retains the immutable job expiry;
        // clearing the scan index records that expiry has been materialized.
        expiresAt: null,
      });
      if (result.status === "updated") return decode(result.record);
      if (result.status === "missing") throw jobError("Unknown durable document job");
    }
  }

  async resume(
    jobId: string,
    caller: DurableDocumentJobCaller,
    nowMs: number,
  ): Promise<VersionedDurableDocumentJob> {
    return this.get(jobId, caller, nowMs);
  }

  async transition(
    jobId: string,
    caller: DurableDocumentJobCaller,
    expectedRevision: number,
    to: DurableDocumentJobStatus,
    nowMs: number,
    patch: DurableDocumentJobTransitionPatch = {},
  ): Promise<DurableDocumentJobTransitionResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw jobError("expectedRevision must be a positive safe integer");
    }
    const current = await this.get(jobId, caller, nowMs);
    if (current.revision !== expectedRevision) {
      return { status: "conflict", value: current };
    }
    assertTransition(current.job.status, to);
    const resultArtifactRef = Object.hasOwn(patch, "resultArtifactRef")
      ? (patch.resultArtifactRef ?? null)
      : current.job.resultArtifactRef;
    if (resultArtifactRef !== null) {
      assertBounded(
        resultArtifactRef,
        "resultArtifactRef",
        MAX_DOCUMENT_JOB_FINGERPRINT_CHARS,
      );
    }
    const sanitizedError = Object.hasOwn(patch, "sanitizedError")
      ? (patch.sanitizedError ?? null)
      : current.job.sanitizedError;
    if (
      sanitizedError !== null &&
      (sanitizedError.length === 0 || sanitizedError.length > MAX_DOCUMENT_JOB_ERROR_CHARS)
    ) {
      throw jobError(
        `sanitizedError must be within ${String(MAX_DOCUMENT_JOB_ERROR_CHARS)} characters`,
      );
    }
    const next: DurableDocumentJob = {
      ...current.job,
      status: to,
      updatedAt: nowMs,
      resultArtifactRef,
      sanitizedError,
    };
    const result = await this.store.compareAndSwap(recordKey(jobId), expectedRevision, {
      value: encode(next),
      nowMs,
      expiresAt: current.job.expiresAt,
    });
    if (result.status === "updated") {
      return { status: "updated", value: decode(result.record) };
    }
    if (result.status === "missing") throw jobError("Unknown durable document job");
    const conflicted = decode(result.record);
    assertCaller(conflicted.job, caller);
    return { status: "conflict", value: conflicted };
  }

  async beginEffect(
    identity: DurableDocumentEffectIdentity,
    caller: DurableDocumentJobCaller,
    nowMs: number,
  ): Promise<BeginDurableDocumentEffectResult> {
    const current = await this.get(identity.jobId, caller, nowMs);
    if (TERMINAL_STATUSES.has(current.job.status)) {
      throw jobError(
        `Cannot begin an effect for terminal document job status "${current.job.status}"`,
      );
    }
    const result = await this.effects.claim(
      identity.jobId,
      identity.effectKind,
      identity.operationKey,
      nowMs,
    );
    if (result.status === "claimed") {
      return { status: "execute", effect: result.effect, revision: result.revision };
    }
    if (result.effect.status === "succeeded") {
      if (result.effect.receipt === null) {
        throw jobError("Succeeded durable effect is missing its replay receipt");
      }
      return {
        status: "replay",
        effect: result.effect,
        revision: result.revision,
        receipt: result.effect.receipt,
      };
    }
    return {
      status: "blocked",
      effect: result.effect,
      revision: result.revision,
      reason: result.effect.status,
    };
  }

  async markEffectInflight(
    identity: DurableDocumentEffectIdentity,
    caller: DurableDocumentJobCaller,
    expectedRevision: number,
    nowMs: number,
  ): Promise<{ readonly effect: DurableEffect; readonly revision: number }> {
    return this.transitionEffect(
      identity,
      caller,
      expectedRevision,
      "inflight",
      nowMs,
      null,
    );
  }

  async markEffectSucceeded(
    identity: DurableDocumentEffectIdentity,
    caller: DurableDocumentJobCaller,
    expectedRevision: number,
    nowMs: number,
    receipt: string,
  ): Promise<{ readonly effect: DurableEffect; readonly revision: number }> {
    assertBounded(receipt, "effect receipt", MAX_DOCUMENT_JOB_FINGERPRINT_CHARS);
    return this.transitionEffect(
      identity,
      caller,
      expectedRevision,
      "succeeded",
      nowMs,
      receipt,
    );
  }

  async markEffectUncertain(
    identity: DurableDocumentEffectIdentity,
    caller: DurableDocumentJobCaller,
    expectedRevision: number,
    nowMs: number,
  ): Promise<{ readonly effect: DurableEffect; readonly revision: number }> {
    return this.transitionEffect(
      identity,
      caller,
      expectedRevision,
      "uncertain",
      nowMs,
      null,
    );
  }

  private async transitionEffect(
    identity: DurableDocumentEffectIdentity,
    caller: DurableDocumentJobCaller,
    expectedRevision: number,
    status: Exclude<DurableEffectStatus, "claimed">,
    nowMs: number,
    receipt: string | null,
  ): Promise<{ readonly effect: DurableEffect; readonly revision: number }> {
    const current = await this.get(identity.jobId, caller, nowMs);
    if (TERMINAL_STATUSES.has(current.job.status)) {
      throw jobError(
        `Cannot update an effect for terminal document job status "${current.job.status}"`,
      );
    }
    return this.effects.transition(identity, expectedRevision, status, nowMs, receipt);
  }
}
