import assert from "node:assert/strict";
import test from "node:test";

import {
  INLINE_MAX_BYTES,
  SANDBOX_DEFAULTS,
  isTransientCacheEntry,
  isDurableArtifactRef,
  validateCacheEntry,
  validateConfidenceSpan,
  validateDocumentSource,
  validateExpiryRequest,
  validateInlineSource,
  validateModelArtifactPolicy,
  validateParseBackwardCompat,
  validateProcessingLimits,
  validateUrlSource,
  validateArtifactSource,
  type ArtifactSource,
  type ConfidenceSpan,
  type DocumentPolicy,
  type DocumentProcessingLimits,
  type DurableArtifactRefEntry,
  type ExpiryBounds,
  type ExpiryRequest,
  type InlineSource,
  type ModelArtifactPolicy,
  type ParseCompatibilityContract,
  type TransientCacheEntry,
  type UrlSource,
} from "../../src/core/document-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInline(overrides?: Partial<InlineSource>): InlineSource {
  return {
    kind: "inline",
    data: new Uint8Array(128),
    declaredMime: "application/pdf",
    filename: "test.pdf",
    ...overrides,
  };
}

function makeUrl(url = "https://example.com/doc.pdf"): UrlSource {
  return { kind: "url", url };
}

function makeArtifact(overrides?: Partial<ArtifactSource>): ArtifactSource {
  return {
    kind: "artifact",
    refId: "art_abc123",
    ownershipScope: "deploy_prod",
    artifactKind: "source",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 662: Document input kinds, processing limits, sandbox, confidence
// ---------------------------------------------------------------------------

void test("PRD 662: valid processing limits accepted", () => {
  const limits: DocumentProcessingLimits = {
    maxBytes: 50_000_000,
    maxPages: 200,
    maxTimeMs: 30_000,
    maxMemoryMb: 512,
  };
  assert.doesNotThrow(() => validateProcessingLimits(limits));
});

void test("PRD 662: zero maxBytes rejected", () => {
  assert.throws(
    () => validateProcessingLimits({ maxBytes: 0, maxPages: 1, maxTimeMs: 1, maxMemoryMb: 1 }),
    { message: /maxBytes must be positive/ },
  );
});

void test("PRD 662: negative maxPages rejected", () => {
  assert.throws(
    () => validateProcessingLimits({ maxBytes: 1, maxPages: -1, maxTimeMs: 1, maxMemoryMb: 1 }),
    { message: /maxPages must be positive/ },
  );
});

void test("PRD 662: zero maxTimeMs rejected", () => {
  assert.throws(
    () => validateProcessingLimits({ maxBytes: 1, maxPages: 1, maxTimeMs: 0, maxMemoryMb: 1 }),
    { message: /maxTimeMs must be positive/ },
  );
});

void test("PRD 662: zero maxMemoryMb rejected", () => {
  assert.throws(
    () => validateProcessingLimits({ maxBytes: 1, maxPages: 1, maxTimeMs: 1, maxMemoryMb: 0 }),
    { message: /maxMemoryMb must be positive/ },
  );
});

void test("PRD 662: sandbox defaults all false", () => {
  assert.equal(SANDBOX_DEFAULTS.allowNetwork, false);
  assert.equal(SANDBOX_DEFAULTS.allowFilesystem, false);
  assert.equal(SANDBOX_DEFAULTS.allowSubprocess, false);
});

void test("PRD 662: valid confidence span accepted", () => {
  const span: ConfidenceSpan = { blockId: "block-1", confidence: 0.95, source: "ocr" };
  assert.doesNotThrow(() => validateConfidenceSpan(span));
});

void test("PRD 662: confidence span with empty blockId rejected", () => {
  assert.throws(
    () => validateConfidenceSpan({ blockId: "", confidence: 0.5, source: "parser" }),
    { message: /non-empty blockId/ },
  );
});

void test("PRD 662: confidence span out of range rejected (>1)", () => {
  assert.throws(
    () => validateConfidenceSpan({ blockId: "b1", confidence: 1.5, source: "ocr" }),
    { message: /between 0 and 1/ },
  );
});

void test("PRD 662: confidence span out of range rejected (<0)", () => {
  assert.throws(
    () => validateConfidenceSpan({ blockId: "b1", confidence: -0.1, source: "vlm" }),
    { message: /between 0 and 1/ },
  );
});

void test("PRD 662: confidence span boundary values accepted (0 and 1)", () => {
  assert.doesNotThrow(() => validateConfidenceSpan({ blockId: "b1", confidence: 0, source: "ocr" }));
  assert.doesNotThrow(() => validateConfidenceSpan({ blockId: "b1", confidence: 1, source: "model" }));
});

void test("PRD 662: model artifact policy requires explicit boolean", () => {
  const policy: ModelArtifactPolicy = { allowModelFallback: false };
  assert.doesNotThrow(() => validateModelArtifactPolicy(policy));
  const optIn: ModelArtifactPolicy = { allowModelFallback: true };
  assert.doesNotThrow(() => validateModelArtifactPolicy(optIn));
});

// ---------------------------------------------------------------------------
// PRD 663: Processing output mode, transient vs durable
// ---------------------------------------------------------------------------

void test("PRD 663: isTransientCacheEntry identifies transient entries", () => {
  const entry: TransientCacheEntry = {
    kind: "transient_cache",
    contentHash: "sha256-abc",
    expiresAt: Date.now() + 60_000,
  };
  assert.equal(isTransientCacheEntry(entry), true);
  assert.equal(isDurableArtifactRef(entry), false);
});

void test("PRD 663: isDurableArtifactRef identifies durable entries", () => {
  const entry: DurableArtifactRefEntry = {
    kind: "durable_artifact",
    refId: "art_123",
    ownershipScope: "deploy_prod",
    isCorpusSource: true,
  };
  assert.equal(isDurableArtifactRef(entry), true);
  assert.equal(isTransientCacheEntry(entry), false);
});

void test("PRD 663: transient cache entry with corpus source flag rejected", () => {
  const bad = {
    kind: "transient_cache" as const,
    contentHash: "sha256-abc",
    expiresAt: Date.now() + 60_000,
    isCorpusSource: true,
  };
  assert.throws(
    () => validateCacheEntry(bad as unknown as TransientCacheEntry),
    { message: /must not carry corpus source flags/ },
  );
});

void test("PRD 663: valid transient cache entry accepted", () => {
  const entry: TransientCacheEntry = {
    kind: "transient_cache",
    contentHash: "sha256-abc",
    expiresAt: Date.now() + 60_000,
  };
  assert.doesNotThrow(() => validateCacheEntry(entry));
});

void test("PRD 663: durable artifact ref with corpus flag accepted", () => {
  const entry: DurableArtifactRefEntry = {
    kind: "durable_artifact",
    refId: "art_456",
    ownershipScope: "deploy_prod",
    isCorpusSource: true,
  };
  assert.doesNotThrow(() => validateCacheEntry(entry));
});

// ---------------------------------------------------------------------------
// PRD 664: DocumentSource tagged union validation
// ---------------------------------------------------------------------------

void test("PRD 664: valid inline source accepted", () => {
  assert.doesNotThrow(() => validateDocumentSource(makeInline()));
});

void test("PRD 664: inline source exceeding max bytes rejected", () => {
  const oversized = makeInline({ data: new Uint8Array(INLINE_MAX_BYTES + 1) });
  assert.throws(
    () => validateDocumentSource(oversized),
    { message: /exceeds max size/ },
  );
});

void test("PRD 664: inline source at exactly max bytes accepted", () => {
  const exact = makeInline({ data: new Uint8Array(INLINE_MAX_BYTES) });
  assert.doesNotThrow(() => validateDocumentSource(exact));
});

void test("PRD 664: inline source missing MIME rejected", () => {
  assert.throws(
    () => validateInlineSource(makeInline({ declaredMime: "" })),
    { message: /MIME type/ },
  );
});

void test("PRD 664: inline source missing filename rejected", () => {
  assert.throws(
    () => validateInlineSource(makeInline({ filename: "" })),
    { message: /filename/ },
  );
});

void test("PRD 664: valid HTTPS URL accepted", () => {
  assert.doesNotThrow(() => validateDocumentSource(makeUrl("https://example.com/document.pdf")));
});

void test("PRD 664: local path rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("/etc/passwd")),
    { message: /local path/ },
  );
});

void test("PRD 664: Windows local path rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("C:\\Users\\docs\\secret.pdf")),
    { message: /local path/ },
  );
});

void test("PRD 664: relative path rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("../../../etc/passwd")),
    { message: /local path/ },
  );
});

void test("PRD 664: file:// protocol rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("file:///etc/passwd")),
    { message: /file:\/\/ protocol/ },
  );
});

void test("PRD 664: ftp:// protocol rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("ftp://files.example.com/doc.pdf")),
    { message: /ftp:\/\/ protocol/ },
  );
});

void test("PRD 664: HTTP (non-HTTPS) URL rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("http://example.com/doc.pdf")),
    { message: /must use HTTPS/ },
  );
});

void test("PRD 664: s3:// bucket key rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("s3://my-bucket/key/path")),
    { message: /bucket\/object key/ },
  );
});

void test("PRD 664: gs:// bucket key rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("gs://my-bucket/key/path")),
    { message: /bucket\/object key/ },
  );
});

void test("PRD 664: r2:// bucket key rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("r2://my-bucket/key/path")),
    { message: /bucket\/object key/ },
  );
});

void test("PRD 664: URL with credentials rejected", () => {
  assert.throws(
    () => validateUrlSource(makeUrl("https://user:pass@example.com/doc.pdf")),
    { message: /credentials/ },
  );
});

void test("PRD 664: valid artifact source accepted", () => {
  assert.doesNotThrow(() => validateDocumentSource(makeArtifact()));
});

void test("PRD 664: artifact source with empty refId rejected", () => {
  assert.throws(
    () => validateArtifactSource(makeArtifact({ refId: "" })),
    { message: /non-empty refId/ },
  );
});

void test("PRD 664: artifact source with empty ownershipScope rejected", () => {
  assert.throws(
    () => validateArtifactSource(makeArtifact({ ownershipScope: "" })),
    { message: /non-empty ownershipScope/ },
  );
});

// ---------------------------------------------------------------------------
// PRD 676: Document policy and expiry validation
// ---------------------------------------------------------------------------

void test("PRD 676: document policy is a read-only capability view", () => {
  const policy: DocumentPolicy = {
    cacheEnabled: true,
    cacheMode: "readwrite",
    uploadDefaults: { maxSizeBytes: 10_000_000, ttlSeconds: 900 },
    uploadMin: { ttlSeconds: 60 },
    uploadMax: { ttlSeconds: 86_400 },
    artifactDefaults: { ttlSeconds: 86_400 },
    artifactMin: { ttlSeconds: 300 },
    artifactMax: { ttlSeconds: 604_800 },
    stagingCleanupWindowMs: 3_600_000,
    corpusRetentionDefaults: { ttlSeconds: 2_592_000 },
    ownershipScopeCaps: ["deploy_prod", "deploy_staging"],
  };
  assert.ok(policy.cacheEnabled);
  assert.equal(policy.stagingCleanupWindowMs, 3_600_000);
});

void test("PRD 676: relative and absolute expiry mutually exclusive", () => {
  const req: ExpiryRequest = {
    relativeTtlSeconds: 3600,
    absoluteExpiresAt: Date.now() + 3_600_000,
  };
  const bounds: ExpiryBounds = { minTtlSeconds: 60, maxTtlSeconds: 86_400 };
  assert.throws(
    () => validateExpiryRequest(req, bounds, Date.now()),
    { message: /mutually exclusive/ },
  );
});

void test("PRD 676: missing both expiry fields rejected", () => {
  const req: ExpiryRequest = {};
  const bounds: ExpiryBounds = { minTtlSeconds: 60, maxTtlSeconds: 86_400 };
  assert.throws(
    () => validateExpiryRequest(req, bounds, Date.now()),
    { message: /must be provided/ },
  );
});

void test("PRD 676: TTL below minimum returns error not clamp", () => {
  const bounds: ExpiryBounds = { minTtlSeconds: 300, maxTtlSeconds: 86_400 };
  assert.throws(
    () => validateExpiryRequest({ relativeTtlSeconds: 10 }, bounds, Date.now()),
    { message: /below minimum/ },
  );
});

void test("PRD 676: TTL above maximum returns error not clamp", () => {
  const bounds: ExpiryBounds = { minTtlSeconds: 60, maxTtlSeconds: 3600 };
  assert.throws(
    () => validateExpiryRequest({ relativeTtlSeconds: 7200 }, bounds, Date.now()),
    { message: /exceeds maximum/ },
  );
});

void test("PRD 676: valid relative expiry accepted and returns absolute timestamp", () => {
  const now = 1_000_000_000;
  const bounds: ExpiryBounds = { minTtlSeconds: 60, maxTtlSeconds: 86_400 };
  const result = validateExpiryRequest({ relativeTtlSeconds: 3600 }, bounds, now);
  assert.equal(result, now + 3_600_000);
});

void test("PRD 676: valid absolute expiry accepted", () => {
  const now = 1_000_000_000;
  const expiresAt = now + 3_600_000;
  const bounds: ExpiryBounds = { minTtlSeconds: 60, maxTtlSeconds: 86_400 };
  const result = validateExpiryRequest({ absoluteExpiresAt: expiresAt }, bounds, now);
  assert.equal(result, expiresAt);
});

// ---------------------------------------------------------------------------
// PRD 689: Parse backward compatibility
// ---------------------------------------------------------------------------

void test("PRD 689: removing a required field rejected", () => {
  const previous: ParseCompatibilityContract = {
    schemaVersion: "1.0.0",
    requiredFields: ["title", "content", "url"],
    optionalFields: ["author"],
  };
  const next: ParseCompatibilityContract = {
    schemaVersion: "1.1.0",
    requiredFields: ["title", "content"],
    optionalFields: ["author", "summary"],
  };
  assert.throws(
    () => validateParseBackwardCompat(previous, next),
    { message: /required field "url" was removed/ },
  );
});

void test("PRD 689: adding an optional field accepted", () => {
  const previous: ParseCompatibilityContract = {
    schemaVersion: "1.0.0",
    requiredFields: ["title", "content"],
    optionalFields: ["author"],
  };
  const next: ParseCompatibilityContract = {
    schemaVersion: "1.1.0",
    requiredFields: ["title", "content"],
    optionalFields: ["author", "summary", "tags"],
  };
  assert.doesNotThrow(() => validateParseBackwardCompat(previous, next));
});

void test("PRD 689: identical schemas pass compatibility check", () => {
  const contract: ParseCompatibilityContract = {
    schemaVersion: "1.0.0",
    requiredFields: ["title", "content", "url"],
    optionalFields: ["author"],
  };
  assert.doesNotThrow(() => validateParseBackwardCompat(contract, contract));
});

void test("PRD 689: adding required fields while keeping existing is accepted", () => {
  const previous: ParseCompatibilityContract = {
    schemaVersion: "1.0.0",
    requiredFields: ["title"],
    optionalFields: [],
  };
  const next: ParseCompatibilityContract = {
    schemaVersion: "1.1.0",
    requiredFields: ["title", "content"],
    optionalFields: [],
  };
  assert.doesNotThrow(() => validateParseBackwardCompat(previous, next));
});
