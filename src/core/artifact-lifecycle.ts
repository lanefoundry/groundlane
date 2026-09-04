// ---------------------------------------------------------------------------
// PRD 661 -- Artifact processing & lifecycle runtime
//
// Pure in-memory runtime behind the verified-artifact lifecycle. No live R2,
// no network, no MCP registry/worker/Cloudflare bindings. Storage lives
// behind the ArtifactStoragePort boundary (Cloudflare deployment maps it to
// R2). Processing reads verified objects read-only and never auto-extends
// retention or enrolls a corpus. Cancel/failure/expiry/explicit-delete/orphan
// paths actually transition state, revoke access, and drop bytes.
// Staging cleanup window is at most 1 hour; logically expired and physical
// cleanup pending are distinct states; explicit delete revokes immediately.
// Errors are sanitized GroundlaneErrors (no secrets, raw bodies, or keys).
// ---------------------------------------------------------------------------

import { GroundlaneError, hint } from "./errors.js";
import {
  STAGING_CLEANUP_WINDOW_MS,
  validateArtifactRefId,
  validateCleanupWindow,
  type ArtifactRef,
} from "./upload-intent.js";

export const ARTIFACT_LIFECYCLE_CLEANUP_WINDOW_MS = STAGING_CLEANUP_WINDOW_MS;

export type ArtifactLifecycleStatus =
  | "active"
  | "cancelled"
  | "failed"
  | "logically_expired"
  | "logically_deleted"
  | "physical_cleanup_pending"
  | "cleaned";

export type StagingLifecycleStatus =
  | "active"
  | "logically_expired"
  | "logically_deleted"
  | "physical_cleanup_pending"
  | "cleaned";

export interface ArtifactLifecycleRecord {
  readonly ref: ArtifactRef;
  readonly status: ArtifactLifecycleStatus;
  readonly accessRevoked: boolean;
  readonly corpusEnrolled: false;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProcessReceipt {
  readonly refId: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly expiresAt: number;
  readonly retentionExtended: false;
  readonly corpusEnrolled: false;
}

export interface StagingLifecycleEntry {
  readonly intentId: string;
  readonly status: StagingLifecycleStatus;
  readonly accessRevoked: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function lifecycleError(message: string, hintCode: string, hintText: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "artifact-lifecycle", message, false, undefined, hint(hintCode, hintText));
}

function assertOwnershipScope(scope: string): void {
  if (!scope || !scope.trim()) {
    throw lifecycleError(
      "Artifact must carry a non-empty ownershipScope",
      "artifact.invalid_input",
      "Register the artifact with its owning scope.",
    );
  }
}

function assertRefId(refId: string): void {
  if (!refId) {
    throw lifecycleError(
      "Artifact must carry a non-empty refId",
      "artifact.invalid_input",
      "Register the artifact with an opaque refId.",
    );
  }
  try {
    validateArtifactRefId(refId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid ArtifactRef refId";
    throw lifecycleError(message, "artifact.invalid_ref", "Use a storage-neutral opaque ArtifactRef.");
  }
}

/** Storage port boundary: opaque refId -> bytes with ownership binding. */
export interface ArtifactStoragePort {
  put(refId: string, ownershipScope: string, bytes: Uint8Array): void;
  get(refId: string): Uint8Array | null;
  delete(refId: string): void;
  listIds(): readonly string[];
}

export class InMemoryArtifactStorage implements ArtifactStoragePort {
  private readonly blobs = new Map<string, { bytes: Uint8Array; ownershipScope: string }>();

  put(refId: string, ownershipScope: string, bytes: Uint8Array): void {
    assertRefId(refId);
    assertOwnershipScope(ownershipScope);
    this.blobs.set(refId, { bytes: bytes.slice(), ownershipScope });
  }

  get(refId: string): Uint8Array | null {
    const found = this.blobs.get(refId);
    return found === undefined ? null : found.bytes.slice();
  }

  getOwnership(refId: string): string | null {
    return this.blobs.get(refId)?.ownershipScope ?? null;
  }

  delete(refId: string): void {
    this.blobs.delete(refId);
  }

  listIds(): readonly string[] {
    return [...this.blobs.keys()];
  }

  /** Test-only helper to plant a blob without a lifecycle record (orphan). */
  putOrphanForTest(refId: string, ownershipScope: string, bytes: Uint8Array): void {
    this.put(refId, ownershipScope, bytes);
  }
}

interface MutableArtifactRecord {
  ref: ArtifactRef;
  status: ArtifactLifecycleStatus;
  accessRevoked: boolean;
  createdAt: number;
  updatedAt: number;
}

interface MutableStagingEntry {
  intentId: string;
  status: StagingLifecycleStatus;
  accessRevoked: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * PRD 661 runtime store. Holds verified-artifact records (truth source) plus
 * staging entries. Bytes live in the storage port; records hold only small
 * metadata (ref, status, timestamps). Processing is read-only.
 */
export class ArtifactLifecycleStore {
  private readonly records = new Map<string, MutableArtifactRecord>();
  private readonly staging = new Map<string, MutableStagingEntry>();

  constructor(private readonly storage: ArtifactStoragePort = new InMemoryArtifactStorage()) {}

  registerVerifiedArtifact(ref: ArtifactRef, bytes: Uint8Array, nowMs: number): void {
    if (ref.verified !== true) {
      throw lifecycleError(
        "Cannot register unverified upload as an artifact",
        "artifact.unverified",
        "Finalize and verify the upload before registering it.",
      );
    }
    assertRefId(ref.refId);
    assertOwnershipScope(ref.ownershipScope);
    if (this.records.has(ref.refId)) {
      throw lifecycleError(
        "Artifact already registered",
        "artifact.invalid_input",
        "Register each finalized ArtifactRef once.",
      );
    }
    this.storage.put(ref.refId, ref.ownershipScope, bytes);
    this.records.set(ref.refId, {
      ref: { ...ref },
      status: "active",
      accessRevoked: false,
      createdAt: nowMs,
      updatedAt: nowMs,
    });
  }

  getRecord(refId: string): ArtifactLifecycleRecord | null {
    const record = this.records.get(refId);
    if (record === undefined) return null;
    return {
      ref: { ...record.ref },
      status: record.status,
      accessRevoked: record.accessRevoked,
      corpusEnrolled: false,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  readArtifact(refId: string, callerScope: string, nowMs: number): Uint8Array {
    const record = this.requireRecord(refId);
    if (record.ref.ownershipScope !== callerScope) {
      throw lifecycleError(
        `Cross-ownership access denied for artifact "${refId}"`,
        "artifact.access_denied",
        "Read the artifact with its owning scope.",
      );
    }
    if (record.accessRevoked || record.status === "logically_deleted") {
      throw lifecycleError(
        "Artifact access was revoked; the artifact was deleted",
        "artifact.access_revoked",
        "The artifact was explicitly deleted and can no longer be read.",
      );
    }
    if (record.status === "cancelled" || record.status === "failed") {
      throw lifecycleError(
        "Artifact access was revoked; processing did not complete",
        "artifact.access_revoked",
        "The artifact processing was cancelled or failed.",
      );
    }
    if (record.status === "cleaned") {
      throw lifecycleError(
        "Artifact access was revoked; the artifact was cleaned up",
        "artifact.access_revoked",
        "The artifact has been cleaned up and can no longer be read.",
      );
    }
    if (nowMs >= record.ref.expiresAt || record.status === "logically_expired") {
      if (record.status === "active") {
        record.status = "logically_expired";
        record.accessRevoked = true;
        record.updatedAt = nowMs;
      }
      throw lifecycleError(
        "Artifact access was revoked; the artifact has expired",
        "artifact.expired",
        "Re-upload or re-finalize the source to obtain a fresh ArtifactRef.",
      );
    }
    const bytes = this.storage.get(refId);
    if (bytes === null) {
      throw lifecycleError(
        "Artifact not found or access denied",
        "artifact.invalid_input",
        "Check the refId and ownershipScope, then retry.",
      );
    }
    return bytes;
  }

  /**
   * Read-only processing: verifies readability, returns a receipt, and
   * mutates nothing (no retention extension, no corpus enrollment).
   */
  processArtifact(refId: string, callerScope: string, nowMs: number): ProcessReceipt {
    const bytes = this.readArtifact(refId, callerScope, nowMs);
    const record = this.requireRecord(refId);
    void bytes;
    return {
      refId: record.ref.refId,
      byteSize: record.ref.byteSize,
      contentHash: record.ref.contentHash,
      expiresAt: record.ref.expiresAt,
      retentionExtended: false,
      corpusEnrolled: false,
    };
  }

  cancelProcessing(refId: string, _reason: string, nowMs: number): void {
    const record = this.requireRecord(refId);
    record.status = "cancelled";
    record.accessRevoked = true;
    record.updatedAt = nowMs;
  }

  failProcessing(refId: string, _reason: string, nowMs: number): void {
    const record = this.requireRecord(refId);
    record.status = "failed";
    record.accessRevoked = true;
    record.updatedAt = nowMs;
  }

  expireSweep(nowMs: number): string[] {
    const expired: string[] = [];
    for (const [refId, record] of this.records) {
      if (record.status !== "active") continue;
      if (nowMs >= record.ref.expiresAt) {
        record.status = "logically_expired";
        record.accessRevoked = true;
        record.updatedAt = nowMs;
        expired.push(refId);
      }
    }
    return expired;
  }

  deleteExplicit(refId: string, callerScope: string, nowMs: number): void {
    const record = this.requireRecord(refId);
    if (record.ref.ownershipScope !== callerScope) {
      throw lifecycleError(
        `Cross-ownership access denied for artifact "${refId}"`,
        "artifact.access_denied",
        "Delete the artifact with its owning scope.",
      );
    }
    record.status = "logically_deleted";
    record.accessRevoked = true;
    record.updatedAt = nowMs;
  }

  markArtifactCleanupPending(refId: string, nowMs: number): ArtifactLifecycleRecord {
    const record = this.requireRecord(refId);
    if (record.status !== "logically_expired" && record.status !== "logically_deleted") {
      throw lifecycleError(
        "Only logically expired or deleted artifacts can move to cleanup pending",
        "artifact.invalid_input",
        "Expire or delete the artifact before physical cleanup.",
      );
    }
    record.status = "physical_cleanup_pending";
    record.updatedAt = nowMs;
    return this.publicRecord(record);
  }

  sweepArtifacts(nowMs: number, windowMs: number = ARTIFACT_LIFECYCLE_CLEANUP_WINDOW_MS): string[] {
    validateCleanupWindow(windowMs);
    const cleaned: string[] = [];
    for (const [refId, record] of this.records) {
      if (record.status !== "physical_cleanup_pending" && record.status !== "logically_expired" && record.status !== "logically_deleted") {
        continue;
      }
      if (nowMs - record.updatedAt < windowMs) continue;
      if (record.status === "logically_expired" || record.status === "logically_deleted") {
        record.status = "physical_cleanup_pending";
        record.updatedAt = nowMs;
        continue;
      }
      record.status = "cleaned";
      record.accessRevoked = true;
      record.updatedAt = nowMs;
      this.storage.delete(refId);
      cleaned.push(refId);
    }
    return cleaned;
  }

  cleanupOrphans(_nowMs: number): string[] {
    void _nowMs;
    const known = new Set(this.records.keys());
    const removed: string[] = [];
    for (const id of this.storage.listIds()) {
      if (!known.has(id) && !this.staging.has(id)) {
        this.storage.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  // -- Staging lifecycle (upload staging side of PRD 661) --------------------

  trackStaging(intentId: string, nowMs: number): StagingLifecycleEntry {
    if (!intentId) {
      throw lifecycleError(
        "Staging intent must have a non-empty ID",
        "artifact.invalid_input",
        "Track staging with a non-empty intent ID.",
      );
    }
    if (this.staging.has(intentId)) {
      throw lifecycleError(
        "Staging intent already tracked",
        "artifact.invalid_input",
        "Track each staging intent once.",
      );
    }
    const entry: MutableStagingEntry = {
      intentId,
      status: "active",
      accessRevoked: false,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.staging.set(intentId, entry);
    return { ...entry };
  }

  expireStaging(intentId: string, nowMs: number): StagingLifecycleEntry {
    const entry = this.requireStaging(intentId);
    entry.status = "logically_expired";
    entry.updatedAt = nowMs;
    return { ...entry };
  }

  markStagingCleanupPending(intentId: string, nowMs: number): StagingLifecycleEntry {
    const entry = this.requireStaging(intentId);
    if (entry.status !== "logically_expired" && entry.status !== "logically_deleted" && entry.status !== "active") {
      throw lifecycleError(
        "Staging entry cannot move to cleanup pending from its current state",
        "artifact.invalid_input",
        "Expire or delete the staging entry before physical cleanup.",
      );
    }
    entry.status = "physical_cleanup_pending";
    entry.updatedAt = nowMs;
    return { ...entry };
  }

  deleteStagingExplicit(intentId: string, nowMs: number): StagingLifecycleEntry {
    const entry = this.requireStaging(intentId);
    entry.status = "logically_deleted";
    entry.accessRevoked = true;
    entry.updatedAt = nowMs;
    return { ...entry };
  }

  sweepStaging(nowMs: number, windowMs: number = ARTIFACT_LIFECYCLE_CLEANUP_WINDOW_MS): string[] {
    validateCleanupWindow(windowMs);
    const cleaned: string[] = [];
    for (const [intentId, entry] of this.staging) {
      if (entry.status !== "physical_cleanup_pending" && entry.status !== "logically_expired" && entry.status !== "logically_deleted") {
        continue;
      }
      if (nowMs - entry.updatedAt < windowMs) continue;
      if (entry.status === "logically_expired" || entry.status === "logically_deleted") {
        entry.status = "physical_cleanup_pending";
        entry.updatedAt = nowMs;
        continue;
      }
      entry.status = "cleaned";
      entry.updatedAt = nowMs;
      this.storage.delete(intentId);
      cleaned.push(intentId);
    }
    // Remove cleaned entries so orphan scans stay accurate.
    for (const id of cleaned) {
      this.staging.delete(id);
    }
    return cleaned;
  }

  getStaging(intentId: string): StagingLifecycleEntry | null {
    const entry = this.staging.get(intentId);
    return entry === undefined ? null : { ...entry };
  }

  private requireRecord(refId: string): MutableArtifactRecord {
    const record = this.records.get(refId);
    if (record === undefined) {
      throw lifecycleError(
        "Unknown artifact",
        "artifact.invalid_input",
        "Register the artifact before operating on it.",
      );
    }
    return record;
  }

  private requireStaging(intentId: string): MutableStagingEntry {
    const entry = this.staging.get(intentId);
    if (entry === undefined) {
      throw lifecycleError(
        "Unknown staging intent",
        "artifact.invalid_input",
        "Track the staging intent before operating on it.",
      );
    }
    return entry;
  }

  private publicRecord(record: MutableArtifactRecord): ArtifactLifecycleRecord {
    return {
      ref: { ...record.ref },
      status: record.status,
      accessRevoked: record.accessRevoked,
      corpusEnrolled: false,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
