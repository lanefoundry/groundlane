// ---------------------------------------------------------------------------
// PRD 662, 663, 664, 676, 689 -- DocumentSource, processing limits, policy
// ---------------------------------------------------------------------------

// -- PRD 662: Document input kinds, processing limits, sandbox, confidence ---

export type DocumentInputKind =
  | "pdf"
  | "image"
  | "office"
  | "audio"
  | "html"
  | "text";

export interface DocumentProcessingLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxTimeMs: number;
  readonly maxMemoryMb: number;
}

export interface SandboxPermissions {
  readonly allowNetwork: false;
  readonly allowFilesystem: false;
  readonly allowSubprocess: false;
}

export const SANDBOX_DEFAULTS: SandboxPermissions = {
  allowNetwork: false,
  allowFilesystem: false,
  allowSubprocess: false,
} as const;

export type ConfidenceSource = "ocr" | "vlm" | "parser" | "model";

export interface ConfidenceSpan {
  readonly blockId: string;
  readonly confidence: number; // 0..1
  readonly source: ConfidenceSource;
}

export interface ModelArtifactPolicy {
  readonly allowModelFallback: boolean;
}

export function validateProcessingLimits(limits: DocumentProcessingLimits): void {
  if (limits.maxBytes <= 0) {
    throw new Error("maxBytes must be positive");
  }
  if (limits.maxPages <= 0) {
    throw new Error("maxPages must be positive");
  }
  if (limits.maxTimeMs <= 0) {
    throw new Error("maxTimeMs must be positive");
  }
  if (limits.maxMemoryMb <= 0) {
    throw new Error("maxMemoryMb must be positive");
  }
}

export function validateConfidenceSpan(span: ConfidenceSpan): void {
  if (!span.blockId) {
    throw new Error("ConfidenceSpan must have a non-empty blockId");
  }
  if (span.confidence < 0 || span.confidence > 1) {
    throw new Error("ConfidenceSpan confidence must be between 0 and 1");
  }
  const validSources: readonly ConfidenceSource[] = ["ocr", "vlm", "parser", "model"];
  if (!validSources.includes(span.source)) {
    throw new Error(`ConfidenceSpan source must be one of: ${validSources.join(", ")}`);
  }
}

export function validateModelArtifactPolicy(policy: ModelArtifactPolicy): void {
  if (policy.allowModelFallback !== true && policy.allowModelFallback !== false) {
    throw new Error("allowModelFallback must be an explicit boolean");
  }
}

// -- PRD 663: Processing output mode, transient vs durable guards -----------

export type ProcessingOutputMode = "normalized" | "artifact";

export interface TransientCacheEntry {
  readonly kind: "transient_cache";
  readonly contentHash: string;
  readonly expiresAt: number;
  readonly isCorpusSource?: undefined;
}

export interface DurableArtifactRefEntry {
  readonly kind: "durable_artifact";
  readonly refId: string;
  readonly ownershipScope: string;
  readonly isCorpusSource?: boolean;
}

export function isTransientCacheEntry(
  entry: TransientCacheEntry | DurableArtifactRefEntry,
): entry is TransientCacheEntry {
  return entry.kind === "transient_cache";
}

export function isDurableArtifactRef(
  entry: TransientCacheEntry | DurableArtifactRefEntry,
): entry is DurableArtifactRefEntry {
  return entry.kind === "durable_artifact";
}

export function validateCacheEntry(entry: TransientCacheEntry | DurableArtifactRefEntry): void {
  if (isTransientCacheEntry(entry) && entry.isCorpusSource !== undefined) {
    throw new Error("Transient cache entries must not carry corpus source flags");
  }
}

// -- PRD 664: DocumentSource tagged union -----------------------------------

export interface InlineSource {
  readonly kind: "inline";
  readonly data: Uint8Array;
  readonly declaredMime: string;
  readonly filename: string;
}

export interface UrlSource {
  readonly kind: "url";
  readonly url: string;
}

export interface ArtifactSource {
  readonly kind: "artifact";
  readonly refId: string;
  readonly ownershipScope: string;
  readonly artifactKind: "source";
}

export type DocumentSource = InlineSource | UrlSource | ArtifactSource;

const LOCAL_PATH_RE = /^(?:\/|\\|[A-Za-z]:\\|\.\.?[/\\])/u;
const BUCKET_KEY_RE = /^(?:s3|gs|az|r2):\/\//iu;
const CREDENTIAL_URL_RE = /^https?:\/\/[^@/]*:[^@/]*@/u;
const R2_KEY_RE = /^[0-9a-f]{32}\/[0-9a-f-]{36}/u;
const PRESIGNED_URL_RE = /[?&](?:X-Amz-Credential|X-Goog-Credential|sig|se)=/iu;

export const INLINE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export function validateInlineSource(source: InlineSource): void {
  if (source.data.byteLength > INLINE_MAX_BYTES) {
    throw new Error(
      `Inline source exceeds max size: ${String(source.data.byteLength)} > ${String(INLINE_MAX_BYTES)}`,
    );
  }
  if (!source.declaredMime) {
    throw new Error("Inline source must declare a MIME type");
  }
  if (!source.filename) {
    throw new Error("Inline source must declare a filename");
  }
}

export function validateUrlSource(source: UrlSource): void {
  const raw = source.url;

  if (LOCAL_PATH_RE.test(raw)) {
    throw new Error(`URL source must not be a local path: "${raw}"`);
  }
  if (BUCKET_KEY_RE.test(raw)) {
    throw new Error(`URL source must not be a bucket/object key: "${raw}"`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`URL source is not a valid URL: "${raw}"`);
  }

  if (parsed.protocol === "file:") {
    throw new Error(`URL source must not use file:// protocol: "${raw}"`);
  }
  if (parsed.protocol === "ftp:") {
    throw new Error(`URL source must not use ftp:// protocol: "${raw}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`URL source must use HTTPS: "${raw}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`URL source must not contain credentials: "${raw}"`);
  }
  if (CREDENTIAL_URL_RE.test(raw)) {
    throw new Error(`URL source must not contain credentials: "${raw}"`);
  }
}

export function validateArtifactSource(source: ArtifactSource): void {
  if (!source.refId) {
    throw new Error("Artifact source must have a non-empty refId");
  }
  if (R2_KEY_RE.test(source.refId)) {
    throw new Error("Artifact source refId must not be an R2 key");
  }
  if (PRESIGNED_URL_RE.test(source.refId)) {
    throw new Error("Artifact source refId must not be a presigned URL");
  }
  if (!source.ownershipScope) {
    throw new Error("Artifact source must have a non-empty ownershipScope");
  }
  if (source.artifactKind !== "source") {
    throw new Error(
      `DocumentSource.artifact only accepts artifactKind="source", got "${String(source.artifactKind)}"`,
    );
  }
}

export function validateDocumentSource(source: DocumentSource): void {
  switch (source.kind) {
    case "inline":
      validateInlineSource(source);
      return;
    case "url":
      validateUrlSource(source);
      return;
    case "artifact":
      validateArtifactSource(source);
      return;
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unknown DocumentSource kind: "${String(_exhaustive)}"`);
    }
  }
}

// -- PRD 676: Document policy (read-only capability view) -------------------

export interface DocumentPolicy {
  readonly cacheEnabled: boolean;
  readonly cacheMode: "passthrough" | "read" | "readwrite";
  readonly uploadDefaults: { readonly maxSizeBytes: number; readonly ttlSeconds: number };
  readonly uploadMin: { readonly ttlSeconds: number };
  readonly uploadMax: { readonly ttlSeconds: number };
  readonly artifactDefaults: { readonly ttlSeconds: number };
  readonly artifactMin: { readonly ttlSeconds: number };
  readonly artifactMax: { readonly ttlSeconds: number };
  readonly stagingCleanupWindowMs: number;
  readonly corpusRetentionDefaults: { readonly ttlSeconds: number };
  readonly ownershipScopeCaps: readonly string[];
}

export interface ExpiryRequest {
  readonly relativeTtlSeconds?: number;
  readonly absoluteExpiresAt?: number;
}

export interface ExpiryBounds {
  readonly minTtlSeconds: number;
  readonly maxTtlSeconds: number;
}

export function validateExpiryRequest(
  req: ExpiryRequest,
  bounds: ExpiryBounds,
  nowMs: number,
): number {
  if (req.relativeTtlSeconds !== undefined && req.absoluteExpiresAt !== undefined) {
    throw new Error("Relative and absolute expiry are mutually exclusive");
  }
  if (req.relativeTtlSeconds === undefined && req.absoluteExpiresAt === undefined) {
    throw new Error("Either relativeTtlSeconds or absoluteExpiresAt must be provided");
  }

  let effectiveTtl: number;
  if (req.relativeTtlSeconds !== undefined) {
    effectiveTtl = req.relativeTtlSeconds;
  } else {
    effectiveTtl = Math.floor((req.absoluteExpiresAt! - nowMs) / 1000);
  }

  if (effectiveTtl < bounds.minTtlSeconds) {
    throw new Error(
      `Requested TTL ${String(effectiveTtl)}s is below minimum ${String(bounds.minTtlSeconds)}s`,
    );
  }
  if (effectiveTtl > bounds.maxTtlSeconds) {
    throw new Error(
      `Requested TTL ${String(effectiveTtl)}s exceeds maximum ${String(bounds.maxTtlSeconds)}s`,
    );
  }

  return nowMs + effectiveTtl * 1000;
}

// -- PRD 689: Parse backward compatibility contract -------------------------

export interface ParseCompatibilityContract {
  readonly schemaVersion: string;
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
}

export function validateParseBackwardCompat(
  previous: ParseCompatibilityContract,
  next: ParseCompatibilityContract,
): void {
  for (const field of previous.requiredFields) {
    if (!next.requiredFields.includes(field)) {
      throw new Error(
        `Backward compatibility violation: required field "${field}" was removed in schema ${next.schemaVersion}`,
      );
    }
  }
}
