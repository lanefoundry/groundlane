import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { DurableDocumentJobCaller } from "./durable-document-jobs.js";
import type { DurableRecord, DurableRecordStorePort } from "./durable-store.js";
import { GroundlaneError } from "./errors.js";
import { Deadline, withinDeadline } from "./limits.js";

const id = z.string().min(1).max(256);
const entrySchema = z.object({
  schemaVersion: z.literal("1"), jobId: id,
  caller: z.object({ ownerId: id, credentialBinding: id }).strict(),
  phase: z.enum(["scheduled", "leased", "idle"]),
  token: z.string(), failures: z.number().int().min(0).max(30),
}).strict();
type Entry = z.infer<typeof entrySchema>;
const terminal = new Set(["completed", "failed", "cancelled", "expired", "deleted"]);

export interface DocumentDispatchRuntime {
  advance(jobId: string, caller: DurableDocumentJobCaller, signal?: AbortSignal): Promise<void>;
  status(jobId: string, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal): Promise<{
    readonly job: { readonly status: string; readonly expiresAt: number };
    readonly resultCleanupPending: boolean;
    readonly upstreamRequested?: boolean;
    readonly upstreamAcknowledged?: boolean;
  }>;
}

export interface DocumentDispatcherOptions {
  readonly attemptTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxBackoffMs?: number;
}

export interface DocumentDispatchDrainResult {
  readonly scanned: number;
  readonly claimed: number;
  readonly advanced: number;
  readonly rescheduled: number;
  readonly idle: number;
  readonly failed: number;
  readonly leaseLost: number;
  readonly malformed: number;
  readonly nextCursor: string | null;
}

function invalid(message: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "document-dispatch", message);
}
function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid("Invalid document dispatcher bound");
  return value;
}
function entryKey(jobId: string): string {
  return `dispatch:${createHash("sha256").update(id.parse(jobId)).digest("hex")}`;
}
function decode(record: DurableRecord): Entry {
  return entrySchema.parse(JSON.parse(record.value) as unknown);
}

/**
 * Durable bounded scheduler. Its store MUST have a dedicated namespace:
 * expiresAt means next eligibility/lease expiry, NOT record deletion or job TTL.
 * Credentials here are opaque bindings, never API keys or raw bearer tokens.
 *
 * enqueue is not atomic with runtime.create. Composition must enqueue before
 * acknowledging a created/reused job; a crash between creation and enqueue
 * requires idempotent caller retry or a separate durable creation outbox.
 */
export class DocumentAsyncDispatcher {
  private readonly attemptTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly store: DurableRecordStorePort,
    private readonly runtime: DocumentDispatchRuntime,
    options: DocumentDispatcherOptions = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.attemptTimeoutMs = integer(options.attemptTimeoutMs ?? 120_000, 1, 120_000);
    this.leaseMs = integer(options.leaseMs ?? this.attemptTimeoutMs + 10_000, this.attemptTimeoutMs + 1, 300_000);
    this.pollIntervalMs = integer(options.pollIntervalMs ?? 5_000, 1, 3_600_000);
    this.maxBackoffMs = integer(options.maxBackoffMs ?? Math.max(this.pollIntervalMs, 300_000), this.pollIntervalMs, 3_600_000);
  }

  /** Idempotent wakeup. Never steals an active lease or delays existing work. */
  async enqueue(jobId: string, caller: DurableDocumentJobCaller, options: { readonly nextAttemptAt?: number; readonly signal?: AbortSignal } = {}): Promise<void> {
    const now = integer(this.clock(), 0, Number.MAX_SAFE_INTEGER - this.leaseMs);
    const nextAttemptAt = integer(options.nextAttemptAt ?? now + 1, now + 1, Number.MAX_SAFE_INTEGER);
    const entry: Entry = entrySchema.parse({ schemaVersion: "1", jobId, caller, phase: "scheduled", token: "", failures: 0 });
    options.signal?.throwIfAborted();
    const created = await this.store.createIfAbsent({ key: entryKey(jobId), value: JSON.stringify(entry), nowMs: now, expiresAt: nextAttemptAt });
    if (created.status === "created") return;
    let record = created.record;
    for (let attempt = 0; attempt < 8; attempt++) {
      options.signal?.throwIfAborted();
      const existing = decode(record);
      if (existing.jobId !== jobId || existing.caller.ownerId !== caller.ownerId || existing.caller.credentialBinding !== caller.credentialBinding) {
        throw invalid("Document dispatch owner or credential mismatch");
      }
      if (existing.phase === "leased" || (existing.phase === "scheduled" && record.expiresAt !== null && record.expiresAt <= nextAttemptAt)) return;
      const changed = await this.store.compareAndSwap(record.key, record.revision, { value: JSON.stringify(entry), nowMs: now, expiresAt: nextAttemptAt });
      if (changed.status === "updated") return;
      if (changed.status === "missing") throw invalid("Document dispatch record disappeared");
      record = changed.record;
    }
    throw new GroundlaneError("UPSTREAM_ERROR", "document-dispatch", "Document dispatch scheduling conflict", true);
  }

  async drain(options: { readonly nowMs?: number; readonly limit?: number; readonly concurrency?: number; readonly signal?: AbortSignal } = {}): Promise<DocumentDispatchDrainResult> {
    const now = integer(options.nowMs ?? this.clock(), 0, Number.MAX_SAFE_INTEGER - this.leaseMs);
    const limit = integer(options.limit ?? 20, 1, 100);
    const concurrency = integer(options.concurrency ?? 2, 1, 8);
    options.signal?.throwIfAborted();
    const cursorRecord = await this.store.get("dispatch-cursor");
    let cursor: string | null = null;
    if (cursorRecord !== null) {
      try { cursor = z.string().min(1).max(240).regex(/^[A-Za-z0-9._:-]+$/u).nullable().parse(JSON.parse(cursorRecord.value) as unknown); }
      catch { /* A malformed cursor must not stop bounded recovery. */ }
    }
    const page = await this.store.scanExpired(now, cursor, limit);
    const result = { scanned: page.records.length, claimed: 0, advanced: 0, rescheduled: 0, idle: 0, failed: 0, leaseLost: 0, malformed: 0, nextCursor: page.nextCursor };
    let position = 0;
    const consume = async () => {
      for (;;) {
        options.signal?.throwIfAborted();
        const record = page.records[position++];
        if (record === undefined) return;
        let entry: Entry;
        try {
          entry = decode(record);
          if (record.key !== entryKey(entry.jobId) || entry.phase === "idle") throw invalid("Malformed document dispatch entry");
        } catch { result.malformed += 1; continue; }
        const token = randomUUID();
        const leased = await this.store.compareAndSwap(record.key, record.revision, {
          value: JSON.stringify({ ...entry, phase: "leased", token }), nowMs: now, expiresAt: now + this.leaseMs,
        });
        if (leased.status !== "updated") continue;
        result.claimed += 1;
        let next: number | null;
        let failures = 0;
        try {
          const disposition = await withinDeadline(async (signal) => {
            await this.runtime.advance(entry.jobId, entry.caller, signal);
            return this.runtime.status(entry.jobId, entry.caller, new Deadline(this.attemptTimeoutMs), signal);
          }, new Deadline(this.attemptTimeoutMs), options.signal, "document-dispatch-attempt");
          result.advanced += 1;
          const pending = disposition.resultCleanupPending || (disposition.upstreamRequested === true && disposition.upstreamAcknowledged !== true);
          const finishedAt = Math.max(now, this.clock());
          next = !terminal.has(disposition.job.status) || pending
            ? finishedAt + this.pollIntervalMs
            // Successful output still needs eventual expiry compensation.
            : disposition.job.status === "completed" && disposition.job.expiresAt > finishedAt
              ? disposition.job.expiresAt : null;
        } catch {
          result.failed += 1;
          failures = Math.min(30, entry.failures + 1);
          next = Math.max(now, this.clock()) + Math.min(this.maxBackoffMs, this.pollIntervalMs * 2 ** (failures - 1));
        }
        const finishedAt = Math.max(now, this.clock());
        // Retain records/revisions: deleting then recreating would allow ABA.
        const changed = await this.store.compareAndSwap(record.key, leased.record.revision, {
          value: JSON.stringify({ ...entry, phase: next === null ? "idle" : "scheduled", token: "", failures }),
          nowMs: finishedAt, expiresAt: next === null ? null : Math.max(next, finishedAt + 1),
        });
        if (changed.status !== "updated") result.leaseLost += 1;
        else if (next === null) result.idle += 1;
        else result.rescheduled += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, limit) }, consume));
    // Cursor is only fairness metadata. CAS conflict is safe: another drain
    // progressed it, and due entries remain durable until actually claimed.
    const update = { value: JSON.stringify(page.nextCursor), nowMs: Math.max(now, this.clock()) };
    if (cursorRecord === null) await this.store.createIfAbsent({ key: "dispatch-cursor", ...update });
    else await this.store.compareAndSwap(cursorRecord.key, cursorRecord.revision, update);
    return result;
  }
}
