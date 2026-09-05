import { createHash } from "node:crypto";

import type {
  DurableCreateResult,
  DurableRecord,
  DurableRecordStorePort,
} from "./durable-store.js";
import type { ImmutableBlobPort } from "./immutable-blob.js";

export type DurableArtifactKind = "source" | "canonical" | "projection";
export type DurableArtifactStatus =
  | "active"
  | "logically_expired"
  | "logically_deleted"
  | "physical_cleanup_pending";
export type DurableArtifactVerification = "pending" | "verified";

export interface SourceArtifactDetails {
  readonly kind: "source";
  readonly mediaType: string;
  readonly filename: string;
}

export interface CanonicalArtifactDetails {
  readonly kind: "canonical";
  readonly sourceRefId: string;
  readonly documentSchemaVersion: string;
}

export interface ProjectionArtifactDetails {
  readonly kind: "projection";
  readonly canonicalRefId: string;
  readonly format: "markdown" | "structured" | "text";
}

export type DurableArtifactDetails =
  | SourceArtifactDetails
  | CanonicalArtifactDetails
  | ProjectionArtifactDetails;

export interface DurableArtifactMetadata {
  readonly schemaVersion: "1";
  readonly refId: string;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly expiresAt: number;
  readonly blobKey: string;
  readonly verification: DurableArtifactVerification;
  readonly status: DurableArtifactStatus;
  readonly cleanupReason: "expired" | "explicit_delete" | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly details: DurableArtifactDetails;
}

export interface DurableArtifactRecord {
  readonly metadata: DurableArtifactMetadata;
  readonly revision: number;
}

export interface PutDurableArtifactInput {
  readonly refId: string;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly expiresAt: number;
  readonly bytes: Uint8Array;
  readonly verification: DurableArtifactVerification;
  readonly details: DurableArtifactDetails;
  readonly nowMs: number;
}

export type PutDurableArtifactResult =
  | { readonly status: "created"; readonly record: DurableArtifactRecord }
  | { readonly status: "exists"; readonly record: DurableArtifactRecord };

export type DurableArtifactTransitionResult =
  | { readonly status: "updated"; readonly record: DurableArtifactRecord }
  | { readonly status: "conflict"; readonly record: DurableArtifactRecord }
  | { readonly status: "missing" };

export interface DurableArtifactExpiryPage {
  readonly expired: readonly DurableArtifactRecord[];
  readonly conflicts: readonly string[];
  readonly nextCursor: string | null;
}

export type DurableArtifactCleanupResult =
  | "deleted"
  | "missing"
  | "conflict"
  | "owner_mismatch";

const REF_ID_RE = /^[A-Za-z0-9._-]+$/u;
const HASH_RE = /^sha256-[a-f0-9]{64}$/u;
const MAX_REF_ID_CHARS = 180;
const MAX_OWNER_ID_CHARS = 160;
const MAX_DESCRIPTOR_CHARS = 512;

function metadataKey(refId: string): string {
  assertRefId(refId);
  return `artifact:${refId}`;
}

function blobKey(ownerId: string, refId: string, contentHash: string): string {
  return `blobs/${createHash("sha256").update(`${ownerId}\u0000${refId}\u0000${contentHash}`).digest("hex")}`;
}

function digest(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertRefId(value: string): void {
  if (!value || value.length > MAX_REF_ID_CHARS || !REF_ID_RE.test(value)) {
    throw new Error("durable artifact refId is invalid");
  }
}

function assertOwnerId(value: string): void {
  if (!value || value.length > MAX_OWNER_ID_CHARS || value.trim() !== value) {
    throw new Error("durable artifact owner is invalid");
  }
}

function assertDescriptor(value: string, label: string): void {
  if (!value || value.length > MAX_DESCRIPTOR_CHARS || value.trim() !== value) {
    throw new Error(`durable artifact ${label} is invalid`);
  }
}

function validateDetails(details: DurableArtifactDetails): void {
  switch (details.kind) {
    case "source":
      assertDescriptor(details.mediaType, "media type");
      assertDescriptor(details.filename, "filename");
      return;
    case "canonical":
      assertRefId(details.sourceRefId);
      assertDescriptor(details.documentSchemaVersion, "document schema version");
      return;
    case "projection":
      assertRefId(details.canonicalRefId);
      if (!["markdown", "structured", "text"].includes(details.format)) {
        throw new Error("durable artifact projection format is invalid");
      }
      return;
  }
}

function validateMetadata(metadata: DurableArtifactMetadata): void {
  if (metadata.schemaVersion !== "1") throw new Error("durable artifact metadata is malformed");
  assertRefId(metadata.refId);
  assertOwnerId(metadata.ownerId);
  if (!HASH_RE.test(metadata.contentHash)) throw new Error("durable artifact content hash is invalid");
  if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1) {
    throw new Error("durable artifact size is invalid");
  }
  if (!Number.isSafeInteger(metadata.expiresAt) || metadata.expiresAt <= metadata.createdAt) {
    throw new Error("durable artifact expiry is invalid");
  }
  if (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0 ||
      !Number.isSafeInteger(metadata.updatedAt) || metadata.updatedAt < metadata.createdAt) {
    throw new Error("durable artifact timestamp is invalid");
  }
  if (!/^blobs\/[a-f0-9]{64}$/u.test(metadata.blobKey)) {
    throw new Error("durable artifact blob key is invalid");
  }
  if (!["pending", "verified"].includes(metadata.verification) ||
      !["active", "logically_expired", "logically_deleted", "physical_cleanup_pending"].includes(metadata.status)) {
    throw new Error("durable artifact metadata is malformed");
  }
  if (!(metadata.cleanupReason === null || metadata.cleanupReason === "expired" || metadata.cleanupReason === "explicit_delete")) {
    throw new Error("durable artifact cleanup reason is invalid");
  }
  if (metadata.status === "active" && metadata.cleanupReason !== null) {
    throw new Error("active durable artifact cannot have a cleanup reason");
  }
  validateDetails(metadata.details);
}

function decode(record: DurableRecord): DurableArtifactRecord {
  let value: unknown;
  try {
    value = JSON.parse(record.value) as unknown;
  } catch {
    throw new Error("durable artifact metadata is malformed");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("durable artifact metadata is malformed");
  }
  const metadata = value as DurableArtifactMetadata;
  validateMetadata(metadata);
  if (metadataKey(metadata.refId) !== record.key || metadata.createdAt !== record.createdAt) {
    throw new Error("durable artifact metadata binding is malformed");
  }
  return { metadata, revision: record.revision };
}

function encode(metadata: DurableArtifactMetadata): string {
  validateMetadata(metadata);
  return JSON.stringify(metadata);
}

function sameArtifact(left: DurableArtifactMetadata, right: DurableArtifactMetadata): boolean {
  return left.refId === right.refId && left.ownerId === right.ownerId &&
    left.contentHash === right.contentHash && left.byteSize === right.byteSize &&
    left.expiresAt === right.expiresAt && left.blobKey === right.blobKey &&
    left.verification === right.verification &&
    JSON.stringify(left.details) === JSON.stringify(right.details);
}

/**
 * Durable metadata lifecycle over a revision-fenced record store and immutable
 * blob store. This repository consumes already supplied bytes; it does not
 * create upload intents, public object keys, or presigned upload URLs.
 */
export class DurableArtifactRepository {
  constructor(
    private readonly records: DurableRecordStorePort,
    private readonly blobs: ImmutableBlobPort,
  ) {}

  async get(refId: string): Promise<DurableArtifactRecord | null> {
    const record = await this.records.get(metadataKey(refId));
    return record === null ? null : decode(record);
  }

  async put(input: PutDurableArtifactInput): Promise<PutDurableArtifactResult> {
    assertRefId(input.refId);
    assertOwnerId(input.ownerId);
    validateDetails(input.details);
    if (!HASH_RE.test(input.contentHash) || digest(input.bytes) !== input.contentHash) {
      throw new Error("durable artifact content hash does not match bytes");
    }
    if (input.bytes.byteLength < 1) throw new Error("durable artifact bytes are empty");
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.nowMs) {
      throw new Error("durable artifact expiry is invalid");
    }
    const key = blobKey(input.ownerId, input.refId, input.contentHash);
    const metadata: DurableArtifactMetadata = {
      schemaVersion: "1",
      refId: input.refId,
      ownerId: input.ownerId,
      contentHash: input.contentHash,
      byteSize: input.bytes.byteLength,
      expiresAt: input.expiresAt,
      blobKey: key,
      verification: input.verification,
      status: "active",
      cleanupReason: null,
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
      details: input.details,
    };
    const blobResult = await this.blobs.putIfAbsent({
      blobKey: key,
      ownerId: input.ownerId,
      digest: input.contentHash,
      bytes: input.bytes,
    });
    if (blobResult.status === "conflict") {
      throw new Error("durable artifact blob identity conflict");
    }
    let created: DurableCreateResult;
    try {
      created = await this.records.createIfAbsent({
        key: metadataKey(input.refId),
        value: encode(metadata),
        nowMs: input.nowMs,
        expiresAt: input.expiresAt,
      });
    } catch (error) {
      if (blobResult.status === "created") {
        await this.blobs.deleteIfOwner(key, input.ownerId);
      }
      throw error;
    }
    const result = decode(created.record);
    if (!sameArtifact(result.metadata, metadata)) {
      if (blobResult.status === "created") {
        await this.blobs.deleteIfOwner(key, input.ownerId);
      }
      throw new Error("durable artifact refId already has different metadata");
    }
    return created.status === "created"
      ? { status: "created", record: result }
      : { status: "exists", record: result };
  }

  async markVerified(
    refId: string,
    ownerId: string,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DurableArtifactTransitionResult> {
    const current = await this.get(refId);
    if (current === null) return { status: "missing" };
    this.assertOwner(current.metadata, ownerId);
    if (current.metadata.status !== "active") throw new Error("revoked durable artifact cannot be verified");
    const stat = await this.blobs.stat(current.metadata.blobKey);
    if (stat === null || stat.ownerId !== ownerId || stat.digest !== current.metadata.contentHash ||
        stat.byteSize !== current.metadata.byteSize) {
      throw new Error("durable artifact blob verification failed");
    }
    return this.cas(current, expectedRevision, {
      ...current.metadata,
      verification: "verified",
      updatedAt: nowMs,
    }, current.metadata.expiresAt);
  }

  async readVerified(
    refId: string,
    ownerId: string,
    nowMs: number,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const current = await this.get(refId);
    if (current === null) throw new Error("durable artifact is unavailable");
    this.assertOwner(current.metadata, ownerId);
    if (nowMs >= current.metadata.expiresAt) {
      if (current.metadata.status === "active") {
        await this.cas(current, current.revision, {
          ...current.metadata,
          status: "logically_expired",
          cleanupReason: "expired",
          updatedAt: nowMs,
        }, null);
      }
      throw new Error("durable artifact has expired");
    }
    if (current.metadata.status !== "active") throw new Error("durable artifact access is revoked");
    if (current.metadata.verification !== "verified") throw new Error("durable artifact is not verified");
    const bytes = await this.blobs.get({
      blobKey: current.metadata.blobKey,
      ownerId,
      digest: current.metadata.contentHash,
      maxBytes,
    });
    if (bytes === null) throw new Error("durable artifact blob is unavailable");
    return bytes;
  }

  async deleteExplicit(
    refId: string,
    ownerId: string,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DurableArtifactTransitionResult> {
    const current = await this.get(refId);
    if (current === null) return { status: "missing" };
    this.assertOwner(current.metadata, ownerId);
    if (current.metadata.status !== "active") throw new Error("durable artifact is already revoked");
    return this.cas(current, expectedRevision, {
      ...current.metadata,
      status: "logically_deleted",
      cleanupReason: "explicit_delete",
      updatedAt: nowMs,
    }, null);
  }

  async expireDue(nowMs: number, cursor: string | null, limit: number): Promise<DurableArtifactExpiryPage> {
    const page = await this.records.scanExpired(nowMs, cursor, limit);
    const expired: DurableArtifactRecord[] = [];
    const conflicts: string[] = [];
    for (const raw of page.records) {
      const current = decode(raw);
      if (current.metadata.status !== "active") continue;
      const result = await this.cas(current, current.revision, {
        ...current.metadata,
        status: "logically_expired",
        cleanupReason: "expired",
        updatedAt: nowMs,
      }, null);
      if (result.status === "updated") expired.push(result.record);
      if (result.status === "conflict") conflicts.push(current.metadata.refId);
    }
    return { expired, conflicts, nextCursor: page.nextCursor };
  }

  async markCleanupPending(
    refId: string,
    ownerId: string,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DurableArtifactTransitionResult> {
    const current = await this.get(refId);
    if (current === null) return { status: "missing" };
    this.assertOwner(current.metadata, ownerId);
    if (current.metadata.status !== "logically_expired" && current.metadata.status !== "logically_deleted") {
      throw new Error("durable artifact is not logically revoked");
    }
    return this.cas(current, expectedRevision, {
      ...current.metadata,
      status: "physical_cleanup_pending",
      updatedAt: nowMs,
    }, null);
  }

  async cleanupPending(
    refId: string,
    ownerId: string,
    expectedRevision: number,
  ): Promise<DurableArtifactCleanupResult> {
    const current = await this.get(refId);
    if (current === null) return "missing";
    this.assertOwner(current.metadata, ownerId);
    if (current.metadata.status !== "physical_cleanup_pending") {
      throw new Error("durable artifact cleanup is not pending");
    }
    if (current.revision !== expectedRevision) return "conflict";
    const blobDeleted = await this.blobs.deleteIfOwner(current.metadata.blobKey, ownerId);
    if (blobDeleted === "owner_mismatch") return "owner_mismatch";
    return this.records.deleteIfRevision(metadataKey(refId), expectedRevision);
  }

  async deleteOwnerArtifacts(
    ownerId: string,
    refIds: readonly string[],
    nowMs: number,
  ): Promise<{ readonly revoked: readonly string[]; readonly skipped: readonly string[] }> {
    assertOwnerId(ownerId);
    const revoked: string[] = [];
    const skipped: string[] = [];
    for (const refId of [...new Set(refIds)]) {
      const current = await this.get(refId);
      if (current === null || current.metadata.ownerId !== ownerId || current.metadata.status !== "active") {
        skipped.push(refId);
        continue;
      }
      const result = await this.deleteExplicit(refId, ownerId, current.revision, nowMs);
      if (result.status === "updated") revoked.push(refId);
      else skipped.push(refId);
    }
    return { revoked, skipped };
  }

  private assertOwner(metadata: DurableArtifactMetadata, ownerId: string): void {
    assertOwnerId(ownerId);
    if (metadata.ownerId !== ownerId) throw new Error("durable artifact is unavailable");
  }

  private async cas(
    current: DurableArtifactRecord,
    expectedRevision: number,
    metadata: DurableArtifactMetadata,
    expiresAt: number | null,
  ): Promise<DurableArtifactTransitionResult> {
    if (current.revision !== expectedRevision) return { status: "conflict", record: current };
    const result = await this.records.compareAndSwap(metadataKey(metadata.refId), expectedRevision, {
      value: encode(metadata),
      nowMs: metadata.updatedAt,
      expiresAt,
    });
    if (result.status === "missing") return { status: "missing" };
    if (result.status === "conflict") return { status: "conflict", record: decode(result.record) };
    return { status: "updated", record: decode(result.record) };
  }
}
