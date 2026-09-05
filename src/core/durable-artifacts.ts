import { createHash, randomUUID } from "node:crypto";

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
export type DurableArtifactDeletionPolicy = "on_expiry" | "on_owner_delete" | "manual";

export interface DurableArtifactCaller {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
}

export interface SourceArtifactDetails {
  readonly kind: "source";
  readonly mediaType: string;
  readonly filename: string;
}

export interface CanonicalArtifactDetails {
  readonly kind: "canonical";
  readonly sourceRefId: string;
  readonly documentSchemaVersion: string;
  readonly externalSourceRef?: string;
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
  readonly tenantId: string;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly retentionPolicy: string;
  readonly deletionPolicy: DurableArtifactDeletionPolicy;
  readonly expiresAt: number;
  readonly verification: DurableArtifactVerification;
  readonly status: DurableArtifactStatus;
  readonly cleanupReason: "expired" | "explicit_delete" | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly details: DurableArtifactDetails;
}

interface StoredDurableArtifactMetadata extends DurableArtifactMetadata {
  readonly credentialBindingHash: string;
  readonly blobKey: string;
}

export interface DurableArtifactRecord {
  readonly metadata: DurableArtifactMetadata;
  readonly revision: number;
}

export interface PutDurableArtifactInput {
  readonly refId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly contentHash: string;
  readonly expiresAt: number;
  readonly retentionPolicy: string;
  readonly deletionPolicy: DurableArtifactDeletionPolicy;
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
const MAX_TENANT_ID_CHARS = 160;
const MAX_CREDENTIAL_BINDING_CHARS = 512;
const MAX_DESCRIPTOR_CHARS = 512;

function edgePointer(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^output-edge:[0-9a-f-]{36}$/u.test(value));
}

function decodeOutputSourceHead(value: string): { revoked: boolean; head: string | null } {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || !("revoked" in parsed) ||
      typeof parsed.revoked !== "boolean" || !("head" in parsed) || !edgePointer(parsed.head)) {
    throw new Error("Invalid external source index");
  }
  return { revoked: parsed.revoked, head: parsed.head };
}

function decodeOutputSourceEdge(value: string): { outputRefId: string; next: string | null } {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || !("outputRefId" in parsed) ||
      typeof parsed.outputRefId !== "string" || !("next" in parsed) || !edgePointer(parsed.next)) {
    throw new Error("Invalid external source edge");
  }
  assertRefId(parsed.outputRefId);
  return { outputRefId: parsed.outputRefId, next: parsed.next };
}

function metadataKey(refId: string): string {
  assertRefId(refId);
  return `artifact:${refId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function credentialBindingHash(credentialBinding: string): string {
  return sha256(credentialBinding);
}

function blobKey(caller: DurableArtifactCaller, refId: string, contentHash: string): string {
  return `blobs/${sha256(`${caller.tenantId}\u0000${caller.ownerId}\u0000${credentialBindingHash(caller.credentialBinding)}\u0000${refId}\u0000${contentHash}`)}`;
}

function blobOwnerId(metadata: StoredDurableArtifactMetadata): string {
  return `artifact-owner-${sha256(`${metadata.tenantId}\u0000${metadata.ownerId}\u0000${metadata.credentialBindingHash}`)}`;
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

function assertTenantId(value: string): void {
  if (!value || value.length > MAX_TENANT_ID_CHARS || value.trim() !== value) {
    throw new Error("durable artifact tenant is invalid");
  }
}

function assertCredentialBinding(value: string): void {
  if (!value || value.length > MAX_CREDENTIAL_BINDING_CHARS || value.trim() !== value) {
    throw new Error("durable artifact credential binding is invalid");
  }
}

function assertCaller(caller: DurableArtifactCaller): void {
  assertTenantId(caller.tenantId);
  assertOwnerId(caller.ownerId);
  assertCredentialBinding(caller.credentialBinding);
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
      if (details.externalSourceRef !== undefined) assertRefId(details.externalSourceRef);
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

function validateMetadata(metadata: StoredDurableArtifactMetadata): void {
  if (metadata.schemaVersion !== "1") throw new Error("durable artifact metadata is malformed");
  assertRefId(metadata.refId);
  assertTenantId(metadata.tenantId);
  assertOwnerId(metadata.ownerId);
  if (!/^[a-f0-9]{64}$/u.test(metadata.credentialBindingHash)) {
    throw new Error("durable artifact credential binding is invalid");
  }
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
  assertDescriptor(metadata.retentionPolicy, "retention policy");
  if (!["on_expiry", "on_owner_delete", "manual"].includes(metadata.deletionPolicy)) {
    throw new Error("durable artifact deletion policy is invalid");
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

interface StoredDurableArtifactRecord {
  readonly metadata: StoredDurableArtifactMetadata;
  readonly revision: number;
}

function publicMetadata(metadata: StoredDurableArtifactMetadata): DurableArtifactMetadata {
  const { credentialBindingHash: _credentialBindingHash, blobKey: _blobKey, ...view } = metadata;
  void _credentialBindingHash;
  void _blobKey;
  return view;
}

function publicRecord(record: StoredDurableArtifactRecord): DurableArtifactRecord {
  return { metadata: publicMetadata(record.metadata), revision: record.revision };
}

function decode(record: DurableRecord): StoredDurableArtifactRecord {
  let value: unknown;
  try {
    value = JSON.parse(record.value) as unknown;
  } catch {
    throw new Error("durable artifact metadata is malformed");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("durable artifact metadata is malformed");
  }
  const metadata = value as StoredDurableArtifactMetadata;
  validateMetadata(metadata);
  if (metadataKey(metadata.refId) !== record.key || metadata.createdAt !== record.createdAt) {
    throw new Error("durable artifact metadata binding is malformed");
  }
  return { metadata, revision: record.revision };
}

function encode(metadata: StoredDurableArtifactMetadata): string {
  validateMetadata(metadata);
  return JSON.stringify(metadata);
}

function sameArtifact(left: StoredDurableArtifactMetadata, right: StoredDurableArtifactMetadata): boolean {
  return left.refId === right.refId && left.tenantId === right.tenantId && left.ownerId === right.ownerId &&
    left.credentialBindingHash === right.credentialBindingHash &&
    left.contentHash === right.contentHash && left.byteSize === right.byteSize &&
    left.expiresAt === right.expiresAt && left.blobKey === right.blobKey &&
    left.retentionPolicy === right.retentionPolicy && left.deletionPolicy === right.deletionPolicy &&
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

  private externalSourceKey(refId: string, caller: DurableArtifactCaller): string {
    assertRefId(refId);
    assertTenantId(caller.tenantId);
    assertOwnerId(caller.ownerId);
    return `output-source:${sha256(JSON.stringify([caller.tenantId, caller.ownerId, credentialBindingHash(caller.credentialBinding), refId]))}`;
  }

  async isExternalSourceRevoked(refId: string, caller: DurableArtifactCaller): Promise<boolean> {
    const current = await this.records.get(this.externalSourceKey(refId, caller));
    return current !== null && decodeOutputSourceHead(current.value).revoked;
  }

  /** One edge per derived artifact; no unbounded metadata arrays. */
  async registerExternalOutput(refId: string, outputRefId: string, caller: DurableArtifactCaller, nowMs: number): Promise<void> {
    assertRefId(outputRefId);
    const key = this.externalSourceKey(refId, caller);
    await this.records.createIfAbsent({ key, value: JSON.stringify({ revoked: false, head: null }), nowMs });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = await this.records.get(key);
      if (current === null) throw new Error("External source index missing");
      const state = decodeOutputSourceHead(current.value);
      if (state.revoked) throw new Error("External source revoked");
      const edgeKey = `output-edge:${randomUUID()}`;
      await this.records.createIfAbsent({ key: edgeKey, value: JSON.stringify({ outputRefId, next: state.head }), nowMs });
      const result = await this.records.compareAndSwap(key, current.revision, {
        value: JSON.stringify({ revoked: false, head: edgeKey }), nowMs,
      });
      if (result.status === "updated") return;
      await this.records.deleteIfRevision(edgeKey, 1);
    }
    throw new Error("External source registration conflicted");
  }

  /** Durable tombstone fences registrations and preserves the cleanup cursor. */
  async nextRevokedExternalOutput(refId: string, caller: DurableArtifactCaller, nowMs: number): Promise<{ edgeKey: string; outputRefId: string } | null> {
    const key = this.externalSourceKey(refId, caller);
    await this.records.createIfAbsent({ key, value: JSON.stringify({ revoked: true, head: null }), nowMs });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = await this.records.get(key);
      if (current === null) throw new Error("External source index missing");
      const state = decodeOutputSourceHead(current.value);
      if (!state.revoked) {
        const result = await this.records.compareAndSwap(key, current.revision, { value: JSON.stringify({ ...state, revoked: true }), nowMs });
        if (result.status !== "updated") continue;
      }
      if (state.head === null) return null;
      const edge = await this.records.get(state.head);
      if (edge === null) throw new Error("External source edge missing");
      return { edgeKey: state.head, outputRefId: decodeOutputSourceEdge(edge.value).outputRefId };
    }
    throw new Error("External source revocation conflicted");
  }

  async acknowledgeRevokedExternalOutput(refId: string, caller: DurableArtifactCaller, edgeKey: string, nowMs: number): Promise<void> {
    const key = this.externalSourceKey(refId, caller);
    const current = await this.records.get(key);
    if (current === null) throw new Error("External source index missing");
    const state = decodeOutputSourceHead(current.value);
    if (!state.revoked || state.head !== edgeKey) return;
    const edge = await this.records.get(edgeKey);
    if (edge === null) throw new Error("External source edge missing");
    const result = await this.records.compareAndSwap(key, current.revision, {
      value: JSON.stringify({ revoked: true, head: decodeOutputSourceEdge(edge.value).next }), nowMs,
    });
    if (result.status === "updated") await this.records.deleteIfRevision(edgeKey, edge.revision);
  }

  async get(refId: string): Promise<DurableArtifactRecord | null> {
    const record = await this.getStored(refId);
    return record === null ? null : publicRecord(record);
  }

  private async getStored(refId: string): Promise<StoredDurableArtifactRecord | null> {
    const record = await this.records.get(metadataKey(refId));
    return record === null ? null : decode(record);
  }

  async getForCaller(refId: string, caller: DurableArtifactCaller): Promise<DurableArtifactRecord | null> {
    const record = await this.getStored(refId);
    if (record === null) return null;
    this.assertOwner(record.metadata, caller);
    return publicRecord(record);
  }

  async put(input: PutDurableArtifactInput): Promise<PutDurableArtifactResult> {
    assertRefId(input.refId);
    assertCaller(input);
    validateDetails(input.details);
    if (!HASH_RE.test(input.contentHash) || digest(input.bytes) !== input.contentHash) {
      throw new Error("durable artifact content hash does not match bytes");
    }
    if (input.bytes.byteLength < 1) throw new Error("durable artifact bytes are empty");
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.nowMs) {
      throw new Error("durable artifact expiry is invalid");
    }
    const key = blobKey(input, input.refId, input.contentHash);
    const metadata: StoredDurableArtifactMetadata = {
      schemaVersion: "1",
      refId: input.refId,
      ownerId: input.ownerId,
      tenantId: input.tenantId,
      credentialBindingHash: credentialBindingHash(input.credentialBinding),
      retentionPolicy: input.retentionPolicy,
      deletionPolicy: input.deletionPolicy,
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
      ownerId: blobOwnerId(metadata),
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
        // A failed acknowledgement may follow a committed write. Delete only
        // after a read proves this blob is not referenced by the durable record.
        try {
          const committed = await this.getStored(input.refId);
          if (committed === null || committed.metadata.blobKey !== key) {
            await this.blobs.deleteIfOwner(key, blobOwnerId(metadata));
          }
        } catch {
          // Unknown commit state: retain bytes for reconciliation, never destroy them.
        }
      }
      throw error;
    }
    const result = decode(created.record);
    if (!sameArtifact(result.metadata, metadata)) {
      if (blobResult.status === "created") {
        await this.blobs.deleteIfOwner(key, blobOwnerId(metadata));
      }
      throw new Error("durable artifact refId already has different metadata");
    }
    return created.status === "created"
      ? { status: "created", record: publicRecord(result) }
      : { status: "exists", record: publicRecord(result) };
  }

  async markVerified(
    refId: string,
    caller: DurableArtifactCaller,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DurableArtifactTransitionResult> {
    const current = await this.getStored(refId);
    if (current === null) return { status: "missing" };
    this.assertOwner(current.metadata, caller);
    if (current.metadata.status !== "active") throw new Error("revoked durable artifact cannot be verified");
    const stat = await this.blobs.stat(current.metadata.blobKey);
    if (stat === null || stat.ownerId !== blobOwnerId(current.metadata) || stat.digest !== current.metadata.contentHash ||
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
    caller: DurableArtifactCaller,
    nowMs: number,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const current = await this.getStored(refId);
    if (current === null) throw new Error("durable artifact is unavailable");
    this.assertOwner(current.metadata, caller);
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
      ownerId: blobOwnerId(current.metadata),
      digest: current.metadata.contentHash,
      maxBytes,
    });
    if (bytes === null) throw new Error("durable artifact blob is unavailable");
    // Blob I/O can outlive a concurrent owner revocation or physical cleanup.
    // Recheck the authoritative durable revision before returning any bytes.
    const latest = await this.getStored(refId);
    if (latest === null) throw new Error("durable artifact is unavailable");
    this.assertOwner(latest.metadata, caller);
    if (latest.revision !== current.revision || latest.metadata.status !== "active" || latest.metadata.verification !== "verified") {
      throw new Error("durable artifact access is revoked or changed");
    }
    if (bytes.byteLength !== latest.metadata.byteSize || bytes.byteLength > maxBytes || digest(bytes) !== latest.metadata.contentHash) {
      throw new Error("durable artifact blob integrity check failed");
    }
    return bytes;
  }

  async deleteExplicit(
    refId: string,
    caller: DurableArtifactCaller,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DurableArtifactTransitionResult> {
    const current = await this.getStored(refId);
    if (current === null) return { status: "missing" };
    this.assertOwner(current.metadata, caller);
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
    caller: DurableArtifactCaller,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DurableArtifactTransitionResult> {
    const current = await this.getStored(refId);
    if (current === null) return { status: "missing" };
    this.assertOwner(current.metadata, caller);
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
    caller: DurableArtifactCaller,
    expectedRevision: number,
  ): Promise<DurableArtifactCleanupResult> {
    const current = await this.getStored(refId);
    if (current === null) return "missing";
    this.assertOwner(current.metadata, caller);
    if (current.metadata.status !== "physical_cleanup_pending") {
      throw new Error("durable artifact cleanup is not pending");
    }
    if (current.revision !== expectedRevision) return "conflict";
    const blobDeleted = await this.blobs.deleteIfOwner(current.metadata.blobKey, blobOwnerId(current.metadata));
    if (blobDeleted === "owner_mismatch") return "owner_mismatch";
    return this.records.deleteIfRevision(metadataKey(refId), expectedRevision);
  }

  async deleteOwnerArtifacts(
    caller: DurableArtifactCaller,
    refIds: readonly string[],
    nowMs: number,
  ): Promise<{ readonly revoked: readonly string[]; readonly skipped: readonly string[] }> {
    assertCaller(caller);
    const revoked: string[] = [];
    const skipped: string[] = [];
    for (const refId of [...new Set(refIds)]) {
      const current = await this.getStored(refId);
      if (current === null || current.metadata.ownerId !== caller.ownerId || current.metadata.tenantId !== caller.tenantId || current.metadata.credentialBindingHash !== credentialBindingHash(caller.credentialBinding) || current.metadata.status !== "active") {
        skipped.push(refId);
        continue;
      }
      const result = await this.deleteExplicit(refId, caller, current.revision, nowMs);
      if (result.status === "updated") revoked.push(refId);
      else skipped.push(refId);
    }
    return { revoked, skipped };
  }

  private assertOwner(metadata: StoredDurableArtifactMetadata, caller: DurableArtifactCaller): void {
    assertCaller(caller);
    if (metadata.ownerId !== caller.ownerId || metadata.tenantId !== caller.tenantId ||
        metadata.credentialBindingHash !== credentialBindingHash(caller.credentialBinding)) {
      throw new Error("durable artifact is unavailable");
    }
  }

  private async cas(
    current: StoredDurableArtifactRecord,
    expectedRevision: number,
    metadata: StoredDurableArtifactMetadata,
    expiresAt: number | null,
  ): Promise<DurableArtifactTransitionResult> {
    if (current.revision !== expectedRevision) return { status: "conflict", record: publicRecord(current) };
    const result = await this.records.compareAndSwap(metadataKey(metadata.refId), expectedRevision, {
      value: encode(metadata),
      nowMs: metadata.updatedAt,
      // Revoked records stay discoverable for bounded, retryable physical cleanup.
      expiresAt: metadata.status === "active" ? expiresAt : metadata.updatedAt + 1,
    });
    if (result.status === "missing") return { status: "missing" };
    if (result.status === "conflict") return { status: "conflict", record: publicRecord(decode(result.record)) };
    return { status: "updated", record: publicRecord(decode(result.record)) };
  }

  /** Internal maintenance only; never exposed as a caller-controlled operation. */
  async sweepExpired(nowMs: number, cursor: string | null = null, limit = 100): Promise<{
    deleted: number; nextCursor: string | null;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid cleanup limit");
    const page = await this.records.scanExpired(nowMs, cursor, limit);
    let deleted = 0;
    for (const raw of page.records) {
      try {
        let current = decode(raw);
        if (current.metadata.status === "active" && current.metadata.expiresAt > nowMs) continue;
        if (current.metadata.details.kind === "canonical") {
          const source = await this.getStored(current.metadata.details.sourceRefId);
          if (source !== null) {
            if (source.metadata.tenantId !== current.metadata.tenantId ||
                source.metadata.ownerId !== current.metadata.ownerId ||
                source.metadata.credentialBindingHash !== current.metadata.credentialBindingHash) continue;
            // Preserve the parent link until source cleanup succeeds. A caller
            // may have cancelled immediately after revoking the canonical ref.
            if (source.metadata.status === "active" && current.metadata.cleanupReason === "explicit_delete") {
              await this.cas(source, source.revision, {
                ...source.metadata, status: "logically_deleted", cleanupReason: "explicit_delete", updatedAt: nowMs,
              }, null);
            }
            continue;
          }
        }
        if (current.metadata.status !== "physical_cleanup_pending") {
          const result = await this.cas(current, current.revision, {
            ...current.metadata,
            status: "physical_cleanup_pending",
            cleanupReason: current.metadata.cleanupReason ?? "expired",
            updatedAt: nowMs,
          }, nowMs);
          if (result.status !== "updated") continue;
          const refreshed = await this.getStored(current.metadata.refId);
          if (refreshed === null || refreshed.revision !== result.record.revision) continue;
          current = refreshed;
        }
        const status = await this.blobs.deleteIfOwner(current.metadata.blobKey, blobOwnerId(current.metadata));
        if (status === "owner_mismatch") continue;
        if (await this.records.deleteIfRevision(raw.key, current.revision) === "deleted") deleted++;
      } catch {
        // Retain due metadata so transient storage failures can be retried.
      }
    }
    return { deleted, nextCursor: page.nextCursor };
  }
}
