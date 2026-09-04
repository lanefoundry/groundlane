// ---------------------------------------------------------------------------
// Corpus lifecycle and durable job contracts (PRD 675, 743, 744, 745, 746, 747)
// ---------------------------------------------------------------------------

// -- PRD 675: Corpus enrollment --------------------------------------------

export interface RetentionPolicy {
  readonly operator: string | null;
  readonly project: string | null;
  readonly corpus: string | null;
  readonly source: string | null;
  readonly minimumBoundMs: number;
}

export interface CorpusSourceRecord {
  readonly sourceId: string;
  readonly corpusId: string;
  readonly contentHash: string;
  readonly enrolledAt: string;
  readonly lifecycle: "enrolled" | "removed" | "deleted";
  readonly cacheBindings: readonly string[];
}

export interface CorpusEnrollment {
  readonly sourceId: string;
  readonly corpusId: string;
  readonly enrolledAt: string;
  readonly expiresAt: string | null;
  readonly retentionPolicy: RetentionPolicy;
  readonly sourceRecord: CorpusSourceRecord;
}

/**
 * PRD 675: Effective expiry = min(caller request, all applicable hard caps).
 * Null entries are treated as infinite (persistent).
 */
export function resolveEnrollmentExpiry(
  callerExpiresAt: string | null,
  operatorCapExpiresAt: string | null,
  projectCapExpiresAt: string | null,
  corpusCapExpiresAt: string | null,
  sourceCapExpiresAt: string | null,
): string | null {
  const candidates: number[] = [];
  for (const iso of [
    callerExpiresAt,
    operatorCapExpiresAt,
    projectCapExpiresAt,
    corpusCapExpiresAt,
    sourceCapExpiresAt,
  ]) {
    if (iso !== null) {
      candidates.push(new Date(iso).getTime());
    }
  }
  if (candidates.length === 0) {
    return null; // persistent
  }
  return new Date(Math.min(...candidates)).toISOString();
}

/**
 * PRD 675: Below minimum bound -> reject (not silent extend).
 */
export function validateEnrollmentExpiry(
  expiresAt: string | null,
  minimumBoundMs: number,
  now: Date,
): void {
  if (expiresAt === null) {
    return; // persistent is always valid
  }
  const expiryMs = new Date(expiresAt).getTime();
  const minMs = now.getTime() + minimumBoundMs;
  if (expiryMs < minMs) {
    throw new Error(
      `Enrollment expiry is below minimum bound: expiry at ${expiresAt} ` +
        `is less than minimum ${new Date(minMs).toISOString()}`,
    );
  }
}

/**
 * PRD 675: Re-enroll/update doesn't reset or extend expiry.
 */
export function validateReEnroll(
  existing: CorpusEnrollment,
  newExpiresAt: string | null,
): void {
  if (existing.expiresAt === null) {
    return; // persistent enrollment, no expiry to extend
  }
  if (newExpiresAt === null) {
    throw new Error(
      "Re-enrollment cannot extend expiry from finite to persistent; use explicit extend operation",
    );
  }
  const existingMs = new Date(existing.expiresAt).getTime();
  const newMs = new Date(newExpiresAt).getTime();
  if (newMs > existingMs) {
    throw new Error(
      "Re-enrollment cannot extend expiry; use explicit extend operation",
    );
  }
}

/**
 * PRD 675: Delete immediately revokes access and invalidates cache bindings.
 */
export function revokeEnrollment(
  enrollment: CorpusEnrollment,
): { enrollment: CorpusEnrollment; cacheBindingsInvalidated: readonly string[] } {
  const revokedRecord: CorpusSourceRecord = {
    ...enrollment.sourceRecord,
    lifecycle: "deleted",
    cacheBindings: [],
  };
  return {
    enrollment: {
      ...enrollment,
      sourceRecord: revokedRecord,
    },
    cacheBindingsInvalidated: enrollment.sourceRecord.cacheBindings,
  };
}

// -- PRD 743: Durable job retry idempotency --------------------------------

export interface RetryIdempotencyGuard {
  readonly idempotencyKey: string;
  readonly previousAttemptId: string | null;
  readonly providerTaskCreated: boolean;
  readonly paidCallCompleted: boolean;
  readonly artifactWriteCompleted: boolean;
}

export interface RetryResult {
  readonly idempotencyKey: string;
  readonly reused: boolean;
  readonly result: unknown;
}

export interface CancelAcknowledgmentStatus {
  readonly requested: boolean;
  readonly providerAcknowledged: boolean;
  readonly status: "confirmed" | "uncertain" | "not_requested";
}

/**
 * PRD 743: Retry with same idempotency key must return previous result,
 * not duplicate provider tasks, paid calls, or artifact writes.
 */
export function validateRetryIdempotency(
  guard: RetryIdempotencyGuard,
  previousResult: unknown,
): RetryResult {
  if (guard.previousAttemptId !== null && previousResult !== null) {
    return {
      idempotencyKey: guard.idempotencyKey,
      reused: true,
      result: previousResult,
    };
  }
  return {
    idempotencyKey: guard.idempotencyKey,
    reused: false,
    result: null,
  };
}

/**
 * PRD 743: Cannot duplicate provider task creation on retry.
 */
export function validateProviderTaskNotDuplicated(
  guard: RetryIdempotencyGuard,
): void {
  if (guard.providerTaskCreated && guard.previousAttemptId !== null) {
    throw new Error(
      "Provider task already created for this idempotency key; retry must reuse existing task",
    );
  }
}

/**
 * PRD 743: Cannot duplicate paid upstream calls on retry.
 */
export function validatePaidCallNotDuplicated(
  guard: RetryIdempotencyGuard,
): void {
  if (guard.paidCallCompleted && guard.previousAttemptId !== null) {
    throw new Error(
      "Paid upstream call already completed for this idempotency key; retry must not re-bill",
    );
  }
}

/**
 * PRD 743: Cannot duplicate artifact writes on retry.
 */
export function validateArtifactWriteNotDuplicated(
  guard: RetryIdempotencyGuard,
): void {
  if (guard.artifactWriteCompleted && guard.previousAttemptId !== null) {
    throw new Error(
      "Artifact write already completed for this idempotency key; retry must not duplicate",
    );
  }
}

/**
 * PRD 743: Without provider acknowledgment, must not claim cancel succeeded.
 */
export function resolveCancelAcknowledgment(
  requested: boolean,
  providerAcknowledged: boolean,
): CancelAcknowledgmentStatus {
  if (!requested) {
    return { requested: false, providerAcknowledged: false, status: "not_requested" };
  }
  if (providerAcknowledged) {
    return { requested: true, providerAcknowledged: true, status: "confirmed" };
  }
  return { requested: true, providerAcknowledged: false, status: "uncertain" };
}

// -- PRD 744: Durable state policy and storage-neutral ArtifactRef ---------

export const MAX_INLINE_BYTES = 4096;

export interface DurableStatePolicy {
  readonly maxInlineBytes: number;
}

/**
 * Storage-neutral durable ArtifactRef.
 * PRD 744: No storageBackend field — deployment maps to backend.
 */
export interface DurableArtifactRef {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly retentionPolicy: string;
  readonly expiresAt: string;
  readonly deletionPolicy: "on_expiry" | "on_owner_delete" | "manual";
}

/**
 * PRD 744: D1/DO/Workflow/Queue state must not store large content.
 */
export function validateDurableState(
  inlineBytes: number,
  policy: DurableStatePolicy,
): void {
  if (inlineBytes > policy.maxInlineBytes) {
    throw new Error(
      `Inline content size ${String(inlineBytes)} exceeds durable state limit ${String(policy.maxInlineBytes)}; ` +
        "use ArtifactRef for large content",
    );
  }
}

/**
 * PRD 744: Validate that a DurableArtifactRef has all required fields
 * and no storage-specific fields.
 */
export function validateDurableArtifactRef(ref: DurableArtifactRef): void {
  if (!ref.tenantId) throw new Error("tenantId is required");
  if (!ref.ownerId) throw new Error("ownerId is required");
  if (!ref.contentHash) throw new Error("contentHash is required");
  if (ref.byteSize <= 0) throw new Error("byteSize must be positive");
  if (!ref.retentionPolicy) throw new Error("retentionPolicy is required");
  if (!ref.expiresAt) throw new Error("expiresAt is required");
  if (!ref.deletionPolicy) throw new Error("deletionPolicy is required");
}

// -- PRD 745: Search source kind and provenance ----------------------------

export type SearchSourceKind = "public_web" | "corpus";

export interface SearchResultProvenance {
  readonly sourceKind: SearchSourceKind;
  readonly provider: string;
  readonly backend: string;
  readonly corpusBoundary: string | null;
  readonly freshnessTimestamp: string;
}

/**
 * PRD 745: Scoped result must not be labeled as public web search.
 */
export function validateSearchResultLabeling(
  provenance: SearchResultProvenance,
): void {
  if (
    provenance.corpusBoundary !== null &&
    provenance.sourceKind === "public_web"
  ) {
    throw new Error(
      "Corpus-scoped search result must not be labeled as public_web; " +
        `corpus boundary "${provenance.corpusBoundary}" requires sourceKind "corpus"`,
    );
  }
}

// -- PRD 746: Corpus lifecycle contract ------------------------------------

export type CorpusLifecycleOperation =
  | "create"
  | "enroll_source"
  | "update"
  | "resync"
  | "remove_source"
  | "status"
  | "search"
  | "delete";

/**
 * Opaque corpus identity — must not use backend job/index ID.
 */
export interface CorpusIdentity {
  readonly corpusId: string;
  readonly displayName: string;
}

export type CorpusState =
  | "active"
  | "syncing"
  | "degraded"
  | "deleting"
  | "deleted";

export interface DeletionStatus {
  readonly derivedIndexDeleted: boolean;
  readonly artifactDeleted: boolean;
  readonly isComplete: boolean;
}

/**
 * PRD 746: Public identity must not use backend job/index ID.
 */
export function validateCorpusIdentity(identity: CorpusIdentity): void {
  // Reject IDs that look like backend/provider internal IDs
  const backendPatterns = [
    /^idx[-_]/iu,        // index IDs
    /^job[-_]/iu,        // job IDs
    /^vec[-_]/iu,        // vector store IDs
    /^ns[-_]/iu,         // namespace IDs
    /^vs_/iu,            // OpenAI vector store prefix
    /^coll[-_]/iu,       // collection IDs
    /^pinecone[-_]/iu,   // Pinecone prefix
    /^weaviate[-_]/iu,   // Weaviate prefix
    /^qdrant[-_]/iu,     // Qdrant prefix
  ];
  for (const pattern of backendPatterns) {
    if (pattern.test(identity.corpusId)) {
      throw new Error(
        `Corpus ID "${identity.corpusId}" appears to be a backend internal ID; ` +
          "use an opaque Groundlane-generated ID",
      );
    }
  }
}

/**
 * PRD 746: Incomplete deletion must not claim deletion complete.
 */
export function validateDeletionStatus(status: DeletionStatus): void {
  if (status.isComplete && (!status.derivedIndexDeleted || !status.artifactDeleted)) {
    throw new Error(
      "Deletion cannot be reported as complete when derived index or artifact deletion is pending",
    );
  }
}

/**
 * PRD 746: Backend partial failure maps to stable degraded state.
 */
export function mapBackendFailureToState(
  backendHealthy: boolean,
  indexHealthy: boolean,
): CorpusState {
  if (backendHealthy && indexHealthy) return "active";
  return "degraded";
}

// -- PRD 747: Corpus manifest as contract truth ----------------------------

export interface CorpusSourceManifestEntry {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly acl: readonly string[];
  readonly retentionPolicy: string;
  readonly deletionPolicy: string;
  readonly lifecycleProvenance: string;
  readonly citationProvenance: string;
  readonly backendProvenance: string;
}

export interface CorpusManifest {
  readonly corpusId: string;
  readonly sources: readonly CorpusSourceManifestEntry[];
  readonly updatedAt: string;
}

/**
 * PRD 747: Derived index is rebuildable and must not become identity,
 * authorization, retention, or deletion truth.
 */
export interface DerivedIndexPolicy {
  readonly isRebuildable: true;
  readonly isIdentityTruth: false;
  readonly isAuthorizationTruth: false;
  readonly isRetentionTruth: false;
  readonly isDeletionTruth: false;
}

export const DERIVED_INDEX_POLICY: DerivedIndexPolicy = {
  isRebuildable: true,
  isIdentityTruth: false,
  isAuthorizationTruth: false,
  isRetentionTruth: false,
  isDeletionTruth: false,
};

/**
 * PRD 747: Index rebuild doesn't change manifest identity.
 */
export function verifyManifestStableAfterRebuild(
  before: CorpusManifest,
  after: CorpusManifest,
): void {
  if (before.corpusId !== after.corpusId) {
    throw new Error(
      "Corpus identity changed after index rebuild; manifest must be stable",
    );
  }
  if (before.sources.length !== after.sources.length) {
    throw new Error(
      "Source count changed after index rebuild; manifest must be stable",
    );
  }
  for (let i = 0; i < before.sources.length; i++) {
    const beforeSource = before.sources[i];
    const afterSource = after.sources[i];
    if (beforeSource === undefined || afterSource === undefined) {
      throw new Error("Source entry missing during rebuild comparison");
    }
    if (beforeSource.sourceId !== afterSource.sourceId) {
      throw new Error(
        `Source identity changed after index rebuild: "${beforeSource.sourceId}" -> "${afterSource.sourceId}"`,
      );
    }
    if (beforeSource.contentHash !== afterSource.contentHash) {
      throw new Error(
        `Source content hash changed after index rebuild for "${beforeSource.sourceId}"`,
      );
    }
  }
}
