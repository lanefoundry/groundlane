// ---------------------------------------------------------------------------
// PRD 665, 666, 667, 668, 669, 670, 684 -- Upload intent, ArtifactRef
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { GroundlaneError, hint } from "./errors.js";

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

// -- PRD 660: Cloudflare upload flow runtime (in-memory/fake-storage port) ---
//
// Flow: create intent -> direct single PUT -> complete/verify/finalize ->
// verified immutable final object + opaque ArtifactRef. No live R2; the
// storage port below is the deployment boundary (Cloudflare maps it to R2).
// All new errors are sanitized GroundlaneErrors: no secrets, raw bodies,
// presigned URLs, or storage keys in messages.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const MAX_INTENT_ID_CHARS = 128;
export const MAX_MIME_CHARS = 128;
export const MAX_OWNERSHIP_SCOPE_CHARS = 64;
export const MAX_STAGING_ENTRIES = 1000;

export const ALLOWED_UPLOAD_MIMES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
];

export interface CreateUploadIntentInput {
  readonly ownershipScope: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly maxSize?: number;
  readonly expectedDigest?: string | null;
  readonly ttlMs?: number;
  readonly intentId?: string;
  readonly multipart?: boolean;
}

export interface FinalizeOverrides {
  readonly contentHash?: string;
  readonly sniffedMime?: string;
}

function uploadInputError(message: string, hintCode: string, hintText: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "upload-intent", message, false, undefined, hint(hintCode, hintText));
}

function assertBoundedOwnershipScope(scope: string): void {
  if (!scope || !scope.trim()) {
    throw uploadInputError(
      "Upload intent must have a non-empty ownershipScope",
      "upload.invalid_input",
      "Provide a non-empty ownershipScope for the upload intent.",
    );
  }
  if (scope.length > MAX_OWNERSHIP_SCOPE_CHARS) {
    throw uploadInputError(
      "ownershipScope exceeds maximum length",
      "upload.output_limit",
      "Use an ownershipScope under 64 characters.",
    );
  }
}

function assertUploadMime(mime: string): string {
  const trimmed = mime.trim();
  if (!trimmed) {
    throw uploadInputError(
      "Upload intent must declare a MIME type",
      "upload.invalid_mime",
      "Declare one of the supported document MIME types.",
    );
  }
  if (trimmed.length > MAX_MIME_CHARS) {
    throw uploadInputError(
      "Declared MIME type exceeds maximum length",
      "upload.output_limit",
      "Use a supported MIME type under 128 characters.",
    );
  }
  if (!ALLOWED_UPLOAD_MIMES.includes(trimmed)) {
    throw uploadInputError(
      `Unsupported upload MIME type "${trimmed}"`,
      "upload.unsupported_mime",
      "Use one of the supported PDF, image, Office, text, HTML, or audio MIME types.",
    );
  }
  return trimmed;
}

function sniffUploadMime(data: Uint8Array): string | null {
  if (data.length >= 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
    return "application/pdf";
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const g =
      String.fromCharCode(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0, data[4] ?? 0, data[5] ?? 0);
    if (g === "GIF87a" || g === "GIF89a") return "image/gif";
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return "image/webp";
  }
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return "application/zip";
  }
  if (
    data.length >= 8 &&
    data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0
  ) {
    return "application/x-ole-storage";
  }
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return "application/gzip";
  }
  return null;
}

function normalizeMimeForCompare(mime: string): string {
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function isOoxmlMime(mime: string): boolean {
  return (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
}

function checkSniffMatchesDeclared(sniffed: string | null, declared: string): void {
  if (sniffed === null) return;
  if (sniffed === "application/gzip") {
    throw uploadInputError(
      "Archive content rejected on complete",
      "upload.archive_rejected",
      "Upload a single document instead of an archive.",
    );
  }
  if (sniffed === "application/zip") {
    if (!isOoxmlMime(declared)) {
      throw uploadInputError(
        `MIME type mismatch: declared "${declared}" does not match archive content`,
        "upload.mime_mismatch",
        "Declare the matching Office MIME type or upload a non-archive document.",
      );
    }
    return;
  }
  if (sniffed === "application/x-ole-storage") {
    if (
      declared !== "application/msword" &&
      declared !== "application/vnd.ms-excel" &&
      declared !== "application/vnd.ms-powerpoint"
    ) {
      throw uploadInputError(
        `MIME type mismatch: declared "${declared}" does not match legacy Office content`,
        "upload.mime_mismatch",
        "Declare the matching legacy Office MIME type.",
      );
    }
    return;
  }
  if (normalizeMimeForCompare(declared) !== normalizeMimeForCompare(sniffed)) {
    throw uploadInputError(
      `MIME type mismatch: declared "${declared}", sniffed "${sniffed}"`,
      "upload.mime_mismatch",
      "Re-upload with the declared MIME type matching the file bytes.",
    );
  }
}

export function hashUploadBytes(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Storage port boundary. Cloudflare deployment maps this to R2; tests and
 * local runs use the in-memory fake below. The port never exposes keys,
 * presigned URLs, or paths to callers — only opaque intent/ref IDs.
 */
export interface UploadBlobStoragePort {
  readonly storageName: "in-memory-fake";
  putStaging(intentId: string, bytes: Uint8Array): void;
  getStaging(intentId: string): Uint8Array | null;
  deleteStaging(intentId: string): void;
  putFinal(refId: string, bytes: Uint8Array): void;
  getFinal(refId: string): Uint8Array | null;
  deleteFinal(refId: string): void;
}

export class InMemoryUploadBlobStorage implements UploadBlobStoragePort {
  readonly storageName = "in-memory-fake" as const;
  private readonly staging = new Map<string, Uint8Array>();
  private readonly finals = new Map<string, Uint8Array>();

  putStaging(intentId: string, bytes: Uint8Array): void {
    if (this.staging.size >= MAX_STAGING_ENTRIES && !this.staging.has(intentId)) {
      throw uploadInputError(
        "Staging store is full",
        "upload.output_limit",
        "Complete or expire pending intents before creating new ones.",
      );
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw uploadInputError(
        `Staging bytes exceed limit: ${String(bytes.byteLength)} > ${String(MAX_UPLOAD_BYTES)}`,
        "upload.output_limit",
        "Upload a smaller document.",
      );
    }
    this.staging.set(intentId, bytes.slice());
  }

  getStaging(intentId: string): Uint8Array | null {
    const found = this.staging.get(intentId);
    return found === undefined ? null : found.slice();
  }

  deleteStaging(intentId: string): void {
    this.staging.delete(intentId);
  }

  putFinal(refId: string, bytes: Uint8Array): void {
    if (this.finals.has(refId)) {
      throw uploadInputError(
        "Cannot overwrite a finalized object",
        "upload.invalid_input",
        "Final objects are immutable; create a new intent for new content.",
      );
    }
    this.finals.set(refId, bytes.slice());
  }

  getFinal(refId: string): Uint8Array | null {
    const found = this.finals.get(refId);
    return found === undefined ? null : found.slice();
  }

  deleteFinal(refId: string): void {
    this.finals.delete(refId);
  }
}

interface StoredIntent {
  intent: UploadIntent;
  hasPut: boolean;
}

/**
 * PRD 660: in-memory upload flow runtime. Create enforces content
 * length/MIME/expiry/ownership/single-PUT shape; complete verifies
 * size/MIME-sniff/content-hash/ownership/expiry/replay before promoting the
 * staging bytes to an immutable final object and minting a storage-neutral
 * opaque ArtifactRef (verified=true). Multipart is always rejected in V1.
 */
export class UploadFlowStore {
  private seq = 0;
  private readonly intents = new Map<string, StoredIntent>();
  private readonly refs = new Map<string, ArtifactRef>();

  constructor(private readonly storage: UploadBlobStoragePort = new InMemoryUploadBlobStorage()) {}

  createIntent(input: CreateUploadIntentInput, nowMs: number): UploadIntent {
    assertBoundedOwnershipScope(input.ownershipScope);
    const declaredMime = assertUploadMime(input.declaredMime);
    if (!Number.isInteger(input.declaredSize) || input.declaredSize <= 0) {
      throw uploadInputError(
        "Upload intent declaredSize must be a positive integer",
        "upload.invalid_input",
        "Provide a positive integer declaredSize.",
      );
    }
    const maxSize = input.maxSize ?? MAX_UPLOAD_BYTES;
    if (!Number.isInteger(maxSize) || maxSize <= 0 || maxSize > MAX_UPLOAD_BYTES) {
      throw uploadInputError(
        `Upload maxSize must be a positive integer at most ${String(MAX_UPLOAD_BYTES)}`,
        "upload.output_limit",
        "Choose a maxSize within the announced upload caps.",
      );
    }
    if (input.declaredSize > maxSize) {
      throw uploadInputError(
        `Declared size ${String(input.declaredSize)} exceeds max size ${String(maxSize)}`,
        "upload.output_limit",
        "Raise maxSize within caps or upload a smaller document.",
      );
    }
    const ttlMs = input.ttlMs ?? UPLOAD_INTENT_DEFAULT_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_UPLOAD_TTL_MS) {
      throw uploadInputError(
        "Upload intent TTL must be a positive integer within caps",
        "upload.invalid_input",
        "Use a TTL between 1ms and 1 hour.",
      );
    }
    if (input.intentId !== undefined && (!input.intentId || input.intentId.length > MAX_INTENT_ID_CHARS)) {
      throw uploadInputError(
        "Upload intent must have a non-empty intentId within bounds",
        "upload.invalid_input",
        "Provide a non-empty intentId under 128 characters.",
      );
    }
    this.seq += 1;
    const intentId =
      input.intentId ??
      `intent_${this.seq.toString(16).padStart(4, "0")}${createHash("sha256").update(`intent:${String(this.seq)}:${String(nowMs)}`).digest("hex").slice(0, 12)}`;
    if (this.intents.has(intentId)) {
      throw uploadInputError(
        "Upload intent already exists",
        "upload.invalid_input",
        "Create a new intent instead of reusing an intent ID.",
      );
    }
    const multipart = input.multipart ?? false;
    const intent: UploadIntent = {
      intentId,
      ownershipScope: input.ownershipScope,
      declaredMime,
      declaredSize: input.declaredSize,
      maxSize,
      expectedDigest: input.expectedDigest ?? null,
      expiresAt: nowMs + ttlMs,
      status: "pending",
      multipart: multipart as false,
    };
    validateCreateIntent(intent, nowMs);
    this.intents.set(intentId, { intent, hasPut: false });
    return intent;
  }

  recordPut(intentId: string, callerScope: string, bytes: Uint8Array, nowMs: number): void {
    const stored = this.requireIntent(intentId);
    validateCrossOwnership(stored.intent, callerScope);
    if (nowMs >= stored.intent.expiresAt) {
      this.markStatus(intentId, "expired");
      throw uploadInputError(
        "Upload intent has expired",
        "upload.expired",
        "Create a new intent and re-upload within 15 minutes.",
      );
    }
    if (stored.intent.status === "finalized") {
      throw uploadInputError(
        "Cannot overwrite a finalized staging object",
        "upload.invalid_input",
        "Final objects are immutable; create a new intent.",
      );
    }
    if (stored.intent.status === "expired" || stored.intent.status === "failed") {
      throw uploadInputError(
        "Upload intent is no longer writable",
        "upload.invalid_input",
        "Create a new intent and re-upload.",
      );
    }
    if (stored.hasPut) {
      throw uploadInputError(
        "Cannot overwrite a staging object: V1 supports a single PUT per intent",
        "upload.invalid_input",
        "Create a new intent for new content.",
      );
    }
    if (bytes.byteLength > stored.intent.maxSize) {
      throw uploadInputError(
        `Actual size ${String(bytes.byteLength)} exceeds max size ${String(stored.intent.maxSize)}`,
        "upload.output_limit",
        "Upload a smaller document or raise maxSize within caps.",
      );
    }
    this.storage.putStaging(intentId, bytes);
    this.markStatus(intentId, "uploading");
    stored.hasPut = true;
  }

  completeAndFinalize(
    intentId: string,
    callerScope: string,
    nowMs: number,
    overrides?: FinalizeOverrides,
  ): ArtifactRef {
    const stored = this.requireIntent(intentId);
    validateCrossOwnership(stored.intent, callerScope);
    if (stored.intent.status === "finalized") {
      throw uploadInputError(
        "Cannot overwrite a finalized staging object",
        "upload.invalid_input",
        "Final objects are immutable; create a new intent.",
      );
    }
    const staged = this.storage.getStaging(intentId);
    if (staged === null) {
      throw uploadInputError(
        "Staging object not found for intent",
        "upload.invalid_input",
        "PUT the bytes before completing the upload.",
      );
    }
    const actualSize = staged.byteLength;
    const sniffed = overrides?.sniffedMime ?? sniffUploadMime(staged) ?? stored.intent.declaredMime;
    const contentHash = overrides?.contentHash ?? hashUploadBytes(staged);
    const req = { intentId, actualSize, sniffedMime: sniffed, contentHash };
    try {
      validateCompleteUpload(stored.intent, req, nowMs);
    } catch (error) {
      if (error instanceof Error && /expired/i.test(error.message)) {
        this.markStatus(intentId, "expired");
      }
      throw error;
    }
    // verify() stage: sniff + hash + size already validated above; enforce
    // archive/shape rules without leaking raw bytes.
    checkSniffMatchesDeclared(sniffUploadMime(staged), stored.intent.declaredMime);
    if (stored.intent.expectedDigest !== null && contentHash !== stored.intent.expectedDigest) {
      throw uploadInputError(
        `Content hash mismatch: expected "${stored.intent.expectedDigest}", got "${contentHash}"`,
        "upload.hash_mismatch",
        "Re-upload the exact bytes matching the declared digest.",
      );
    }
    this.seq += 1;
    const refId = `art_${createHash("sha256").update(`${intentId}:${contentHash}:${String(this.seq)}`).digest("hex").slice(0, 32)}`;
    validateArtifactRefId(refId);
    const ref = createArtifactRef({
      refId,
      artifactKind: "source",
      ownershipScope: stored.intent.ownershipScope,
      contentHash,
      byteSize: actualSize,
      createdAt: nowMs,
      expiresAt: nowMs + VERIFIED_ARTIFACT_DEFAULT_TTL_MS,
      retentionPolicy: "transient",
      verified: true,
    });
    // finalize(): promote staging -> immutable final, then clear staging.
    this.storage.putFinal(refId, staged);
    this.storage.deleteStaging(intentId);
    this.markStatus(intentId, "finalized");
    this.refs.set(refId, ref);
    return ref;
  }

  markFailed(intentId: string): void {
    this.markStatus(intentId, "failed");
    this.storage.deleteStaging(intentId);
  }

  getIntent(intentId: string): UploadIntent | null {
    return this.intents.get(intentId)?.intent ?? null;
  }

  getFinalRef(refId: string): ArtifactRef | null {
    return this.refs.get(refId) ?? null;
  }

  getFinalBytes(refId: string): Uint8Array | null {
    return this.storage.getFinal(refId);
  }

  private requireIntent(intentId: string): StoredIntent {
    const stored = this.intents.get(intentId);
    if (stored === undefined) {
      throw uploadInputError(
        "Unknown upload intent",
        "upload.invalid_input",
        "Create an intent before PUT or complete.",
      );
    }
    return stored;
  }

  private markStatus(intentId: string, status: UploadIntentStatus): void {
    const stored = this.intents.get(intentId);
    if (stored === undefined) return;
    stored.intent = { ...stored.intent, status };
  }
}
