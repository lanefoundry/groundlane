import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  DurableArtifactRepository,
  type DurableArtifactCaller,
  type DurableArtifactMetadata,
  type DurableArtifactRecord,
} from "./durable-artifacts.js";
import { GroundlaneError } from "./errors.js";
import { MAX_IMMUTABLE_BLOB_BYTES } from "./immutable-blob.js";
import type { DurableRecordStorePort } from "./durable-store.js";

export const MAX_DOCUMENT_OUTPUT_CHUNK_BYTES = 48 * 1024;

export interface SaveDurableDocumentOutputInput {
  readonly caller: DurableArtifactCaller;
  readonly sourceBytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  readonly payload: unknown;
  readonly sourceExpiresAt?: number;
  readonly externalSourceRef?: string;
  readonly operationKey?: string;
}

const intentSchema = z.object({
  callerHash: z.string().regex(/^sha256-[a-f0-9]{64}$/u),
  fingerprint: z.string().regex(/^sha256-[a-f0-9]{64}$/u),
  sourceRefId: z.string().regex(/^art_intent_[a-f0-9]{64}_source$/u),
  outputRefId: z.string().regex(/^art_intent_[a-f0-9]{64}$/u),
  sourceHash: z.string(), outputHash: z.string(),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  revoked: z.boolean(), published: z.boolean().default(false),
}).strict();
type OutputIntent = z.infer<typeof intentSchema>;
export interface DurableDocumentOutputRecovery { readonly refId: string; readonly ready: boolean }
export interface DurableDocumentOutputIntentCleanupPage {
  readonly scanned: number;
  readonly deleted: number;
  readonly failures: readonly string[];
  readonly nextCursor: string | null;
}

export interface DurableDocumentExternalSourcePort {
  assertActive(refId: string, caller: DurableArtifactCaller, signal: AbortSignal): Promise<{
    readonly expiresAt: number;
    readonly contentHash: string;
  }>;
}

export interface DurableDocumentOutputChunk {
  readonly refId: string;
  readonly dataBase64: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly totalBytes: number;
  readonly contentHash: string;
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new GroundlaneError("CANCELLED", "document-output", "Document output operation was cancelled");
}

function unavailable(): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "document-output", "Document output is unavailable");
}

function digest(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

function callerDigest(caller: DurableArtifactCaller): string {
  return digest(Buffer.from(JSON.stringify([caller.tenantId, caller.ownerId, caller.credentialBinding])));
}

/** Self-hosted immutable source and canonical output with opaque public identity. */
export class DurableDocumentOutputRuntime {
  constructor(
    private readonly repository: DurableArtifactRepository,
    private readonly ttlSeconds = 86_400,
    private readonly clock: () => number = Date.now,
    private readonly externalSources?: DurableDocumentExternalSourcePort,
    private readonly intents?: DurableRecordStorePort,
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 2_592_000) {
      throw new GroundlaneError("INVALID_INPUT", "document-output", "Document output TTL is invalid");
    }
  }

  async save(input: SaveDurableDocumentOutputInput, signal: AbortSignal): Promise<DurableArtifactMetadata> {
    active(signal);
    const external = input.externalSourceRef === undefined ? undefined :
      await this.assertExternalSource(input.externalSourceRef, input.caller, signal);
    if (external !== undefined && external.contentHash !== digest(input.sourceBytes)) throw unavailable();
    let bytes: Uint8Array;
    try {
      const json = JSON.stringify(input.payload);
      if (json === undefined) throw new Error("Not a JSON value");
      if (Buffer.byteLength(json, "utf8") > MAX_IMMUTABLE_BLOB_BYTES) {
        throw new GroundlaneError("OUTPUT_LIMIT", "document-output", "Document output exceeds the storage limit");
      }
      bytes = Buffer.from(json, "utf8");
    } catch (error) {
      if (error instanceof GroundlaneError) throw error;
      throw new GroundlaneError("INVALID_INPUT", "document-output", "Document output must be JSON serializable");
    }
    active(signal);
    let nowMs = this.clock();
    let expiresAt = Math.min(nowMs + this.ttlSeconds * 1_000, input.sourceExpiresAt ?? Number.MAX_SAFE_INTEGER,
      external?.expiresAt ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= nowMs) {
      throw new GroundlaneError("INVALID_INPUT", "document-output", "Document output retention is invalid or expired");
    }
    if (input.sourceBytes.byteLength < 1 || input.sourceBytes.byteLength > MAX_IMMUTABLE_BLOB_BYTES) {
      throw new GroundlaneError("OUTPUT_LIMIT", "document-output", "Document source exceeds the storage limit or is empty");
    }
    const reservation = input.operationKey === undefined ? undefined : await this.reserve(input, bytes, nowMs, expiresAt);
    if (reservation !== undefined) {
      nowMs = reservation.createdAt;
      expiresAt = reservation.expiresAt;
      if (reservation.revoked || expiresAt <= this.clock()) throw unavailable();
      if (reservation.published) {
        const recovered = await this.recoverOperation(input.operationKey ?? "", input.caller, signal);
        if (recovered?.ready !== true) throw unavailable();
        const output = await this.repository.getForCaller(reservation.outputRefId, input.caller);
        if (output === null) throw unavailable();
        return output.metadata;
      }
    }
    const attempted: { refId: string; contentHash: string }[] = [];
    try {
      const sourceIdentity = { refId: reservation?.sourceRefId ?? `art_${randomUUID()}`, contentHash: digest(input.sourceBytes) };
      attempted.push(sourceIdentity);
      const source = await this.repository.put({
        ...input.caller, ...sourceIdentity, bytes: input.sourceBytes, nowMs, expiresAt,
        retentionPolicy: "document-output", deletionPolicy: "on_expiry", verification: "verified",
        details: { kind: "source", mediaType: input.mimeType, filename: input.filename },
      });
      if (source.status !== "created" && reservation === undefined) { attempted.pop(); throw new Error("Artifact identity collision"); }
      if (source.record.metadata.contentHash !== sourceIdentity.contentHash || source.record.metadata.status !== "active") throw unavailable();
      active(signal);
      const outputIdentity = { refId: reservation?.outputRefId ?? `art_${randomUUID()}`, contentHash: digest(bytes) };
      attempted.push(outputIdentity);
      const output = await this.repository.put({
        ...input.caller, ...outputIdentity, bytes, nowMs: reservation === undefined ? this.clock() : nowMs, expiresAt,
        retentionPolicy: "document-output", deletionPolicy: "on_expiry", verification: "verified",
        details: { kind: "canonical", sourceRefId: source.record.metadata.refId, documentSchemaVersion: "1",
          ...(input.externalSourceRef === undefined ? {} : { externalSourceRef: input.externalSourceRef }) },
      });
      if (output.status !== "created" && reservation === undefined) { attempted.pop(); throw new Error("Artifact identity collision"); }
      if (output.record.metadata.contentHash !== outputIdentity.contentHash || output.record.metadata.status !== "active") throw unavailable();
      if (input.externalSourceRef !== undefined) {
        await this.repository.registerExternalOutput(input.externalSourceRef, output.record.metadata.refId, input.caller, this.clock());
        await this.assertExternalSource(input.externalSourceRef, input.caller, signal);
      }
      active(signal);
      if (reservation !== undefined && (await this.readIntent(reservation.outputRefId))?.revoked !== false) throw unavailable();
      if (this.clock() >= expiresAt) throw unavailable();
      if (reservation !== undefined) await this.publishIntent(reservation.outputRefId);
      return output.record.metadata;
    } catch (error) {
      if (reservation !== undefined) {
        await this.delete(reservation.outputRefId, input.caller, new AbortController().signal).catch(() => undefined);
      }
      // Compensation is independent of caller cancellation and revokes access
      // before attempting physical cleanup. Durable pending records allow retry.
      for (const identity of attempted.reverse()) {
        try {
          const committed = await this.repository.getForCaller(identity.refId, input.caller);
          if (committed === null || committed.metadata.contentHash !== identity.contentHash ||
              committed.metadata.expiresAt !== expiresAt) continue;
          const record = await this.revoke(identity.refId, input.caller);
          if (record !== null) await this.cleanup(record, input.caller);
        } catch { /* Retention and the repository cleanup sweep remain the fallback. */ }
      }
      if (error instanceof GroundlaneError) throw error;
      throw new GroundlaneError("UPSTREAM_ERROR", "document-output", "Document output storage failed");
    }
  }

  async read(
    refId: string, caller: DurableArtifactCaller, offset: number, maxBytes: number, signal: AbortSignal,
  ): Promise<DurableDocumentOutputChunk> {
    active(signal);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 || maxBytes > MAX_DOCUMENT_OUTPUT_CHUNK_BYTES) {
      throw new GroundlaneError("INVALID_INPUT", "document-output", "Document output chunk bounds are invalid");
    }
    try {
      const record = await this.activeOutput(refId, caller, signal);
      if (offset > record.metadata.byteSize) throw unavailable();
      const bytes = await this.repository.readVerified(refId, caller, this.clock(), MAX_IMMUTABLE_BLOB_BYTES);
      active(signal);
      await this.activeOutput(refId, caller, signal);
      const end = Math.min(bytes.byteLength, offset + maxBytes);
      return {
        refId, dataBase64: Buffer.from(bytes.subarray(offset, end)).toString("base64"), offset,
        nextOffset: end < bytes.byteLength ? end : null,
        totalBytes: bytes.byteLength, contentHash: record.metadata.contentHash,
      };
    } catch (error) {
      if (error instanceof GroundlaneError && error.code === "CANCELLED") throw error;
      throw unavailable();
    }
  }

  async delete(
    refId: string, caller: DurableArtifactCaller, signal: AbortSignal,
  ): Promise<{ readonly deleted: true; readonly cleanupPending: boolean }> {
    active(signal);
    const intent = await this.readIntent(refId);
    if (intent !== null) {
      if (intent.callerHash !== callerDigest(caller)) throw unavailable();
      // Both identities are reserved before writing. A source-only crash remains
      // discoverable even when canonical metadata was never published.
      await this.revokeIntent(refId);
      let cleanupPending = false;
      for (const identity of [intent.outputRefId, intent.sourceRefId]) {
        try {
          const record = await this.revoke(identity, caller);
          if (record !== null && !await this.cleanup(record, caller)) cleanupPending = true;
        } catch { cleanupPending = true; }
      }
      return { deleted: true, cleanupPending };
    }
    let output: DurableArtifactRecord | null;
    try {
      output = await this.repository.getForCaller(refId, caller);
      active(signal);
      if (output === null) return { deleted: true, cleanupPending: false };
      if (output.metadata.details.kind !== "canonical") throw unavailable();
      output = await this.revoke(refId, caller);
      active(signal);
    } catch (error) {
      if (error instanceof GroundlaneError && error.code === "CANCELLED") throw error;
      throw unavailable();
    }
    if (output === null) return { deleted: true, cleanupPending: false };
    if (output.metadata.details.kind !== "canonical") throw unavailable();
    try {
      // Keep the canonical tombstone until its source is removed so retries
      // still have the parent identity when physical storage is unavailable.
      const source = await this.revoke(output.metadata.details.sourceRefId, caller);
      active(signal);
      if (source !== null && !await this.cleanup(source, caller)) return { deleted: true, cleanupPending: true };
      active(signal);
      const cleaned = await this.cleanup(output, caller);
      active(signal);
      return { deleted: true, cleanupPending: !cleaned };
    } catch (error) {
      if (error instanceof GroundlaneError && error.code === "CANCELLED") throw error;
      return { deleted: true, cleanupPending: true };
    }
  }

  /** Call after authoritative source revocation; repeat while cleanupPending. */
  async revokeExternalSource(refId: string, caller: DurableArtifactCaller, signal: AbortSignal): Promise<{ readonly cleanupPending: boolean }> {
    active(signal);
    for (let count = 0; count < 100; count += 1) {
      const next = await this.repository.nextRevokedExternalOutput(refId, caller, this.clock());
      if (next === null) return { cleanupPending: false };
      active(signal);
      const result = await this.delete(next.outputRefId, caller, signal);
      if (result.cleanupPending) return { cleanupPending: true };
      await this.repository.acknowledgeRevokedExternalOutput(refId, caller, next.edgeKey, this.clock());
    }
    return { cleanupPending: true };
  }

  private operationRef(operationKey: string, caller: DurableArtifactCaller): string {
    if (operationKey.length < 1 || operationKey.length > 256) throw unavailable();
    return `art_intent_${digest(Buffer.from(JSON.stringify([caller.tenantId, caller.ownerId, caller.credentialBinding, operationKey]))).slice(7)}`;
  }

  private async readIntent(refId: string): Promise<OutputIntent | null> {
    if (!/^art_intent_[a-f0-9]{64}$/u.test(refId)) return null;
    if (this.intents === undefined) throw unavailable();
    const record = await this.intents.get(`output-intent:${refId}`);
    if (record === null) return null;
    const intent = intentSchema.parse(JSON.parse(record.value) as unknown);
    if (intent.outputRefId !== refId || intent.sourceRefId !== `${refId}_source`) throw unavailable();
    return intent;
  }

  private async reserve(input: SaveDurableDocumentOutputInput, bytes: Uint8Array, nowMs: number, expiresAt: number): Promise<OutputIntent> {
    if (this.intents === undefined || input.operationKey === undefined) throw unavailable();
    const outputRefId = this.operationRef(input.operationKey, input.caller);
    const sourceHash = digest(input.sourceBytes);
    const outputHash = digest(bytes);
    const fingerprint = digest(Buffer.from(JSON.stringify([sourceHash, outputHash, input.mimeType, input.filename,
      input.externalSourceRef ?? null, input.sourceExpiresAt ?? null])));
    const value: OutputIntent = { callerHash: callerDigest(input.caller), fingerprint,
      sourceHash, outputHash, outputRefId, sourceRefId: `${outputRefId}_source`, createdAt: nowMs, expiresAt, revoked: false, published: false };
    const stored = await this.intents.createIfAbsent({
      key: `output-intent:${outputRefId}`, value: JSON.stringify(value), nowMs, expiresAt,
    });
    const intent = intentSchema.parse(JSON.parse(stored.record.value) as unknown);
    if (intent.fingerprint !== fingerprint || intent.callerHash !== value.callerHash || intent.outputRefId !== outputRefId ||
        intent.sourceRefId !== value.sourceRefId) throw unavailable();
    return intent;
  }

  private async revokeIntent(refId: string): Promise<void> {
    if (this.intents === undefined) throw unavailable();
    for (let count = 0; count < 16; count += 1) {
      const record = await this.intents.get(`output-intent:${refId}`);
      if (record === null) throw unavailable();
      const intent = intentSchema.parse(JSON.parse(record.value) as unknown);
      if (intent.revoked) return;
      const nowMs = this.clock();
      const changed = await this.intents.compareAndSwap(record.key, record.revision,
        { value: JSON.stringify({ ...intent, revoked: true }), nowMs, expiresAt: Math.max(intent.expiresAt, nowMs + 1) });
      if (changed.status === "updated") return;
    }
    throw unavailable();
  }

  private async publishIntent(refId: string): Promise<void> {
    if (this.intents === undefined) throw unavailable();
    for (let count = 0; count < 16; count += 1) {
      const record = await this.intents.get(`output-intent:${refId}`);
      if (record === null) throw unavailable();
      const intent = intentSchema.parse(JSON.parse(record.value) as unknown);
      if (intent.revoked) throw unavailable();
      if (intent.published) return;
      const nowMs = this.clock();
      const changed = await this.intents.compareAndSwap(record.key, record.revision,
        { value: JSON.stringify({ ...intent, published: true }), nowMs, expiresAt: Math.max(intent.expiresAt, nowMs + 1) });
      if (changed.status === "updated") return;
    }
    throw unavailable();
  }

  async recoverOperation(operationKey: string, caller: DurableArtifactCaller, signal: AbortSignal): Promise<DurableDocumentOutputRecovery | null> {
    active(signal);
    if (this.intents === undefined) throw unavailable();
    const refId = this.operationRef(operationKey, caller);
    const intent = await this.readIntent(refId);
    if (intent === null) return null;
    if (intent.callerHash !== callerDigest(caller)) throw unavailable();
    let ready = false;
    if (intent.published && !intent.revoked && intent.expiresAt > this.clock()) {
      try {
        const output = await this.activeOutput(refId, caller, signal);
        const source = await this.repository.getForCaller(intent.sourceRefId, caller);
        ready = output.metadata.contentHash === intent.outputHash && source?.metadata.contentHash === intent.sourceHash;
        if (ready) {
          await this.repository.readVerified(refId, caller, this.clock(), MAX_IMMUTABLE_BLOB_BYTES);
          await this.repository.readVerified(intent.sourceRefId, caller, this.clock(), MAX_IMMUTABLE_BLOB_BYTES);
          await this.activeOutput(refId, caller, signal);
        }
      } catch (error) {
        active(signal);
        if (!(error instanceof GroundlaneError && error.code === "INVALID_INPUT")) throw error;
      }
    }
    active(signal);
    return { refId, ready };
  }

  /**
   * Removes expired idempotency reservations after the artifact repository has
   * swept their source/output blobs. Retaining the tombstone until expiry
   * fences late retries; deleting it afterwards prevents unbounded D1 growth.
   */
  async sweepExpiredIntents(
    nowMs: number, cursor: string | null = null, limit = 100,
  ): Promise<DurableDocumentOutputIntentCleanupPage> {
    if (this.intents === undefined) throw unavailable();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (cursor !== null && (cursor.length === 0 || cursor.length > 240))) throw unavailable();
    const page = await this.intents.scanExpired(nowMs, cursor, limit);
    let deleted = 0;
    const failures: string[] = [];
    for (const record of page.records) {
      if (!record.key.startsWith("output-intent:")) continue;
      try {
        const intent = intentSchema.parse(JSON.parse(record.value) as unknown);
        if (record.key !== `output-intent:${intent.outputRefId}` || intent.expiresAt > nowMs) {
          failures.push(record.key);
          continue;
        }
        const result = await this.intents.deleteIfRevision(record.key, record.revision);
        if (result === "deleted" || result === "missing") deleted += 1;
        else failures.push(record.key);
      } catch { failures.push(record.key); }
    }
    return { scanned: page.records.length, deleted, failures, nextCursor: page.nextCursor };
  }

  private async assertExternalSource(refId: string, caller: DurableArtifactCaller, signal: AbortSignal): Promise<{ expiresAt: number; contentHash: string }> {
    active(signal);
    if (this.externalSources === undefined) throw unavailable();
    try {
      if (await this.repository.isExternalSourceRevoked(refId, caller)) throw unavailable();
      const source = await this.externalSources.assertActive(refId, caller, signal);
      active(signal);
      if (await this.repository.isExternalSourceRevoked(refId, caller)) throw unavailable();
      if (!Number.isSafeInteger(source.expiresAt) || source.expiresAt <= this.clock() ||
          !/^sha256-[a-f0-9]{64}$/u.test(source.contentHash)) throw unavailable();
      return source;
    } catch (error) {
      if (error instanceof GroundlaneError && error.code === "CANCELLED") throw error;
      throw unavailable();
    }
  }

  private async activeOutput(refId: string, caller: DurableArtifactCaller, signal: AbortSignal): Promise<DurableArtifactRecord> {
    active(signal);
    const intent = await this.readIntent(refId);
    if (intent?.revoked) throw unavailable();
    const output = await this.repository.getForCaller(refId, caller);
    active(signal);
    if (output === null || output.metadata.details.kind !== "canonical") throw unavailable();
    if (output.metadata.details.externalSourceRef !== undefined) {
      await this.assertExternalSource(output.metadata.details.externalSourceRef, caller, signal);
    }
    const source = await this.repository.getForCaller(output.metadata.details.sourceRefId, caller);
    active(signal);
    const nowMs = this.clock();
    for (const record of [output, source]) {
      if (record === null || record.metadata.status !== "active" || record.metadata.verification !== "verified" ||
          record.metadata.expiresAt <= nowMs) throw unavailable();
    }
    if (source?.metadata.details.kind !== "source") throw unavailable();
    return output;
  }

  private async revoke(refId: string, caller: DurableArtifactCaller): Promise<DurableArtifactRecord | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.repository.getForCaller(refId, caller);
      if (current === null || current.metadata.status !== "active") return current;
      const result = await this.repository.deleteExplicit(refId, caller, current.revision, this.clock());
      if (result.status === "missing") return null;
      if (result.status === "updated") return result.record;
    }
    throw new Error("Artifact revocation conflicted");
  }

  private async cleanup(record: DurableArtifactRecord, caller: DurableArtifactCaller): Promise<boolean> {
    let pending = record;
    if (pending.metadata.status !== "physical_cleanup_pending") {
      const result = await this.repository.markCleanupPending(pending.metadata.refId, caller, pending.revision, this.clock());
      if (result.status === "missing") return true;
      if (result.status !== "updated") return false;
      pending = result.record;
    }
    const result = await this.repository.cleanupPending(pending.metadata.refId, caller, pending.revision);
    return result === "deleted" || result === "missing";
  }
}
