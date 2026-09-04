// ---------------------------------------------------------------------------
// PRD 665, 666, 667, 668, 669, 670, 684 -- Upload intent, ArtifactRef
// ---------------------------------------------------------------------------

// -- PRD 665: Upload intent flow --------------------------------------------

export type UploadIntentStatus =
  | "pending"
  | "uploading"
  | "completing"
  | "finalized"
  | "expired"
  | "failed";

export interface UploadIntent {
  readonly intentId: string;
  readonly ownershipScope: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly maxSize: number;
  readonly expectedDigest: string | null;
  readonly expiresAt: number;
  readonly status: UploadIntentStatus;
  readonly multipart: false;
}

export interface CompleteUploadRequest {
  readonly intentId: string;
  readonly actualSize: number;
  readonly sniffedMime: string;
  readonly contentHash: string;
}

export const UPLOAD_INTENT_DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function validateCreateIntent(intent: UploadIntent, nowMs: number): void {
  if (!intent.intentId) {
    throw new Error("Upload intent must have a non-empty intentId");
  }
  if (!intent.ownershipScope) {
    throw new Error("Upload intent must have a non-empty ownershipScope");
  }
  if (intent.declaredSize <= 0) {
    throw new Error("Upload intent declaredSize must be positive");
  }
  if (intent.declaredSize > intent.maxSize) {
    throw new Error(
      `Declared size ${String(intent.declaredSize)} exceeds max size ${String(intent.maxSize)}`,
    );
  }
  if (intent.expiresAt <= nowMs) {
    throw new Error("Upload intent is already expired at creation time");
  }
  if (intent.multipart !== false) {
    throw new Error("V1 only supports single PUT upload; multipart is rejected");
  }
}

export function validateCompleteUpload(
  intent: UploadIntent,
  req: CompleteUploadRequest,
  nowMs: number,
): void {
  // Expired
  if (nowMs >= intent.expiresAt) {
    throw new Error("Upload intent has expired");
  }

  // Status checks
  if (intent.status === "finalized") {
    throw new Error("Cannot overwrite a finalized staging object");
  }
  if (intent.status === "expired") {
    throw new Error("Upload intent has expired");
  }
  if (intent.status === "failed") {
    throw new Error("Upload intent has failed");
  }
  if (intent.status !== "uploading" && intent.status !== "pending") {
    throw new Error(`Upload intent is in unexpected status: "${intent.status}"`);
  }

  // Intent ID mismatch (replay detection)
  if (req.intentId !== intent.intentId) {
    throw new Error("Intent ID mismatch: possible replay attack");
  }

  // Size check
  if (req.actualSize > intent.maxSize) {
    throw new Error(
      `Actual size ${String(req.actualSize)} exceeds max size ${String(intent.maxSize)}`,
    );
  }

  // Digest check
  if (intent.expectedDigest !== null && req.contentHash !== intent.expectedDigest) {
    throw new Error(
      `Content hash mismatch: expected "${intent.expectedDigest}", got "${req.contentHash}"`,
    );
  }

  // MIME sniff vs declared
  if (req.sniffedMime !== intent.declaredMime) {
    throw new Error(
      `MIME type mismatch: declared "${intent.declaredMime}", sniffed "${req.sniffedMime}"`,
    );
  }
}

export function validateCrossOwnership(
  intent: UploadIntent,
  callerScope: string,
): void {
  if (intent.ownershipScope !== callerScope) {
    throw new Error(
      `Cross-ownership access denied: intent scope "${intent.ownershipScope}" does not match caller scope "${callerScope}"`,
    );
  }
}

// -- PRD 666: ArtifactRef ---------------------------------------------------

export type ArtifactKind = "source" | "canonical_document" | "projection";

export type RetentionPolicy = "transient" | "retained" | "permanent";

export interface ArtifactRef {
  readonly refId: string;
  readonly artifactKind: ArtifactKind;
  readonly ownershipScope: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly retentionPolicy: RetentionPolicy;
  readonly verified: boolean;
}

export const VERIFIED_ARTIFACT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const R2_KEY_RE = /^[0-9a-f]{32}\/[0-9a-f-]{36}/u;
const PRESIGNED_URL_RE = /[?&](?:X-Amz-Credential|X-Goog-Credential|sig|se)=/iu;
const FILESYSTEM_PATH_RE = /^(?:\/|\\|[A-Za-z]:\\)/u;
const PROVIDER_NATIVE_ID_RE = /^(?:arn:|projects\/|accounts\/)/u;

export function validateArtifactRefId(refId: string): void {
  if (!refId) {
    throw new Error("ArtifactRef must have a non-empty refId");
  }
  if (R2_KEY_RE.test(refId)) {
    throw new Error("ArtifactRef refId must not be an R2 key pattern");
  }
  if (PRESIGNED_URL_RE.test(refId)) {
    throw new Error("ArtifactRef refId must not be a presigned URL");
  }
  if (FILESYSTEM_PATH_RE.test(refId)) {
    throw new Error("ArtifactRef refId must not be a filesystem path");
  }
  if (PROVIDER_NATIVE_ID_RE.test(refId)) {
    throw new Error("ArtifactRef refId must not be a provider-native ID");
  }
}

export function createArtifactRef(
  params: Omit<ArtifactRef, "verified"> & { readonly verified: true },
): ArtifactRef {
  if (params.verified !== true) {
    throw new Error("Cannot create ArtifactRef from unverified upload");
  }
  validateArtifactRefId(params.refId);
  return { ...params };
}

export interface DeploymentExpiryBounds {
  readonly minTtlMs: number;
  readonly maxTtlMs: number;
  readonly operatorCapMs?: number;
}

export function resolveEffectiveExpiry(
  callerTtlMs: number,
  bounds: DeploymentExpiryBounds,
  createdAt: number,
): number {
  let effective = callerTtlMs;
  if (effective < bounds.minTtlMs) {
    effective = bounds.minTtlMs;
  }
  if (effective > bounds.maxTtlMs) {
    effective = bounds.maxTtlMs;
  }
  if (bounds.operatorCapMs !== undefined && effective > bounds.operatorCapMs) {
    effective = bounds.operatorCapMs;
  }
  return createdAt + effective;
}

// -- PRD 667: Artifact processing policy ------------------------------------

export interface ArtifactProcessingPolicy {
  readonly autoExtendRetention: false;
  readonly autoEnrollCorpus: false;
}

export const DEFAULT_ARTIFACT_PROCESSING_POLICY: ArtifactProcessingPolicy = {
  autoExtendRetention: false,
  autoEnrollCorpus: false,
} as const;

export type CleanupAction =
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "failure"; readonly reason: string }
  | { readonly kind: "expiry" }
  | { readonly kind: "delete"; readonly revokeAccess: true }
  | { readonly kind: "orphan"; readonly staleSinceMs: number };

export function validateArtifactProcessingPolicy(policy: ArtifactProcessingPolicy): void {
  if (policy.autoExtendRetention !== false) {
    throw new Error("autoExtendRetention must be false: processing must not auto-extend retention");
  }
  if (policy.autoEnrollCorpus !== false) {
    throw new Error("autoEnrollCorpus must be false: processing must not auto-enroll corpus");
  }
}

// -- PRD 668: URL processing output -----------------------------------------

export interface UrlProcessingOutput {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly fetchedAt: number;
  readonly contentHash: string;
  readonly validator: string;
  readonly redirectChain: readonly string[];
  readonly engine: string;
  readonly truncated: boolean;
  readonly truncationReason: string | null;
}

export function validateSourceIdentityConsistency(
  original: UrlProcessingOutput,
  refetch: UrlProcessingOutput,
): void {
  if (original.contentHash !== refetch.contentHash) {
    throw new Error(
      `Source identity mismatch: content changed between fetches ` +
      `(original hash "${original.contentHash}", refetch hash "${refetch.contentHash}")`,
    );
  }
}

// -- PRD 669: Upload handoff support ----------------------------------------

export interface UploadHandoffSupport {
  readonly clientId: string;
  readonly supportsUploadHandoff: boolean;
  readonly fallbackMethod: "cli" | "dashboard" | null;
}

export function resolveUploadMethod(
  client: UploadHandoffSupport,
): "direct" | "cli" | "dashboard" {
  if (client.supportsUploadHandoff) {
    return "direct";
  }
  if (client.fallbackMethod !== null) {
    return client.fallbackMethod;
  }
  throw new Error(
    `Client "${client.clientId}" does not support upload handoff and has no fallback method`,
  );
}

// -- PRD 670: Staging cleanup -----------------------------------------------

export type StagingCleanupStatus =
  | "active"
  | "logically_deleted"
  | "logically_expired"
  | "physical_cleanup_pending"
  | "cleaned";

export const STAGING_CLEANUP_WINDOW_MS = 3_600_000; // 1 hour

export function validateCleanupWindow(windowMs: number): void {
  if (windowMs > STAGING_CLEANUP_WINDOW_MS) {
    throw new Error(
      `Staging cleanup window ${String(windowMs)}ms exceeds maximum ${String(STAGING_CLEANUP_WINDOW_MS)}ms`,
    );
  }
  if (windowMs <= 0) {
    throw new Error("Staging cleanup window must be positive");
  }
}

export interface StagingObject {
  readonly intentId: string;
  readonly status: StagingCleanupStatus;
  readonly accessRevoked: boolean;
}

export function applyExplicitDelete(staging: StagingObject): StagingObject {
  return {
    ...staging,
    status: "logically_deleted",
    accessRevoked: true,
  };
}

const VALID_TRANSITIONS: Record<StagingCleanupStatus, readonly StagingCleanupStatus[]> = {
  active: ["logically_deleted", "logically_expired", "physical_cleanup_pending"],
  logically_deleted: ["physical_cleanup_pending"],
  logically_expired: ["physical_cleanup_pending"],
  physical_cleanup_pending: ["cleaned"],
  cleaned: [],
};

export function validateStatusTransition(
  from: StagingCleanupStatus,
  to: StagingCleanupStatus,
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid staging status transition: "${from}" -> "${to}"`,
    );
  }
}

// -- PRD 684: Result ArtifactRef with typed artifactKind --------------------

export function validateResultArtifactRef(ref: ArtifactRef): void {
  validateArtifactRefId(ref.refId);
  const validKinds: readonly ArtifactKind[] = ["source", "canonical_document", "projection"];
  if (!validKinds.includes(ref.artifactKind)) {
    throw new Error(`Invalid artifactKind: "${String(ref.artifactKind)}"`);
  }
  if (!ref.verified) {
    throw new Error("Result ArtifactRef must be verified");
  }
}

export function validateDocumentSourceArtifactKind(kind: ArtifactKind): void {
  if (kind !== "source") {
    throw new Error(
      `DocumentSource.artifact only accepts artifactKind="source", got "${kind}"`,
    );
  }
}
