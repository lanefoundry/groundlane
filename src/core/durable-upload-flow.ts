import { createHash } from "node:crypto";

import type { DurableRecord, DurableRecordStorePort } from "./durable-store.js";
import { GroundlaneError } from "./errors.js";
import {
  MAX_IMMUTABLE_BLOB_BYTES,
  type ImmutableBlobPort,
} from "./immutable-blob.js";
import {
  ARTIFACT_DEFAULT_TTL_SECONDS,
  ARTIFACT_HARD_MAX_TTL_SECONDS,
  ARTIFACT_MIN_TTL_SECONDS,
  type ArtifactRetentionPolicy,
  DEFAULT_ARTIFACT_RETENTION_POLICY,
  UPLOAD_DEFAULT_TTL_SECONDS,
  UPLOAD_HARD_MAX_TTL_SECONDS,
  UPLOAD_MIN_TTL_SECONDS,
} from "./artifact-retention-policy.js";

export const DEFAULT_UPLOAD_INTENT_TTL_MS = UPLOAD_DEFAULT_TTL_SECONDS * 1000;
export const MIN_UPLOAD_INTENT_TTL_MS = UPLOAD_MIN_TTL_SECONDS * 1000;
export const MAX_UPLOAD_INTENT_TTL_MS = UPLOAD_HARD_MAX_TTL_SECONDS * 1000;
export const DEFAULT_ARTIFACT_TTL_MS = ARTIFACT_DEFAULT_TTL_SECONDS * 1000;
export const MIN_ARTIFACT_TTL_MS = ARTIFACT_MIN_TTL_SECONDS * 1000;
export const MAX_ARTIFACT_TTL_MS = ARTIFACT_HARD_MAX_TTL_SECONDS * 1000;

const SCHEMA_VERSION = "1" as const;
const MAX_IDENTITY_CHARS = 256;
const MAX_MIME_CHARS = 128;
const MAX_FILENAME_CHARS = 512;
const HASH_PATTERN = /^sha256-[a-f0-9]{64}$/u;
const CLEANUP_RETRY_DELAY_MS = 60 * 1000;

export interface DurableUploadCaller {
  readonly ownerId: string;
  readonly credentialBinding: string;
}

export interface CreateDurableUploadIntentInput {
  readonly idempotencyKey: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly filename: string;
  readonly expectedDigest?: string | null;
  readonly uploadTtlMs?: number;
  readonly artifactTtlMs?: number;
  readonly nowMs: number;
}

export type DurableUploadIntentStatus = "pending" | "finalizing" | "finalized" | "expired";

export interface DurableSourceArtifactRef {
  readonly refId: string;
  readonly artifactKind: "source";
  readonly ownershipScope: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly verified: true;
}

export interface DurableUploadIntentView {
  readonly intentId: string;
  readonly status: DurableUploadIntentStatus;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly filename: string;
  readonly expectedDigest: string | null;
  readonly expiresAt: number;
  readonly artifactTtlMs: number;
  readonly artifactRef: DurableSourceArtifactRef | null;
}

export interface FinalizeDurableUploadInput {
  readonly intentId: string;
  readonly bytes: Uint8Array;
  readonly observedMime: string;
  readonly nowMs: number;
}

export interface DurableArtifactRead {
  readonly ref: DurableSourceArtifactRef;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
}

export interface DurableArtifactRevocation {
  readonly refId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly contentHash: string;
  readonly filename: string;
  readonly reason: "deleted" | "expired";
  readonly nowMs: number;
}

export interface DurableArtifactRevocationPort {
  revoke(input: DurableArtifactRevocation): Promise<void>;
}

interface FinalizationState {
  readonly refId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly blobKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface UploadIntentState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly intentId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly filename: string;
  readonly expectedDigest: string | null;
  readonly expiresAt: number;
  readonly artifactTtlMs: number;
  readonly status: DurableUploadIntentStatus;
  readonly finalization: FinalizationState | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ArtifactState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly refId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly filename: string;
  readonly blobKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly status: "active" | "expired" | "deleted" | "physical_cleanup_pending";
  readonly cleanupReason: "expired" | "deleted" | null;
}

export interface DurableUploadCleanupPage {
  readonly scanned: number;
  readonly logicallyRevoked: number;
  readonly physicallyDeleted: number;
  readonly retryPending: number;
  readonly failures: readonly string[];
  readonly nextCursor: string | null;
}

interface Versioned<T> {
  readonly state: T;
  readonly revision: number;
}

function uploadError(
  message: string,
  code: GroundlaneError["code"] = "INVALID_INPUT",
  retryable = false,
): GroundlaneError {
  return new GroundlaneError(code, "durable-upload", message, retryable);
}

function storageError(): GroundlaneError {
  return uploadError("Artifact storage operation failed", "UPSTREAM_ERROR", true);
}

async function sanitizedStorageCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw storageError();
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentDigest(bytes: Uint8Array): string {
  return `sha256-${sha256(bytes)}`;
}

function assertBoundedIdentity(value: string, field: string): void {
  if (value.length === 0 || value.length > MAX_IDENTITY_CHARS || value.trim() !== value) {
    throw uploadError(`${field} must be non-empty within ${String(MAX_IDENTITY_CHARS)} characters`);
  }
}

function assertCaller(caller: DurableUploadCaller): void {
  assertBoundedIdentity(caller.ownerId, "ownerId");
  assertBoundedIdentity(caller.credentialBinding, "credentialBinding");
}

function assertTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw uploadError("Upload timestamp is invalid");
}

function assertTtl(value: number, min: number, max: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw uploadError(`${field} TTL must be ${String(min)}..${String(max)} milliseconds`);
  }
}

function assertMime(value: string, field: string): void {
  if (value.length === 0 || value.length > MAX_MIME_CHARS || value.trim() !== value || !value.includes("/")) {
    throw uploadError(`${field} must be a bounded MIME type`);
  }
}

function assertFilename(value: string): void {
  if (value.length === 0 || value.length > MAX_FILENAME_CHARS || value.trim() !== value || /[\0\r\n]/u.test(value)) {
    throw uploadError("filename must be non-empty and bounded");
  }
}

function assertDigest(value: string | null): void {
  if (value !== null && !HASH_PATTERN.test(value)) {
    throw uploadError("expectedDigest must be a sha256 digest");
  }
}

function intentKey(intentId: string): string {
  return `upload-intent:${intentId}`;
}

function artifactKey(refId: string): string {
  return `upload-artifact:${refId}`;
}

function intentId(caller: DurableUploadCaller, idempotencyKey: string): string {
  return `upl_${sha256(`${caller.ownerId}\0${caller.credentialBinding}\0${idempotencyKey}`).slice(0, 40)}`;
}

function requestFingerprint(input: {
  declaredMime: string;
  declaredSize: number;
  filename: string;
  expectedDigest: string | null;
  uploadTtlMs: number;
  artifactTtlMs: number;
}): string {
  return sha256(JSON.stringify(input));
}

function refFor(intent: UploadIntentState, contentHash: string): string {
  return `art_${sha256(`${intent.intentId}\0${contentHash}`).slice(0, 40)}`;
}

function blobKey(intent: UploadIntentState, refId: string, contentHash: string): string {
  return `blobs/${sha256(`${intent.ownerId}\0${intent.credentialBinding}\0${refId}\0${contentHash}`)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(record: DurableRecord): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(record.value);
    if (isObject(value)) return value;
  } catch {
    // Mapped below to one stable internal-storage error.
  }
  throw storageError();
}

function isFinalization(value: unknown): value is FinalizationState {
  if (!isObject(value)) return false;
  return typeof value.refId === "string" && typeof value.contentHash === "string" &&
    typeof value.byteSize === "number" && typeof value.blobKey === "string" &&
    typeof value.createdAt === "number" && typeof value.expiresAt === "number";
}

function isIntentStatus(value: unknown): value is DurableUploadIntentStatus {
  return typeof value === "string" && ["pending", "finalizing", "finalized", "expired"].includes(value);
}

function isArtifactStatus(value: unknown): value is ArtifactState["status"] {
  return typeof value === "string" &&
    ["active", "expired", "deleted", "physical_cleanup_pending"].includes(value);
}

function decodeIntent(record: DurableRecord): Versioned<UploadIntentState> {
  const item = parseJson(record);
  if (
    item.schemaVersion !== SCHEMA_VERSION || typeof item.intentId !== "string" ||
    typeof item.ownerId !== "string" || typeof item.credentialBinding !== "string" ||
    typeof item.idempotencyKey !== "string" || typeof item.requestFingerprint !== "string" ||
    typeof item.declaredMime !== "string" || typeof item.declaredSize !== "number" ||
    typeof item.filename !== "string" ||
    !(item.expectedDigest === null || typeof item.expectedDigest === "string") ||
    typeof item.expiresAt !== "number" || typeof item.artifactTtlMs !== "number" ||
    !isIntentStatus(item.status) ||
    !(item.finalization === null || isFinalization(item.finalization)) ||
    typeof item.createdAt !== "number" || typeof item.updatedAt !== "number"
  ) throw storageError();
  const state: UploadIntentState = {
    schemaVersion: item.schemaVersion,
    intentId: item.intentId,
    ownerId: item.ownerId,
    credentialBinding: item.credentialBinding,
    idempotencyKey: item.idempotencyKey,
    requestFingerprint: item.requestFingerprint,
    declaredMime: item.declaredMime,
    declaredSize: item.declaredSize,
    filename: item.filename,
    expectedDigest: item.expectedDigest,
    expiresAt: item.expiresAt,
    artifactTtlMs: item.artifactTtlMs,
    status: item.status,
    finalization: item.finalization,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (record.key !== intentKey(state.intentId) ||
    (state.status === "pending" && state.finalization !== null) ||
    ((state.status === "finalizing" || state.status === "finalized") && state.finalization === null)) {
    throw storageError();
  }
  return { state, revision: record.revision };
}

function decodeArtifact(record: DurableRecord): Versioned<ArtifactState> {
  const item = parseJson(record);
  if (
    item.schemaVersion !== SCHEMA_VERSION || typeof item.refId !== "string" ||
    typeof item.ownerId !== "string" || typeof item.credentialBinding !== "string" ||
    typeof item.contentHash !== "string" || typeof item.byteSize !== "number" ||
    typeof item.mimeType !== "string" || typeof item.filename !== "string" ||
    typeof item.blobKey !== "string" || typeof item.createdAt !== "number" ||
    typeof item.updatedAt !== "number" || typeof item.expiresAt !== "number" ||
    !isArtifactStatus(item.status) ||
    !(item.cleanupReason === undefined || item.cleanupReason === null ||
      item.cleanupReason === "expired" || item.cleanupReason === "deleted")
  ) throw storageError();
  const state: ArtifactState = {
    schemaVersion: item.schemaVersion,
    refId: item.refId,
    ownerId: item.ownerId,
    credentialBinding: item.credentialBinding,
    contentHash: item.contentHash,
    byteSize: item.byteSize,
    mimeType: item.mimeType,
    filename: item.filename,
    blobKey: item.blobKey,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
    status: item.status,
    cleanupReason: item.cleanupReason ?? null,
  };
  if (record.key !== artifactKey(state.refId) ||
      (state.status === "physical_cleanup_pending" && state.cleanupReason === null) ||
      (state.status !== "physical_cleanup_pending" && state.cleanupReason !== null)) {
    throw storageError();
  }
  return { state, revision: record.revision };
}

function encode(value: UploadIntentState | ArtifactState): string {
  return JSON.stringify(value);
}

function assertIntentCaller(state: UploadIntentState, caller: DurableUploadCaller): void {
  if (state.ownerId !== caller.ownerId || state.credentialBinding !== caller.credentialBinding) {
    throw uploadError("Unknown or unavailable upload intent");
  }
}

function assertArtifactCaller(state: ArtifactState, caller: DurableUploadCaller): void {
  if (state.ownerId !== caller.ownerId || state.credentialBinding !== caller.credentialBinding) {
    throw uploadError("Unknown or unavailable artifact");
  }
}

function artifactRef(state: ArtifactState | (FinalizationState & { ownerId: string })): DurableSourceArtifactRef {
  return {
    refId: state.refId,
    artifactKind: "source",
    ownershipScope: state.ownerId,
    contentHash: state.contentHash,
    byteSize: state.byteSize,
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    verified: true,
  };
}

function intentView(state: UploadIntentState): DurableUploadIntentView {
  return {
    intentId: state.intentId,
    status: state.status,
    declaredMime: state.declaredMime,
    declaredSize: state.declaredSize,
    filename: state.filename,
    expectedDigest: state.expectedDigest,
    expiresAt: state.expiresAt,
    artifactTtlMs: state.artifactTtlMs,
    artifactRef: state.status === "finalized" && state.finalization !== null
      ? artifactRef({ ...state.finalization, ownerId: state.ownerId })
      : null,
  };
}

function sameArtifact(left: ArtifactState, right: ArtifactState): boolean {
  return left.refId === right.refId && left.ownerId === right.ownerId &&
    left.credentialBinding === right.credentialBinding && left.contentHash === right.contentHash &&
    left.byteSize === right.byteSize && left.mimeType === right.mimeType &&
    left.filename === right.filename && left.blobKey === right.blobKey &&
    left.createdAt === right.createdAt && left.expiresAt === right.expiresAt &&
    left.status === right.status && left.cleanupReason === right.cleanupReason;
}

/**
 * Protocol-neutral durable upload-intent and source-artifact lifecycle.
 * Transport adapters supply verified bytes and an observed MIME type; presigned
 * upload handoff and document processing remain outside this core service.
 */
export class DurableUploadArtifactService {
  constructor(
    private readonly records: DurableRecordStorePort,
    private readonly blobs: ImmutableBlobPort,
    private readonly retention: ArtifactRetentionPolicy = DEFAULT_ARTIFACT_RETENTION_POLICY,
    private readonly revocations?: DurableArtifactRevocationPort,
  ) {}

  private revokeArtifactSource(
    state: ArtifactState,
    reason: "deleted" | "expired",
    nowMs: number,
  ): Promise<void> {
    if (this.revocations === undefined) return Promise.resolve();
    return sanitizedStorageCall(() => this.revocations?.revoke({
      refId: state.refId,
      ownerId: state.ownerId,
      credentialBinding: state.credentialBinding,
      contentHash: state.contentHash,
      filename: state.filename,
      reason,
      nowMs,
    }) ?? Promise.resolve());
  }

  async createIntent(
    input: CreateDurableUploadIntentInput,
    caller: DurableUploadCaller,
  ): Promise<DurableUploadIntentView> {
    assertCaller(caller);
    assertBoundedIdentity(input.idempotencyKey, "idempotencyKey");
    assertMime(input.declaredMime, "declaredMime");
    assertFilename(input.filename);
    assertTime(input.nowMs);
    if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 1 ||
      input.declaredSize > MAX_IMMUTABLE_BLOB_BYTES) {
      throw uploadError(`declaredSize must be 1..${String(MAX_IMMUTABLE_BLOB_BYTES)} bytes`);
    }
    const expectedDigest = input.expectedDigest ?? null;
    assertDigest(expectedDigest);
    const uploadTtlMs = input.uploadTtlMs ?? this.retention.upload.defaultTtlSeconds * 1000;
    const artifactTtlMs = input.artifactTtlMs ?? this.retention.artifact.defaultTtlSeconds * 1000;
    assertTtl(
      uploadTtlMs,
      this.retention.upload.minTtlSeconds * 1000,
      this.retention.upload.maxTtlSeconds * 1000,
      "upload",
    );
    assertTtl(
      artifactTtlMs,
      this.retention.artifact.minTtlSeconds * 1000,
      this.retention.artifact.maxTtlSeconds * 1000,
      "artifact",
    );
    const fingerprint = requestFingerprint({
      declaredMime: input.declaredMime,
      declaredSize: input.declaredSize,
      filename: input.filename,
      expectedDigest,
      uploadTtlMs,
      artifactTtlMs,
    });
    const id = intentId(caller, input.idempotencyKey);
    const initial: UploadIntentState = {
      schemaVersion: SCHEMA_VERSION,
      intentId: id,
      ownerId: caller.ownerId,
      credentialBinding: caller.credentialBinding,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      declaredMime: input.declaredMime,
      declaredSize: input.declaredSize,
      filename: input.filename,
      expectedDigest,
      expiresAt: input.nowMs + uploadTtlMs,
      artifactTtlMs,
      status: "pending",
      finalization: null,
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
    };
    const created = await sanitizedStorageCall(() => this.records.createIfAbsent({
      key: intentKey(id),
      value: encode(initial),
      nowMs: input.nowMs,
      expiresAt: initial.expiresAt,
    }));
    const current = decodeIntent(created.record);
    assertIntentCaller(current.state, caller);
    if (current.state.requestFingerprint !== fingerprint) {
      throw uploadError("Idempotency key is already bound to a different upload request");
    }
    return intentView(current.state);
  }

  async getIntent(
    intentIdValue: string,
    caller: DurableUploadCaller,
    nowMs: number,
  ): Promise<DurableUploadIntentView> {
    assertCaller(caller);
    assertBoundedIdentity(intentIdValue, "intentId");
    assertTime(nowMs);
    const current = await this.readIntent(intentIdValue, caller);
    if (current.state.status === "pending" && nowMs >= current.state.expiresAt) {
      const expired: UploadIntentState = {
        ...current.state,
        status: "expired",
        updatedAt: nowMs,
      };
      const saved = await sanitizedStorageCall(() => this.records.compareAndSwap(
        intentKey(intentIdValue),
        current.revision,
        { value: encode(expired), nowMs, expiresAt: null },
      ));
      return intentView(saved.status === "updated" ? decodeIntent(saved.record).state : expired);
    }
    return intentView(current.state);
  }

  async finalize(
    input: FinalizeDurableUploadInput,
    caller: DurableUploadCaller,
  ): Promise<DurableSourceArtifactRef> {
    assertCaller(caller);
    assertBoundedIdentity(input.intentId, "intentId");
    assertTime(input.nowMs);
    assertMime(input.observedMime, "observedMime");
    const digest = contentDigest(input.bytes);
    let current = await this.readIntent(input.intentId, caller);
    if (current.state.status === "expired" ||
      (current.state.status === "pending" && input.nowMs >= current.state.expiresAt)) {
      if (current.state.status === "pending") {
        const expired: UploadIntentState = { ...current.state, status: "expired", updatedAt: input.nowMs };
        await sanitizedStorageCall(() => this.records.compareAndSwap(
          intentKey(input.intentId), current.revision,
          { value: encode(expired), nowMs: input.nowMs, expiresAt: null },
        ));
      }
      throw uploadError("Upload intent has expired");
    }
    this.validateFinalBytes(current.state, input, digest);
    if (current.state.status === "finalized") {
      const finalization = current.state.finalization;
      if (finalization === null || finalization.contentHash !== digest) {
        throw uploadError("Finalized upload cannot be replayed with different content");
      }
      return artifactRef({ ...finalization, ownerId: current.state.ownerId });
    }

    if (current.state.status === "pending") {
      const refId = refFor(current.state, digest);
      const finalization: FinalizationState = {
        refId,
        contentHash: digest,
        byteSize: input.bytes.byteLength,
        blobKey: blobKey(current.state, refId, digest),
        createdAt: input.nowMs,
        expiresAt: input.nowMs + current.state.artifactTtlMs,
      };
      const finalizing: UploadIntentState = {
        ...current.state,
        status: "finalizing",
        finalization,
        updatedAt: input.nowMs,
      };
      const claimed = await sanitizedStorageCall(() => this.records.compareAndSwap(
        intentKey(input.intentId), current.revision,
        { value: encode(finalizing), nowMs: input.nowMs, expiresAt: finalization.expiresAt },
      ));
      if (claimed.status !== "updated") {
        throw uploadError("Upload finalization conflicted; retry", "UPSTREAM_ERROR", true);
      }
      current = decodeIntent(claimed.record);
    }

    const finalization = current.state.finalization;
    if (finalization === null || finalization.contentHash !== digest ||
      finalization.byteSize !== input.bytes.byteLength) {
      throw uploadError("Upload finalization is already bound to different content");
    }
    const put = await sanitizedStorageCall(() => this.blobs.putIfAbsent({
      blobKey: finalization.blobKey,
      ownerId: current.state.ownerId,
      digest,
      bytes: input.bytes,
    }));
    if (put.status === "conflict" || put.stat.ownerId !== current.state.ownerId ||
      put.stat.digest !== digest || put.stat.byteSize !== input.bytes.byteLength) {
      throw uploadError("Immutable artifact identity conflict", "UPSTREAM_ERROR");
    }

    const artifact: ArtifactState = {
      schemaVersion: SCHEMA_VERSION,
      refId: finalization.refId,
      ownerId: current.state.ownerId,
      credentialBinding: current.state.credentialBinding,
      contentHash: digest,
      byteSize: input.bytes.byteLength,
      mimeType: current.state.declaredMime,
      filename: current.state.filename,
      blobKey: finalization.blobKey,
      createdAt: finalization.createdAt,
      updatedAt: input.nowMs,
      expiresAt: finalization.expiresAt,
      status: "active",
      cleanupReason: null,
    };
    const artifactCreated = await sanitizedStorageCall(() => this.records.createIfAbsent({
      key: artifactKey(artifact.refId),
      value: encode(artifact),
      nowMs: artifact.createdAt,
      expiresAt: artifact.expiresAt,
    }));
    const durableArtifact = decodeArtifact(artifactCreated.record);
    if (!sameArtifact(durableArtifact.state, artifact)) {
      throw uploadError("Immutable artifact metadata conflict", "UPSTREAM_ERROR");
    }

    const finalized: UploadIntentState = {
      ...current.state,
      status: "finalized",
      updatedAt: input.nowMs,
    };
    const saved = await sanitizedStorageCall(() => this.records.compareAndSwap(
      intentKey(input.intentId), current.revision,
      { value: encode(finalized), nowMs: input.nowMs, expiresAt: finalization.expiresAt },
    ));
    if (saved.status !== "updated") {
      if (saved.status === "conflict") {
        const raced = decodeIntent(saved.record);
        if (raced.state.status === "finalized" &&
          raced.state.finalization?.contentHash === digest) {
          return artifactRef({ ...finalization, ownerId: current.state.ownerId });
        }
      }
      throw uploadError("Upload finalization conflicted; retry", "UPSTREAM_ERROR", true);
    }
    return artifactRef({ ...finalization, ownerId: current.state.ownerId });
  }

  async readArtifact(
    refId: string,
    caller: DurableUploadCaller,
    nowMs: number,
    maxBytes: number,
  ): Promise<DurableArtifactRead> {
    assertCaller(caller);
    assertBoundedIdentity(refId, "refId");
    assertTime(nowMs);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMMUTABLE_BLOB_BYTES) {
      throw uploadError(`maxBytes must be 1..${String(MAX_IMMUTABLE_BLOB_BYTES)}`);
    }
    const current = await this.readArtifactState(refId, caller);
    if (current.state.status === "deleted" || current.state.status === "physical_cleanup_pending") {
      throw uploadError("Unknown or unavailable artifact");
    }
    if (current.state.status === "expired" || nowMs >= current.state.expiresAt) {
      if (current.state.status === "active") {
        const expired: ArtifactState = {
          ...current.state,
          status: "expired",
          cleanupReason: null,
          updatedAt: nowMs,
        };
        await sanitizedStorageCall(() => this.records.compareAndSwap(
          artifactKey(refId), current.revision,
          { value: encode(expired), nowMs, expiresAt: nowMs + CLEANUP_RETRY_DELAY_MS },
        ));
      }
      throw uploadError("Artifact has expired");
    }
    if (current.state.byteSize > maxBytes) {
      throw uploadError("Artifact exceeds the requested read limit", "OUTPUT_LIMIT");
    }
    const bytes = await sanitizedStorageCall(() => this.blobs.get({
      blobKey: current.state.blobKey,
      ownerId: current.state.ownerId,
      digest: current.state.contentHash,
      maxBytes,
    }));
    if (bytes === null) throw uploadError("Artifact storage operation failed", "UPSTREAM_ERROR", true);
    // Blob I/O can outlive a concurrent delete. The authoritative metadata
    // revision must still match before handing any bytes back to processing.
    const latest = await this.readArtifactState(refId, caller);
    if (latest.revision !== current.revision || latest.state.status !== "active") {
      throw uploadError("Unknown or unavailable artifact");
    }
    return {
      ref: artifactRef(current.state),
      bytes,
      mimeType: current.state.mimeType,
      filename: current.state.filename,
    };
  }

  async deleteArtifact(
    refId: string,
    caller: DurableUploadCaller,
    nowMs: number,
  ): Promise<void> {
    assertCaller(caller);
    assertBoundedIdentity(refId, "refId");
    assertTime(nowMs);
    let current = await this.readArtifactState(refId, caller);
    if (current.state.status !== "deleted") {
      const deleted: ArtifactState = {
        ...current.state,
        status: "deleted",
        cleanupReason: null,
        updatedAt: nowMs,
      };
      const saved = await sanitizedStorageCall(() => this.records.compareAndSwap(
        artifactKey(refId), current.revision,
        { value: encode(deleted), nowMs, expiresAt: nowMs + CLEANUP_RETRY_DELAY_MS },
      ));
      if (saved.status === "conflict") current = decodeArtifact(saved.record);
      else if (saved.status === "updated") current = decodeArtifact(saved.record);
      else throw uploadError("Artifact deletion conflicted; retry", "UPSTREAM_ERROR", true);
      if (current.state.status !== "deleted") {
        throw uploadError("Artifact deletion conflicted; retry", "UPSTREAM_ERROR", true);
      }
    }
    await this.revokeArtifactSource(current.state, "deleted", nowMs);
    const removed = await sanitizedStorageCall(() =>
      this.blobs.deleteIfOwner(current.state.blobKey, current.state.ownerId));
    if (removed === "owner_mismatch") throw uploadError("Artifact storage operation failed", "UPSTREAM_ERROR");
    const settled = { ...current.state, updatedAt: nowMs };
    await sanitizedStorageCall(() => this.records.compareAndSwap(
      artifactKey(refId), current.revision,
      { value: encode(settled), nowMs, expiresAt: null },
    ));
  }

  /** Bounded scheduled expiry scan. Logical revocation is CAS-persisted before blob deletion. */
  async cleanupExpiredPage(
    nowMs: number,
    cursor: string | null,
    limit: number,
  ): Promise<DurableUploadCleanupPage> {
    assertTime(nowMs);
    if (cursor !== null && (cursor.length === 0 || cursor.length > 240)) {
      throw uploadError("Cleanup cursor is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw uploadError("Cleanup page limit must be 1..100");
    }
    const page = await sanitizedStorageCall(() => this.records.scanExpired(nowMs, cursor, limit));
    let logicallyRevoked = 0;
    let physicallyDeleted = 0;
    let retryPending = 0;
    const failures: string[] = [];
    for (const record of page.records) {
      try {
        if (record.key.startsWith("upload-artifact:")) {
          const result = await this.cleanupArtifactRecord(record, nowMs);
          logicallyRevoked += result.logicallyRevoked;
          physicallyDeleted += result.physicallyDeleted;
          retryPending += result.retryPending;
        } else if (record.key.startsWith("upload-intent:")) {
          const result = await this.cleanupIntentRecord(record, nowMs);
          logicallyRevoked += result.logicallyRevoked;
          physicallyDeleted += result.physicallyDeleted;
          retryPending += result.retryPending;
        } else {
          failures.push(record.key);
        }
      } catch {
        failures.push(record.key);
        retryPending += 1;
      }
    }
    return {
      scanned: page.records.length,
      logicallyRevoked,
      physicallyDeleted,
      retryPending,
      failures,
      nextCursor: page.nextCursor,
    };
  }

  private async cleanupArtifactRecord(
    record: DurableRecord,
    nowMs: number,
  ): Promise<{ logicallyRevoked: number; physicallyDeleted: number; retryPending: number }> {
    let current = decodeArtifact(record);
    let logicallyRevoked = 0;
    if (current.state.status === "active") {
      const expired: ArtifactState = {
        ...current.state,
        status: "expired",
        cleanupReason: null,
        updatedAt: nowMs,
      };
      const revoked = await this.records.compareAndSwap(record.key, current.revision, {
        value: encode(expired), nowMs, expiresAt: nowMs + CLEANUP_RETRY_DELAY_MS,
      });
      if (revoked.status !== "updated") return { logicallyRevoked: 0, physicallyDeleted: 0, retryPending: 1 };
      current = decodeArtifact(revoked.record);
      logicallyRevoked = 1;
    }
    const revocationReason = current.state.status === "physical_cleanup_pending"
      ? current.state.cleanupReason
      : current.state.status === "expired" || current.state.status === "deleted"
        ? current.state.status
        : null;
    if (revocationReason !== null) {
      await this.revokeArtifactSource(current.state, revocationReason, nowMs);
    }
    if (current.state.status !== "physical_cleanup_pending") {
      if (current.state.status !== "expired" && current.state.status !== "deleted") {
        return { logicallyRevoked, physicallyDeleted: 0, retryPending: 0 };
      }
      const pending: ArtifactState = {
        ...current.state,
        status: "physical_cleanup_pending",
        cleanupReason: current.state.status,
        updatedAt: nowMs,
      };
      const claimed = await this.records.compareAndSwap(record.key, current.revision, {
        value: encode(pending), nowMs, expiresAt: nowMs + CLEANUP_RETRY_DELAY_MS,
      });
      if (claimed.status !== "updated") return { logicallyRevoked, physicallyDeleted: 0, retryPending: 1 };
      current = decodeArtifact(claimed.record);
    } else {
      const leased = await this.records.compareAndSwap(record.key, current.revision, {
        value: encode({ ...current.state, updatedAt: nowMs }),
        nowMs,
        expiresAt: nowMs + CLEANUP_RETRY_DELAY_MS,
      });
      if (leased.status !== "updated") return { logicallyRevoked, physicallyDeleted: 0, retryPending: 1 };
      current = decodeArtifact(leased.record);
    }
    let removed: "deleted" | "missing" | "owner_mismatch";
    try {
      removed = await this.blobs.deleteIfOwner(current.state.blobKey, current.state.ownerId);
    } catch {
      return { logicallyRevoked, physicallyDeleted: 0, retryPending: 1 };
    }
    if (removed === "owner_mismatch") return { logicallyRevoked, physicallyDeleted: 0, retryPending: 1 };
    const reason = current.state.cleanupReason;
    if (reason === null) return { logicallyRevoked, physicallyDeleted: 0, retryPending: 1 };
    const settled: ArtifactState = {
      ...current.state,
      status: reason,
      cleanupReason: null,
      updatedAt: nowMs,
    };
    const saved = await this.records.compareAndSwap(record.key, current.revision, {
      value: encode(settled), nowMs, expiresAt: null,
    });
    return saved.status === "updated"
      ? { logicallyRevoked, physicallyDeleted: removed === "deleted" ? 1 : 0, retryPending: 0 }
      : { logicallyRevoked, physicallyDeleted: removed === "deleted" ? 1 : 0, retryPending: 1 };
  }

  private async cleanupIntentRecord(
    record: DurableRecord,
    nowMs: number,
  ): Promise<{ logicallyRevoked: number; physicallyDeleted: number; retryPending: number }> {
    let current = decodeIntent(record);
    if (current.state.status !== "expired") {
      const expired: UploadIntentState = { ...current.state, status: "expired", updatedAt: nowMs };
      const needsBlobCleanup = current.state.status === "finalizing" && current.state.finalization !== null;
      const revoked = await this.records.compareAndSwap(record.key, current.revision, {
        value: encode(expired),
        nowMs,
        expiresAt: needsBlobCleanup ? nowMs + CLEANUP_RETRY_DELAY_MS : null,
      });
      if (revoked.status !== "updated") return { logicallyRevoked: 0, physicallyDeleted: 0, retryPending: 1 };
      current = decodeIntent(revoked.record);
      if (!needsBlobCleanup) return { logicallyRevoked: 1, physicallyDeleted: 0, retryPending: 0 };
    }
    const finalization = current.state.finalization;
    if (finalization === null || record.expiresAt === null) {
      return { logicallyRevoked: 0, physicallyDeleted: 0, retryPending: 0 };
    }
    let removed: "deleted" | "missing" | "owner_mismatch";
    try {
      removed = await this.blobs.deleteIfOwner(finalization.blobKey, current.state.ownerId);
    } catch {
      return { logicallyRevoked: 0, physicallyDeleted: 0, retryPending: 1 };
    }
    if (removed === "owner_mismatch") return { logicallyRevoked: 0, physicallyDeleted: 0, retryPending: 1 };
    const saved = await this.records.compareAndSwap(record.key, current.revision, {
      value: encode({ ...current.state, updatedAt: nowMs }), nowMs, expiresAt: null,
    });
    return saved.status === "updated"
      ? { logicallyRevoked: 0, physicallyDeleted: removed === "deleted" ? 1 : 0, retryPending: 0 }
      : { logicallyRevoked: 0, physicallyDeleted: removed === "deleted" ? 1 : 0, retryPending: 1 };
  }

  private async readIntent(
    id: string,
    caller: DurableUploadCaller,
  ): Promise<Versioned<UploadIntentState>> {
    const record = await sanitizedStorageCall(() => this.records.get(intentKey(id)));
    if (record === null) throw uploadError("Unknown or unavailable upload intent");
    const current = decodeIntent(record);
    assertIntentCaller(current.state, caller);
    return current;
  }

  private async readArtifactState(
    refId: string,
    caller: DurableUploadCaller,
  ): Promise<Versioned<ArtifactState>> {
    const record = await sanitizedStorageCall(() => this.records.get(artifactKey(refId)));
    if (record === null) throw uploadError("Unknown or unavailable artifact");
    const current = decodeArtifact(record);
    assertArtifactCaller(current.state, caller);
    return current;
  }

  private validateFinalBytes(
    state: UploadIntentState,
    input: FinalizeDurableUploadInput,
    digest: string,
  ): void {
    if (input.bytes.byteLength !== state.declaredSize) {
      throw uploadError("Uploaded byte size does not match the declared size");
    }
    if (input.observedMime !== state.declaredMime) {
      throw uploadError("Observed MIME type does not match the declared MIME type");
    }
    if (state.expectedDigest !== null && state.expectedDigest !== digest) {
      throw uploadError("Uploaded content hash does not match expectedDigest");
    }
    if (state.status === "finalized" && state.finalization?.contentHash !== digest) {
      throw uploadError("Finalized upload cannot be replayed with different content");
    }
  }
}
