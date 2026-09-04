// ---------------------------------------------------------------------------
// PRD 662, 663, 664, 676, 689 -- DocumentSource, processing limits, policy
// ---------------------------------------------------------------------------

import { GroundlaneError, hint } from "./errors.js";

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

// -- PRD 659 (input part): document processing input runtime -----------------
//
// Pure runtime behind the DocumentSource tagged union. No network, no
// filesystem, no storage credentials. URL inputs are validated only (SSRF
// shape); fetching happens elsewhere. All errors are sanitized
// GroundlaneErrors: they never carry raw bytes, secrets, stacks, or
// unbounded caller strings.

export const DOCUMENT_SNIFF_WINDOW_BYTES = 64 * 1024;
export const DOCUMENT_PAGE_SCAN_MAX_BYTES = 1024 * 1024;
export const DOCUMENT_PAGE_COUNT_HARD_CAP = 5000;
export const DOCUMENT_FILENAME_PREVIEW_CHARS = 64;
export const DOCUMENT_MIME_MAX_CHARS = 128;

export const SUPPORTED_DOCUMENT_MIMES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
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

const OOXML_MIME_TO_FLAVOR: Readonly<Record<string, "ooxml-word" | "ooxml-sheet" | "ooxml-slides">> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "ooxml-word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "ooxml-sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ooxml-slides",
};

const LEGACY_OFFICE_MIMES: readonly string[] = [
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
];

const ARCHIVE_FILENAME_RE = /\.(?:zip|rar|7z|tar|gz|bz2|xz|cbz|cbr)(?:[?#.]|$)/iu;
const OFFICE_FILENAME_RE = /\.(?:docx|xlsx|pptx)$/iu;

export type OfficeFlavor =
  | "ooxml-word"
  | "ooxml-sheet"
  | "ooxml-slides"
  | "legacy-office";

export interface DocumentClassification {
  readonly inputKind: DocumentInputKind;
  readonly sniffedMime: string;
  readonly needsOcr: boolean;
  readonly officeFlavor: OfficeFlavor | null;
}

export interface InlinePreflight {
  readonly accepted: true;
  readonly inputKind: DocumentInputKind;
  readonly sniffedMime: string;
  readonly needsOcr: boolean;
  readonly officeFlavor: OfficeFlavor | null;
  readonly estimatedPages: number | null;
}

export interface DeferredPreflight {
  readonly accepted: true;
  readonly deferred: true;
  readonly inputKindHint: DocumentInputKind | null;
  readonly reason: string;
}

export type DocumentPreflight = InlinePreflight | DeferredPreflight;

function documentInputError(message: string, hintCode: string, hintText: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "document-source", message, false, undefined, hint(hintCode, hintText));
}

function previewFilename(filename: string): string {
  const trimmed = filename.trim().slice(0, DOCUMENT_FILENAME_PREVIEW_CHARS);
  return trimmed || "(unnamed)";
}

function hasBytesAt(data: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (offset < 0 || offset + magic.length > data.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (data[offset + i] !== magic[i]) return false;
  }
  return true;
}

function hasAsciiAt(data: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > data.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function windowContainsAscii(data: Uint8Array, windowBytes: number, needle: string): boolean {
  const limit = Math.min(data.length, windowBytes);
  if (needle.length === 0 || limit < needle.length) return false;
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + needle.length <= limit; i += 1) {
    if (data[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (data[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * PRD 659: bounded magic-number MIME sniffing over the leading bytes only.
 * Returns null when the bytes are not a recognized binary/html signature
 * (e.g. plain UTF-8 text). Never throws, never reads past the window.
 */
export function sniffMimeFromBytes(data: Uint8Array): string | null {
  if (data.length >= 4 && hasBytesAt(data, 0, [0x25, 0x50, 0x44, 0x46])) {
    return "application/pdf";
  }
  if (data.length >= 8 && hasBytesAt(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (data.length >= 3 && hasBytesAt(data, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (data.length >= 6 && (hasAsciiAt(data, 0, "GIF87a") || hasAsciiAt(data, 0, "GIF89a"))) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    hasAsciiAt(data, 0, "RIFF") &&
    hasAsciiAt(data, 8, "WEBP")
  ) {
    return "image/webp";
  }
  if (
    data.length >= 12 &&
    hasAsciiAt(data, 0, "RIFF") &&
    hasAsciiAt(data, 8, "WAVE")
  ) {
    return "audio/wav";
  }
  if (data.length >= 4 && hasBytesAt(data, 0, [0x50, 0x4b, 0x03, 0x04])) {
    return "application/zip";
  }
  if (data.length >= 8 && hasBytesAt(data, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "application/x-ole-storage";
  }
  if (data.length >= 2 && hasBytesAt(data, 0, [0x1f, 0x8b])) {
    return "application/gzip";
  }
  if (data.length >= 4 && hasAsciiAt(data, 0, "Rar!")) {
    return "application/x-rar";
  }
  if (data.length >= 6 && hasBytesAt(data, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return "application/x-7z";
  }
  if (data.length >= 3 && hasAsciiAt(data, 0, "ID3")) {
    return "audio/mpeg";
  }
  if (data.length >= 4 && hasAsciiAt(data, 0, "OggS")) {
    return "audio/ogg";
  }
  // Bounded HTML sniff: skip BOM + leading whitespace, check for doctype/html.
  const headLen = Math.min(data.length, 512);
  let start = 0;
  if (headLen >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    start = 3;
  }
  while (start < headLen && (data[start] === 0x20 || data[start] === 0x09 || data[start] === 0x0a || data[start] === 0x0d)) {
    start += 1;
  }
  const head = new Uint8Array(data.buffer.slice(data.byteOffset + start, data.byteOffset + headLen));
  let headText = "";
  try {
    headText = new TextDecoder("utf-8", { fatal: false }).decode(head).slice(0, 256).toLowerCase();
  } catch {
    return null;
  }
  if (headText.startsWith("<!doctype html") || headText.startsWith("<html")) {
    return "text/html";
  }
  return null;
}

function validateDeclaredMimeShape(declaredMime: string): string {
  const mime = declaredMime.trim();
  if (!mime) {
    throw documentInputError(
      "Inline source must declare a MIME type",
      "document.invalid_mime",
      "Declare one of the supported document MIME types.",
    );
  }
  if (mime.length > DOCUMENT_MIME_MAX_CHARS) {
    throw documentInputError(
      "Declared MIME type exceeds maximum length",
      "document.output_limit",
      "Use a supported document MIME type under 128 characters.",
    );
  }
  return mime;
}

function inputKindForMime(mime: string): DocumentInputKind {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/html") return "html";
  if (mime === "text/plain" || mime === "text/markdown" || mime === "text/csv") return "text";
  if (mime.startsWith("audio/")) return "audio";
  return "office";
}

/**
 * PRD 659: classify bounded bytes with PDF/OCR/Office hints. Rejects
 * encrypted PDFs (/Encrypt), OOXML macros (vbaProject.bin), and generic
 * archives. MIME mismatch between sniff and declaration is a validation
 * error. Sanitized: errors carry truncated filename/MIME labels only.
 */
export function classifyDocumentBytes(
  data: Uint8Array,
  declaredMime: string,
  filename: string,
): DocumentClassification {
  const mime = validateDeclaredMimeShape(declaredMime);
  if (!filename || !filename.trim()) {
    throw documentInputError(
      "Inline source must declare a filename",
      "document.invalid_input",
      "Provide a filename with a supported document extension.",
    );
  }
  const preview = previewFilename(filename);

  if (ARCHIVE_FILENAME_RE.test(filename) && !OFFICE_FILENAME_RE.test(filename)) {
    throw documentInputError(
      `Archive inputs are rejected for file "${preview}"`,
      "document.archive_rejected",
      "Upload a single PDF, image, or Office document instead of an archive.",
    );
  }

  const sniffed = sniffMimeFromBytes(data);

  if (sniffed === "application/gzip" || sniffed === "application/x-rar" || sniffed === "application/x-7z") {
    throw documentInputError(
      `Archive inputs are rejected for file "${preview}"`,
      "document.archive_rejected",
      "Upload a single PDF, image, or Office document instead of an archive.",
    );
  }

  if (sniffed === "application/zip") {
    const flavor = OOXML_MIME_TO_FLAVOR[mime];
    if (flavor === undefined || !OFFICE_FILENAME_RE.test(filename)) {
      throw documentInputError(
        `Archive inputs are rejected for file "${preview}"`,
        "document.archive_rejected",
        "Upload a single Office document (.docx/.xlsx/.pptx) instead of a generic zip.",
      );
    }
    if (windowContainsAscii(data, DOCUMENT_SNIFF_WINDOW_BYTES, "vbaProject.bin")) {
      throw documentInputError(
        `Office macro inputs are rejected for file "${preview}"`,
        "document.macro_rejected",
        "Remove VBA macros and re-upload a macro-free Office document.",
      );
    }
    return { inputKind: "office", sniffedMime: mime, needsOcr: false, officeFlavor: flavor };
  }

  if (sniffed === "application/x-ole-storage") {
    if (!LEGACY_OFFICE_MIMES.includes(mime)) {
      throw documentInputError(
        `MIME type mismatch: declared "${mime}" does not match sniffed legacy Office container`,
        "document.mime_mismatch",
        "Declare the matching legacy Office MIME type for this file.",
      );
    }
    return { inputKind: "office", sniffedMime: mime, needsOcr: false, officeFlavor: "legacy-office" };
  }

  if (sniffed !== null) {
    // For OOXML declared but non-zip leading bytes (truncated fixture), allow
    // the declared OOXML type when the filename matches; macro scan still ran.
    const declaredFlavor = OOXML_MIME_TO_FLAVOR[mime];
    if (declaredFlavor !== undefined && OFFICE_FILENAME_RE.test(filename)) {
      return { inputKind: "office", sniffedMime: mime, needsOcr: false, officeFlavor: declaredFlavor };
    }
    if (sniffed !== mime) {
      // Allow image/jpeg alias image/jpg.
      const normalizedDeclared = mime === "image/jpg" ? "image/jpeg" : mime;
      if (normalizedDeclared !== sniffed) {
        throw documentInputError(
          `MIME type mismatch: declared "${mime}" does not match sniffed "${sniffed}"`,
          "document.mime_mismatch",
          "Declare the MIME type that matches the file bytes.",
        );
      }
    }
    if ((sniffed === "application/pdf" || mime === "application/pdf") &&
      windowContainsAscii(data, DOCUMENT_SNIFF_WINDOW_BYTES, "/Encrypt")) {
      throw documentInputError(
        `Encrypted PDF inputs are rejected for file "${preview}"`,
        "document.encrypted_rejected",
        "Upload an unencrypted PDF without password protection.",
      );
    }
    const kind = inputKindForMime(sniffed === "image/jpg" ? "image/jpeg" : sniffed);
    const officeFlavor: OfficeFlavor | null =
      OOXML_MIME_TO_FLAVOR[mime] ?? (LEGACY_OFFICE_MIMES.includes(mime) ? "legacy-office" : null);
    return {
      inputKind: kind,
      sniffedMime: sniffed,
      needsOcr: kind === "image",
      officeFlavor: kind === "office" ? officeFlavor : null,
    };
  }

  // No binary signature: must be a supported declared type; reject NUL bytes
  // masquerading as text.
  if (!SUPPORTED_DOCUMENT_MIMES.includes(mime) && mime !== "image/jpg") {
    throw documentInputError(
      `Unsupported document MIME type "${mime}"`,
      "document.unsupported_mime",
      "Use one of the supported PDF, image, Office, text, HTML, or audio MIME types.",
    );
  }
  const scanLen = Math.min(data.length, 1024);
  for (let i = 0; i < scanLen; i += 1) {
    if (data[i] === 0x00) {
      throw documentInputError(
        `MIME type mismatch: declared "${mime}" does not match binary content`,
        "document.mime_mismatch",
        "Declare the MIME type that matches the file bytes.",
      );
    }
  }
  if (mime === "application/pdf" && windowContainsAscii(data, DOCUMENT_SNIFF_WINDOW_BYTES, "/Encrypt")) {
    throw documentInputError(
      `Encrypted PDF inputs are rejected for file "${preview}"`,
      "document.encrypted_rejected",
      "Upload an unencrypted PDF without password protection.",
    );
  }
  const kind = inputKindForMime(mime === "image/jpg" ? "image/jpeg" : mime);
  const officeFlavor: OfficeFlavor | null =
    OOXML_MIME_TO_FLAVOR[mime] ?? (LEGACY_OFFICE_MIMES.includes(mime) ? "legacy-office" : null);
  return {
    inputKind: kind,
    sniffedMime: mime,
    needsOcr: kind === "image",
    officeFlavor: kind === "office" ? officeFlavor : null,
  };
}

/**
 * PRD 659: bounded PDF page estimate. Counts `/Type /Page` (not `/Pages`)
 * occurrences in the first 1 MiB, capped at the hard cap. Returns 0 for
 * non-PDF or empty inputs. Deterministic and allocation-bounded.
 */
export function estimatePdfPages(data: Uint8Array): number {
  const scanLen = Math.min(data.length, DOCUMENT_PAGE_SCAN_MAX_BYTES);
  if (scanLen === 0) return 0;
  let text = "";
  try {
    text = new TextDecoder("latin1").decode(data.slice(0, scanLen));
  } catch {
    return 0;
  }
  const re = /\/Type\s*\/Page(?![sA-Za-z])/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    void match;
    count += 1;
    if (count >= DOCUMENT_PAGE_COUNT_HARD_CAP) return DOCUMENT_PAGE_COUNT_HARD_CAP;
    // Guard against pathological zero-width loops.
    if (re.lastIndex === match.index) re.lastIndex += 1;
  }
  return count;
}

/**
 * PRD 659: enforce caller-visible byte/page limits. No clamping: over-limit
 * inputs are validation errors with bounded counts only.
 */
export function validateDocumentByteLimits(
  data: Uint8Array,
  limits: DocumentProcessingLimits,
  estimatedPages?: number,
): void {
  if (data.byteLength > limits.maxBytes) {
    throw documentInputError(
      `Document bytes exceed limit: ${String(data.byteLength)} > ${String(limits.maxBytes)}`,
      "document.output_limit",
      "Upload a smaller document or raise maxBytes within the announced caps.",
    );
  }
  const pages = estimatedPages ?? 0;
  if (pages > limits.maxPages) {
    throw documentInputError(
      `Document pages exceed limit: ${String(pages)} > ${String(limits.maxPages)}`,
      "document.output_limit",
      "Upload a shorter document or raise maxPages within the announced caps.",
    );
  }
}

/**
 * PRD 659: inline preflight runs validation + sniff/classify + limits with
 * no network or storage access.
 */
export function preflightInlineSource(
  source: InlineSource,
  limits: DocumentProcessingLimits,
): InlinePreflight {
  validateInlineSource(source);
  validateProcessingLimits(limits);
  const classification = classifyDocumentBytes(source.data, source.declaredMime, source.filename);
  const estimatedPages =
    classification.inputKind === "pdf" ? estimatePdfPages(source.data) : null;
  validateDocumentByteLimits(source.data, limits, estimatedPages ?? 0);
  return {
    accepted: true,
    inputKind: classification.inputKind,
    sniffedMime: classification.sniffedMime,
    needsOcr: classification.needsOcr,
    officeFlavor: classification.officeFlavor,
    estimatedPages,
  };
}

function hintFromUrlPath(url: string): DocumentInputKind | null {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (path.endsWith(".pdf")) return "pdf";
  if (
    path.endsWith(".png") ||
    path.endsWith(".jpg") ||
    path.endsWith(".jpeg") ||
    path.endsWith(".webp") ||
    path.endsWith(".gif") ||
    path.endsWith(".tiff") ||
    path.endsWith(".tif")
  ) {
    return "image";
  }
  if (
    path.endsWith(".docx") ||
    path.endsWith(".xlsx") ||
    path.endsWith(".pptx") ||
    path.endsWith(".doc") ||
    path.endsWith(".xls") ||
    path.endsWith(".ppt") ||
    path.endsWith(".csv")
  ) {
    return "office";
  }
  if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
  if (path.endsWith(".txt") || path.endsWith(".md") || path.endsWith(".markdown")) return "text";
  if (
    path.endsWith(".mp3") ||
    path.endsWith(".wav") ||
    path.endsWith(".ogg") ||
    path.endsWith(".m4a")
  ) {
    return "audio";
  }
  return null;
}

/**
 * PRD 659: union preflight. Inline is fully classified now; URL and artifact
 * inputs are shape-validated and deferred (fetch/storage happens elsewhere),
 * with only an extension-based hint for URLs. Never fetches, never reads
 * storage, never accepts local paths or credentials (via validateUrlSource).
 */
export function preflightDocumentSource(
  source: DocumentSource,
  limits: DocumentProcessingLimits,
): DocumentPreflight {
  validateProcessingLimits(limits);
  switch (source.kind) {
    case "inline":
      return preflightInlineSource(source, limits);
    case "url": {
      validateUrlSource(source);
      return {
        accepted: true,
        deferred: true,
        inputKindHint: hintFromUrlPath(source.url),
        reason: "fetch-required",
      };
    }
    case "artifact": {
      validateArtifactSource(source);
      return {
        accepted: true,
        deferred: true,
        inputKindHint: null,
        reason: "artifact-read-required",
      };
    }
    default: {
      const _exhaustive: never = source;
      throw documentInputError(
        `Unknown DocumentSource kind: "${String(_exhaustive)}"`,
        "document.invalid_input",
        "Use one of the supported DocumentSource kinds.",
      );
    }
  }
}

/**
 * PRD 659/663: a transient cache entry must never be presented where a
 * durable ArtifactRef is required. Use this guard at every artifact boundary.
 */
export function requireDurableForArtifact(
  entry: TransientCacheEntry | DurableArtifactRefEntry,
): DurableArtifactRefEntry {
  if (isTransientCacheEntry(entry)) {
    throw documentInputError(
      "Transient cache entry cannot be used as a durable ArtifactRef",
      "document.transient_as_durable",
      "Finalize an upload to a verified ArtifactRef before using it as a document source.",
    );
  }
  return entry;
}
