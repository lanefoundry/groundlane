import { createHash } from "node:crypto";
import { z } from "zod";

import type { DocumentAdmissionInput, DocumentAdmissionPort, DocumentAdmissionResult } from "./document-admission.js";
import type { DurableDocumentJobCaller } from "./durable-document-jobs.js";
import type { DurableRecord, DurableRecordStorePort, NewDurableRecord } from "./durable-store.js";
import type { DurableArtifactRead } from "./durable-upload-flow.js";
import { GroundlaneError } from "./errors.js";
import { MAX_IMMUTABLE_BLOB_BYTES, type ImmutableBlobPort } from "./immutable-blob.js";

const identity = z.string().min(1).max(256);
const sourceSchema = z.object({
  refId: identity, ownerId: identity, credentialBinding: identity,
  contentHash: z.string().regex(/^sha256-[a-f0-9]{64}$/u), byteSize: z.number().int().positive().max(MAX_IMMUTABLE_BLOB_BYTES),
  blobKey: z.string().regex(/^blobs\/[a-f0-9]{64}$/u), mimeType: z.string().max(128), filename: z.string().max(512),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  status: z.enum(["active", "expired", "deleted", "physical_cleanup_pending"]),
}).passthrough();
const snapshotSchema = z.object({
  schemaVersion: z.literal("1"), jobId: identity, snapshotRefId: identity,
  source: sourceSchema, snapshotBlobKey: z.string().regex(/^blobs\/[a-f0-9]{64}$/u),
  expiresAt: z.number().int().positive(), revoked: z.boolean(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;

export interface PreparedDocumentSourceSnapshot {
  readonly source: DocumentAdmissionInput["source"];
  readonly record: NewDurableRecord;
  readonly snapshotRefId: string;
  readonly expiresAt: number;
}

function failure(): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "document-snapshot", "Document source snapshot is unavailable or changed");
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function snapshotKey(jobId: string): string { return `snapshot:${hash(identity.parse(jobId))}`; }
function callerMatches(source: z.infer<typeof sourceSchema>, caller: DurableDocumentJobCaller): boolean {
  return source.ownerId === caller.ownerId && source.credentialBinding === caller.credentialBinding;
}

/**
 * Job-owned immutable source bytes with original-source access authority.
 * A prepared intent precedes blob I/O. Atomic admission publishes the snapshot
 * alongside caller-supplied job/state/outbox records; prepare alone grants no access.
 */
export class DocumentSourceSnapshotRepository {
  constructor(
    private readonly sourceRecords: DurableRecordStorePort,
    private readonly snapshots: DurableRecordStorePort,
    private readonly blobs: ImmutableBlobPort,
    private readonly admission: DocumentAdmissionPort,
    private readonly namespaces: { readonly sources: string; readonly snapshots: string },
    private readonly clock: () => number = Date.now,
  ) {}

  async prepare(jobId: string, sourceRefId: string, caller: DurableDocumentJobCaller, effectiveExpiresAt: number, maxBytes: number, signal: AbortSignal): Promise<PreparedDocumentSourceSnapshot> {
    identity.parse(jobId); identity.parse(sourceRefId); signal.throwIfAborted();
    const sourceRecord = await this.sourceRecords.get(`upload-artifact:${sourceRefId}`);
    if (sourceRecord === null) throw failure();
    const source = sourceSchema.parse(JSON.parse(sourceRecord.value) as unknown);
    if (source.refId !== sourceRefId || !callerMatches(source, caller) || source.status !== "active" || source.expiresAt <= this.clock() ||
      !Number.isSafeInteger(effectiveExpiresAt) || effectiveExpiresAt <= this.clock() || effectiveExpiresAt > source.expiresAt ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMMUTABLE_BLOB_BYTES || source.byteSize > maxBytes) throw failure();
    const key = snapshotKey(jobId);
    const digest = hash(JSON.stringify([jobId, sourceRefId, source.contentHash, caller.ownerId, caller.credentialBinding, effectiveExpiresAt]));
    const snapshot: Snapshot = { schemaVersion: "1", jobId, source, snapshotRefId: `snap_${digest}`,
      snapshotBlobKey: `blobs/${hash(`document-job-snapshot:${digest}`)}`, expiresAt: effectiveExpiresAt, revoked: false };
    const value = JSON.stringify(snapshot);
    const now = this.clock();
    const intent = await this.snapshots.createIfAbsent({ key: `intent:${key}`, value, nowMs: now, expiresAt: now + 3_600_000 });
    if (intent.record.value !== value) throw failure();
    signal.throwIfAborted();
    const bytes = await this.blobs.get({ blobKey: source.blobKey, ownerId: source.ownerId, digest: source.contentHash, maxBytes });
    if (bytes === null || bytes.byteLength !== source.byteSize) throw failure();
    signal.throwIfAborted();
    const copied = await this.blobs.putIfAbsent({ blobKey: snapshot.snapshotBlobKey, ownerId: source.ownerId, digest: source.contentHash, bytes });
    if (copied.status === "conflict" || copied.stat.byteSize !== source.byteSize) throw failure();
    // Atomic commit performs the authoritative check again. This early check
    // merely avoids staging doomed job metadata after a slow object read.
    const latest = await this.sourceRecords.get(sourceRecord.key);
    signal.throwIfAborted();
    if (latest === null || latest.revision !== sourceRecord.revision || latest.value !== sourceRecord.value || effectiveExpiresAt <= this.clock()) throw failure();
    return { source: { namespace: this.namespaces.sources, key: sourceRecord.key, revision: sourceRecord.revision, value: sourceRecord.value },
      record: { key, value, nowMs: now, expiresAt: effectiveExpiresAt }, snapshotRefId: snapshot.snapshotRefId, expiresAt: effectiveExpiresAt };
  }

  async commit(prepared: PreparedDocumentSourceSnapshot, writes: DocumentAdmissionInput["writes"], signal: AbortSignal): Promise<DocumentAdmissionResult> {
    signal.throwIfAborted();
    const now = this.clock();
    if (prepared.expiresAt <= now) return "source_unavailable";
    return this.admission.commit({ source: prepared.source, nowMs: now,
      writes: [{ namespace: this.namespaces.snapshots, record: { ...prepared.record, nowMs: now } },
        ...writes.map((write) => ({ ...write, record: { ...write.record, nowMs: now } }))] });
  }

  async sourceStatus(jobId: string, caller: DurableDocumentJobCaller): Promise<"deleted" | "expired" | null> {
    const snapshot = await this.load(jobId, caller);
    const sourceRecord = await this.sourceRecords.get(`upload-artifact:${snapshot.source.refId}`);
    if (sourceRecord === null) return "deleted";
    const source = sourceSchema.parse(JSON.parse(sourceRecord.value) as unknown);
    if (!callerMatches(source, caller)) throw failure();
    if (source.expiresAt <= this.clock() || source.status === "expired") return "expired";
    if (source.status !== "active" || source.contentHash !== snapshot.source.contentHash || source.byteSize !== snapshot.source.byteSize) return "deleted";
    return null;
  }

  async revoke(jobId: string, caller: DurableDocumentJobCaller): Promise<{ cleanupPending: boolean }> {
    const snapshot = await this.load(jobId, caller);
    const key = snapshotKey(jobId);
    const record = await this.snapshots.get(key);
    if (record === null) throw failure();
    const changed = await this.snapshots.compareAndSwap(key, record.revision, {
      value: JSON.stringify({ ...snapshot, revoked: true }), nowMs: this.clock(), expiresAt: this.clock() + 1,
    });
    if (changed.status !== "updated") return { cleanupPending: true };
    try {
      if (await this.blobs.deleteIfOwner(snapshot.snapshotBlobKey, caller.ownerId) === "owner_mismatch") return { cleanupPending: true };
      await this.snapshots.compareAndSwap(key, changed.record.revision, { value: changed.record.value, nowMs: this.clock(), expiresAt: null });
      return { cleanupPending: false };
    } catch { return { cleanupPending: true }; }
  }

  async read(jobId: string, sourceRefId: string, caller: DurableDocumentJobCaller, maxBytes: number, signal: AbortSignal): Promise<DurableArtifactRead> {
    const snapshot = await this.load(jobId, caller);
    if (sourceRefId !== snapshot.source.refId || snapshot.revoked || snapshot.expiresAt <= this.clock() || await this.sourceStatus(jobId, caller) !== null) throw failure();
    signal.throwIfAborted();
    const bytes = await this.blobs.get({ blobKey: snapshot.snapshotBlobKey, ownerId: caller.ownerId, digest: snapshot.source.contentHash, maxBytes });
    signal.throwIfAborted();
    if (bytes === null || snapshot.expiresAt <= this.clock() || await this.sourceStatus(jobId, caller) !== null) throw failure();
    return { ref: { refId: sourceRefId, artifactKind: "source", ownershipScope: caller.ownerId,
      contentHash: snapshot.source.contentHash, byteSize: snapshot.source.byteSize, createdAt: snapshot.source.createdAt,
      expiresAt: snapshot.source.expiresAt, verified: true }, bytes, mimeType: snapshot.source.mimeType, filename: snapshot.source.filename };
  }

  /** Prepared or retained snapshot cleanup; committed rows remain access tombstones. */
  async cleanup(nowMs: number, cursor: string | null, limit: number): Promise<{ cleaned: number; pending: number; nextCursor: string | null }> {
    const page = await this.snapshots.scanExpired(nowMs, cursor, Math.min(100, limit));
    let cleaned = 0; let pending = 0;
    for (const record of page.records) {
      try {
        const snapshot = snapshotSchema.parse(JSON.parse(record.value) as unknown);
        const committed = await this.snapshots.get(snapshotKey(snapshot.jobId));
        if (record.key.startsWith("intent:") && committed !== null && snapshot.expiresAt > nowMs &&
          await this.sourceStatus(snapshot.jobId, snapshot.source) === null) {
          await this.snapshots.compareAndSwap(record.key, record.revision, { value: record.value, nowMs, expiresAt: snapshot.expiresAt });
          continue;
        }
        const removed = await this.blobs.deleteIfOwner(snapshot.snapshotBlobKey, snapshot.source.ownerId);
        if (removed === "owner_mismatch") throw failure();
        if (record.key.startsWith("intent:")) await this.snapshots.deleteIfRevision(record.key, record.revision);
        else await this.snapshots.compareAndSwap(record.key, record.revision, { value: JSON.stringify({ ...snapshot, revoked: true }), nowMs, expiresAt: null });
        cleaned++;
      } catch { pending++; }
    }
    return { cleaned, pending, nextCursor: page.nextCursor };
  }

  private async load(jobId: string, caller: DurableDocumentJobCaller): Promise<Snapshot> {
    const record: DurableRecord | null = await this.snapshots.get(snapshotKey(jobId));
    if (record === null) throw failure();
    const snapshot = snapshotSchema.parse(JSON.parse(record.value) as unknown);
    if (snapshot.jobId !== jobId || !callerMatches(snapshot.source, caller)) throw failure();
    return snapshot;
  }
}
