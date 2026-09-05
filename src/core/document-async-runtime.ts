import { createHash } from "node:crypto";
import { z } from "zod";

import { validateEnvelope, type CanonicalDocumentEnvelope } from "./canonical-document.js";
import type { DurableDocumentJobCaller, DurableDocumentJob, DurableDocumentJobRepository } from "./durable-document-jobs.js";
import type { DurableEffectJournal, DurableEffectKind } from "./durable-effects.js";
import type { DurableRecordStorePort } from "./durable-store.js";
import { GroundlaneError } from "./errors.js";
import { Deadline, withinDeadline } from "./limits.js";

const boundedId = z.string().min(1).max(256);
const snapshotSchema = z.object({
  refId: boundedId, contentHash: z.string().regex(/^sha256-[a-f0-9]{64}$/u),
  byteSize: z.number().int().positive(), expiresAt: z.number().int().nonnegative(),
}).strict();
const policySchema = z.object({
  absoluteDeadlineMs: z.number().int().positive(), totalExecutionBudgetMs: z.number().int().positive(),
  perAttemptDeadlineMs: z.number().int().positive(), maxInputBytes: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal("1"), source: snapshotSchema, providerId: boundedId,
  policy: policySchema, budgetEndsAt: z.number().int().positive(),
  providerTaskId: boundedId.nullable(), dispatchCancelled: z.boolean(),
  upstreamRequested: z.boolean(), upstreamAcknowledged: z.boolean(),
  resultArtifactRef: boundedId.nullable().default(null), resultCleanupDone: z.boolean().default(false),
  sourceRevocation: z.enum(["deleted", "expired"]).nullable().default(null),
}).strict();
type State = z.infer<typeof stateSchema>;
export type DocumentAsyncSourceSnapshot = z.infer<typeof snapshotSchema>;
export type DocumentAsyncPolicy = z.infer<typeof policySchema>;

export interface DocumentAsyncArtifactPort {
  /** Enforces owner/credential binding, current source revocation and expiry. */
  inspectSource(refId: string, caller: DurableDocumentJobCaller, signal: AbortSignal): Promise<DocumentAsyncSourceSnapshot>;
  readSource(refId: string, caller: DurableDocumentJobCaller, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  /** Writes immutable canonical bytes with ownership, digest and retention metadata. */
  writeResult(jobId: string, bytes: Uint8Array, caller: DurableDocumentJobCaller, expiresAt: number, signal: AbortSignal, source: DocumentAsyncSourceSnapshot): Promise<string>;
  /** Idempotent revocation and retryable physical cleanup, including already revoked refs. */
  revokeResult(refId: string, caller: DurableDocumentJobCaller, signal: AbortSignal): Promise<{ readonly cleanupPending: boolean }>;
  /** Returns the reserved ref even for partial/expired writes so terminal cleanup can locate it. */
  recoverResult(jobId: string, caller: DurableDocumentJobCaller, signal: AbortSignal): Promise<{ readonly refId: string; readonly ready: boolean } | null>;
}

export type DocumentAsyncProviderStatus =
  | { readonly status: "pending" | "running" }
  | { readonly status: "failed" }
  | { readonly status: "completed"; readonly envelope: CanonicalDocumentEnvelope };

/** Implementations must supply real provider I/O, sanitization and bounded response decoding. */
export interface DocumentAsyncProviderPort {
  readonly providerId: string;
  /** This is the actual potentially billable submission; it is never followed by a synthetic paid call. */
  create(source: Uint8Array, idempotencyKey: string, signal: AbortSignal): Promise<string>;
  poll(providerTaskId: string, signal: AbortSignal): Promise<DocumentAsyncProviderStatus>;
  cancel(providerTaskId: string, signal: AbortSignal): Promise<{ readonly acknowledged: boolean }>;
}

export interface CreateDocumentAsyncInput {
  readonly mode: "async";
  readonly idempotencyKey: string;
  readonly sourceRefId: string;
  readonly expiresAt: number;
  readonly policy: DocumentAsyncPolicy;
}

export interface DocumentAsyncStatus {
  readonly job: Omit<DurableDocumentJob, "credentialBinding">;
  readonly dispatchCancelled: boolean;
  readonly upstreamRequested: boolean;
  readonly upstreamAcknowledged: boolean;
  readonly resultCleanupPending: boolean;
  readonly sourceRevocation: "deleted" | "expired" | null;
}

function failure(message: string, code: "INVALID_INPUT" | "UPSTREAM_ERROR" | "CANCELLED" | "DEADLINE_EXCEEDED" = "UPSTREAM_ERROR"): GroundlaneError {
  return new GroundlaneError(code, "document-async", message, false);
}
function key(jobId: string): string { return `document-async:${jobId}`; }
function hash(bytes: Uint8Array | string): string { return `sha256-${createHash("sha256").update(bytes).digest("hex")}`; }
const terminal = new Set(["completed", "failed", "cancelled", "expired"]);

/**
 * Explicit provider-owned orchestration. create acknowledges durable metadata;
 * a deployment-owned dispatcher invokes advance independently of client waits.
 * The runtime does not start background work or pretend a provider is configured.
 */
export class DocumentAsyncRuntime {
  private readonly active = new Map<string, Set<AbortController>>();

  constructor(
    private readonly store: DurableRecordStorePort,
    private readonly jobs: DurableDocumentJobRepository,
    private readonly effects: DurableEffectJournal,
    private readonly artifacts: DocumentAsyncArtifactPort,
    private readonly provider: DocumentAsyncProviderPort,
    private readonly clock: () => number = Date.now,
  ) {}

  async create(input: CreateDocumentAsyncInput, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal): Promise<DocumentAsyncStatus> {
    if (input.mode !== "async") throw failure("Document jobs require explicit async mode", "INVALID_INPUT");
    const policy = policySchema.parse(input.policy);
    boundedId.parse(this.provider.providerId);
    return withinDeadline(async (createSignal) => {
      const source = snapshotSchema.parse(await this.artifacts.inspectSource(input.sourceRefId, caller, createSignal));
      const now = this.clock();
      if (source.refId !== input.sourceRefId || source.byteSize > policy.maxInputBytes ||
          Math.min(source.expiresAt, input.expiresAt, policy.absoluteDeadlineMs) <= now) {
        throw failure("Source or execution policy is invalid or expired", "INVALID_INPUT");
      }
      createSignal.throwIfAborted();
      const fingerprint = hash(JSON.stringify({ source, policy, expiresAt: input.expiresAt, providerId: this.provider.providerId }));
      const created = await this.jobs.createIfAbsent({
        ...caller, idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint,
        nowMs: now, expiresAt: Math.min(input.expiresAt, source.expiresAt),
      });
      const state: State = {
        schemaVersion: "1", source, providerId: this.provider.providerId, policy,
        budgetEndsAt: Math.min(policy.absoluteDeadlineMs, created.value.job.createdAt + policy.totalExecutionBudgetMs),
        providerTaskId: null, dispatchCancelled: false, upstreamRequested: false, upstreamAcknowledged: false,
        resultArtifactRef: null, resultCleanupDone: false, sourceRevocation: null,
      };
      await this.store.createIfAbsent({ key: key(created.value.job.jobId), value: JSON.stringify(state), nowMs: now });
      return this.status(created.value.job.jobId, caller, deadline, createSignal);
    }, deadline, signal, "document-async-create");
  }

  /** Poll timeout/disconnect only ends this read; it never drives or cancels a job. */
  async status(jobId: string, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal): Promise<DocumentAsyncStatus> {
    return withinDeadline(async () => {
      const state = await this.read(jobId);
      const current = await this.expire(jobId, caller, state);
      const job = current.job;
      return { job: {
        schemaVersion: job.schemaVersion, jobId: job.jobId, ownerId: job.ownerId,
        idempotencyKey: job.idempotencyKey, requestFingerprint: job.requestFingerprint,
        status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
        expiresAt: job.expiresAt, resultArtifactRef: state.sourceRevocation === null ? job.resultArtifactRef : null, sanitizedError: job.sanitizedError,
      }, dispatchCancelled: state.dispatchCancelled,
        upstreamRequested: state.upstreamRequested, upstreamAcknowledged: state.upstreamAcknowledged,
        resultCleanupPending: state.resultArtifactRef !== null && !state.resultCleanupDone && (job.status !== "completed" || state.sourceRevocation !== null),
        sourceRevocation: state.sourceRevocation };
    }, deadline, signal, "document-async-poll-wait");
  }

  /** One bounded attempt. Restart/retry reuses persisted submission and result receipts. */
  async advance(jobId: string, caller: DurableDocumentJobCaller, parent?: AbortSignal): Promise<void> {
    parent?.throwIfAborted();
    const before = await this.jobs.get(jobId, caller, this.clock());
    const state = await this.read(jobId);
    let current = await this.expire(jobId, caller, state);
    if (terminal.has(current.job.status)) {
      await this.reconcileResultCleanup(jobId, caller, new Deadline(state.policy.perAttemptDeadlineMs), parent);
      if (state.upstreamRequested && !state.upstreamAcknowledged) {
        await this.reconcileCancellation(jobId, caller, new Deadline(state.policy.perAttemptDeadlineMs), parent);
      }
      if (!terminal.has(before.job.status) && current.job.status === "expired") {
        throw failure("Document absolute deadline or total execution budget exhausted", "DEADLINE_EXCEEDED");
      }
      return;
    }
    await this.assertActive(jobId, caller);
    const remaining = Math.min(state.budgetEndsAt, current.job.expiresAt) - this.clock();
    const deadline = new Deadline(Math.min(state.policy.perAttemptDeadlineMs, remaining));
    const controller = new AbortController();
    const controllers = this.active.get(jobId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.active.set(jobId, controllers);
    try {
      await withinDeadline(async (signal) => {
        if (current.job.status !== "running") {
          const transition = await this.jobs.transition(jobId, caller, current.revision, "running", this.clock());
          current = transition.value;
          if (terminal.has(current.job.status)) return;
        }
        const source = snapshotSchema.parse(await this.artifacts.inspectSource(state.source.refId, caller, signal));
        if (JSON.stringify(source) !== JSON.stringify(state.source)) throw failure("Source snapshot changed or was revoked", "INVALID_INPUT");
        const providerTaskId = await this.effect(jobId, "provider_task_create", caller, signal, async () => {
          const bytes = await this.artifacts.readSource(source.refId, caller, state.policy.maxInputBytes, signal);
          if (bytes.byteLength !== source.byteSize || bytes.byteLength > state.policy.maxInputBytes || hash(bytes) !== source.contentHash) {
            throw failure("Source snapshot integrity check failed", "INVALID_INPUT");
          }
          await this.assertActive(jobId, caller);
          signal.throwIfAborted();
          const submittedId = boundedId.parse(await this.provider.create(bytes, jobId, signal));
          // Save the mapping before the success receipt so cancellation after a
          // restart can find every acknowledged submission, including a race
          // with an explicit cancel while the provider was responding.
          await this.update(jobId, (latest) => ({ ...latest, providerTaskId: submittedId }));
          return submittedId;
        });
        const submitted = await this.update(jobId, (latest) => ({ ...latest, providerTaskId }));
        if (submitted.upstreamRequested && !submitted.upstreamAcknowledged) {
          // A late acknowledgment belongs to the durable job, not the expired
          // attempt. Reconcile the owner's already committed cancel request
          // under a separate bounded cancellation attempt.
          await this.reconcileCancellation(jobId, caller, new Deadline(state.policy.perAttemptDeadlineMs));
        }
        await this.assertActive(jobId, caller);
        signal.throwIfAborted();
        let result: DocumentAsyncProviderStatus;
        try { result = await this.provider.poll(providerTaskId, signal); }
        catch (error) {
          throw new GroundlaneError(error instanceof GroundlaneError ? error.code : "UPSTREAM_ERROR", "document-async", "Document provider status request failed", false);
        }
        await this.assertActive(jobId, caller);
        signal.throwIfAborted();
        if (result.status === "failed") {
          const latest = await this.jobs.get(jobId, caller, this.clock());
          signal.throwIfAborted();
          await this.jobs.transition(jobId, caller, latest.revision, "failed", this.clock(), { sanitizedError: "Document provider execution failed" });
        } else if (result.status === "completed") {
          const latestSource = snapshotSchema.parse(await this.artifacts.inspectSource(state.source.refId, caller, signal));
          if (JSON.stringify(latestSource) !== JSON.stringify(state.source)) throw failure("Source snapshot changed or was revoked", "INVALID_INPUT");
          try { validateEnvelope(result.envelope); }
          catch { throw failure("Document provider returned a malformed canonical envelope"); }
          if (result.envelope.sourceIdentity.contentHash !== state.source.contentHash) throw failure("Document provider result source identity mismatch");
          const bytes = new TextEncoder().encode(JSON.stringify(result.envelope));
          if (bytes.byteLength > state.policy.maxOutputBytes) throw failure("Document provider output exceeds byte limit", "INVALID_INPUT");
          const resultArtifactRef = await this.effect(jobId, "artifact_write", caller, signal, async () => {
            const acknowledged = boundedId.parse(await this.artifacts.writeResult(jobId, bytes, caller, current.job.expiresAt, signal, state.source));
            // Independent of attempt cancellation: retain the successful storage
            // acknowledgment before the journal receipt or completion transition.
            await this.update(jobId, (latest) => ({ ...latest, resultArtifactRef: acknowledged }));
            await this.reconcileResultCleanup(jobId, caller, new Deadline(state.policy.perAttemptDeadlineMs)).catch(() => undefined);
            return acknowledged;
          });
          await this.assertActive(jobId, caller);
          const latest = await this.jobs.get(jobId, caller, this.clock());
          signal.throwIfAborted();
          await this.jobs.transition(jobId, caller, latest.revision, "completed", this.clock(), { resultArtifactRef });
        }
      }, deadline, parent === undefined ? controller.signal : AbortSignal.any([controller.signal, parent]), "document-async-attempt");
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) this.active.delete(jobId);
      await this.reconcileResultCleanup(jobId, caller, new Deadline(state.policy.perAttemptDeadlineMs)).catch(() => undefined);
    }
  }

  async cancel(jobId: string, caller: DurableDocumentJobCaller, upstream: boolean, deadline: Deadline, signal?: AbortSignal): Promise<DocumentAsyncStatus> {
    return withinDeadline(async (cancelSignal) => {
      const before = await this.jobs.get(jobId, caller, this.clock());
      cancelSignal.throwIfAborted();
      if (terminal.has(before.job.status) && before.job.status !== "cancelled") {
        await this.reconcileResultCleanup(jobId, caller, deadline, cancelSignal);
        return this.status(jobId, caller, deadline, cancelSignal);
      }
      await this.update(jobId, (latest) => ({ ...latest, dispatchCancelled: true, upstreamRequested: latest.upstreamRequested || upstream }), cancelSignal);
      for (const controller of this.active.get(jobId) ?? []) controller.abort(failure("Document dispatch cancelled", "CANCELLED"));
      for (;;) {
        const current = await this.jobs.get(jobId, caller, this.clock());
        cancelSignal.throwIfAborted();
        if (terminal.has(current.job.status)) break;
        const changed = await this.jobs.transition(jobId, caller, current.revision, "cancelled", this.clock());
        if (changed.status === "updated") break;
      }
      await this.reconcileResultCleanup(jobId, caller, deadline, cancelSignal);
      if (upstream) await this.reconcileCancellation(jobId, caller, deadline, cancelSignal);
      return this.status(jobId, caller, deadline, cancelSignal);
    }, deadline, signal, "document-async-cancel");
  }

  /** Original source authority revoked: stop dispatch and revoke transient outputs, without inventing upstream acknowledgment. */
  async revokeSource(jobId: string, caller: DurableDocumentJobCaller, reason: "deleted" | "expired", deadline: Deadline, signal?: AbortSignal): Promise<DocumentAsyncStatus> {
    return withinDeadline(async (revokeSignal) => {
      // Authorize and terminalize without get() first converting source expiry
      // into an unrelated execution deadline transition.
      await this.jobs.revokeSource(jobId, caller, this.clock());
      revokeSignal.throwIfAborted();
      await this.update(jobId, (latest) => ({ ...latest, dispatchCancelled: true,
        sourceRevocation: latest.sourceRevocation === "deleted" ? "deleted" : reason }), revokeSignal);
      for (const controller of this.active.get(jobId) ?? []) controller.abort(failure("Document source revoked", "CANCELLED"));
      await this.reconcileResultCleanup(jobId, caller, deadline, revokeSignal);
      return this.status(jobId, caller, deadline, revokeSignal);
    }, deadline, signal, "document-async-source-revocation");
  }

  /** Durable acknowledgment plus terminal lifecycle drives cleanup after restart. */
  async reconcileResultCleanup(jobId: string, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal): Promise<void> {
    return withinDeadline(async (cleanupSignal) => {
      let state = await this.read(jobId);
      const current = await this.expire(jobId, caller, state);
      if (!terminal.has(current.job.status) || (current.job.status === "completed" && state.sourceRevocation === null) || state.resultCleanupDone) return;
      if (state.resultArtifactRef === null) {
        const recovered = await this.artifacts.recoverResult(jobId, caller, cleanupSignal);
        if (recovered === null) return;
        state = await this.update(jobId, (latest) => ({ ...latest, resultArtifactRef: recovered.refId }));
      }
      if (state.resultArtifactRef === null) return;
      cleanupSignal.throwIfAborted();
      const result = await this.artifacts.revokeResult(state.resultArtifactRef, caller, cleanupSignal);
      if (!result.cleanupPending) {
        await this.update(jobId, (latest) => ({ ...latest,
          resultCleanupDone: latest.resultArtifactRef === state.resultArtifactRef,
        }));
      }
    }, deadline, signal, "document-async-result-cleanup");
  }

  /** Dispatcher recovery for an upstream cancel committed before provider acknowledgment. */
  async reconcileCancellation(jobId: string, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal): Promise<void> {
    return withinDeadline(async (cancelSignal) => {
      await this.jobs.get(jobId, caller, this.clock());
      const state = await this.read(jobId);
      cancelSignal.throwIfAborted();
      if (!state.upstreamRequested || state.providerTaskId === null || state.upstreamAcknowledged) return;
      const acknowledged = await this.effect(jobId, "provider_task_cancel", caller, cancelSignal, async () => {
        const result = await this.provider.cancel(state.providerTaskId ?? "", cancelSignal);
        return result.acknowledged ? "acknowledged" : "not-acknowledged";
      }, true);
      await this.update(jobId, (latest) => ({ ...latest,
        upstreamAcknowledged: latest.upstreamAcknowledged || acknowledged === "acknowledged" }));
    }, deadline, signal, "document-async-cancel-reconcile");
  }

  private async assertActive(jobId: string, caller: DurableDocumentJobCaller): Promise<void> {
    const state = await this.read(jobId);
    const job = await this.expire(jobId, caller, state);
    if (state.providerId !== this.provider.providerId) throw failure("Document provider binding changed", "INVALID_INPUT");
    if (this.clock() >= Math.min(state.budgetEndsAt, job.job.expiresAt)) throw failure("Document absolute deadline or total execution budget exhausted", "DEADLINE_EXCEEDED");
    if (state.dispatchCancelled || terminal.has(job.job.status)) throw failure("Document dispatch is terminal or cancelled", "CANCELLED");
  }

  private async expire(jobId: string, caller: DurableDocumentJobCaller, state: State) {
    for (;;) {
      const current = await this.jobs.get(jobId, caller, this.clock());
      if (terminal.has(current.job.status) || this.clock() < state.budgetEndsAt) return current;
      const expired = await this.jobs.transition(jobId, caller, current.revision, "expired", this.clock());
      if (expired.status === "updated") return expired.value;
    }
  }

  private async effect(jobId: string, kind: DurableEffectKind, caller: DurableDocumentJobCaller, signal: AbortSignal,
    operation: () => Promise<string>, cancellation = false): Promise<string> {
    const identity = { jobId, effectKind: kind, operationKey: "document-async-v1" };
    if (!cancellation) await this.assertActive(jobId, caller);
    signal.throwIfAborted();
    let claim = await this.effects.claim(jobId, kind, identity.operationKey, this.clock());
    if (claim.status === "existing" && cancellation &&
        !(claim.effect.status === "succeeded" && claim.effect.receipt === "acknowledged")) {
      const retry = await this.effects.retry(identity, claim.revision, this.clock());
      if (retry.status === "claimed") claim = retry;
      else throw failure("Document cancellation effect is already claimed or inflight");
    }
    if (claim.status === "existing") {
      if (claim.effect.status === "succeeded" && claim.effect.receipt !== null) return claim.effect.receipt;
      if (kind === "provider_task_create" || kind === "artifact_write") {
        // The provider acknowledgment is durably recorded before the journal
        // receipt. A crash in that gap leaves enough evidence to resume polling,
        // without making another potentially billable submission.
        let state = await this.read(jobId);
        if (kind === "artifact_write" && state.resultArtifactRef === null) {
          const recovered = await this.artifacts.recoverResult(jobId, caller, signal);
          if (recovered?.ready) state = await this.update(jobId, (latest) => ({ ...latest, resultArtifactRef: recovered.refId }));
        }
        const receipt = kind === "provider_task_create" ? state.providerTaskId : state.resultArtifactRef;
        if (receipt !== null && !(kind === "artifact_write" && state.resultCleanupDone)) {
          await this.assertActive(jobId, caller);
          signal.throwIfAborted();
          await this.effects.transition(identity, claim.revision, "succeeded", this.clock(), receipt);
          return receipt;
        }
      }
      throw failure("Document effect outcome is unresolved; automatic repeat is prohibited");
    }
    const inflight = await this.effects.transition(identity, claim.revision, "inflight", this.clock(), null);
    try {
      if (!cancellation) await this.assertActive(jobId, caller);
      signal.throwIfAborted();
      const receipt = boundedId.parse(await operation());
      // Persist actual receipts even if cancellation raced with provider acknowledgment.
      await this.effects.transition(identity, inflight.revision,
        cancellation && receipt !== "acknowledged" ? "uncertain" : "succeeded", this.clock(), receipt);
      return receipt;
    } catch (error) {
      await this.effects.transition(identity, inflight.revision, "uncertain", this.clock(), null).catch(() => undefined);
      throw new GroundlaneError(error instanceof GroundlaneError ? error.code : "UPSTREAM_ERROR", "document-async", "Document effect outcome is uncertain; automatic repeat is prohibited", false);
    }
  }

  private async read(jobId: string): Promise<State> {
    const record = await this.store.get(key(jobId));
    if (record === null) throw failure("Document dispatch metadata is unavailable");
    try { return stateSchema.parse(JSON.parse(record.value) as unknown); }
    catch { throw failure("Document dispatch metadata is malformed"); }
  }

  private async update(jobId: string, mutate: (state: State) => State, signal?: AbortSignal): Promise<State> {
    for (;;) {
      const record = await this.store.get(key(jobId));
      signal?.throwIfAborted();
      if (record === null) throw failure("Document dispatch metadata is unavailable");
      const next = mutate(stateSchema.parse(JSON.parse(record.value) as unknown));
      const result = await this.store.compareAndSwap(key(jobId), record.revision, { value: JSON.stringify(next), nowMs: this.clock() });
      if (result.status === "updated") return next;
      if (result.status === "missing") throw failure("Document dispatch metadata is unavailable");
    }
  }
}
