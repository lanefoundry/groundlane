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

// ---------------------------------------------------------------------------
// PRD 659 (input runtime): MIME sniffing, encrypted/macro/archive rejection,
// page/byte limits, preflight classification, transient-vs-durable guard
// ---------------------------------------------------------------------------

void test("PRD 659: sniffMimeFromBytes detects PDF/PNG/JPEG magic", async () => {
  const mod = await import("../../src/core/document-source.js");
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  assert.equal(mod.sniffMimeFromBytes(pdf), "application/pdf");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(mod.sniffMimeFromBytes(png), "image/png");
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(mod.sniffMimeFromBytes(jpg), "image/jpeg");
});

void test("PRD 659: classify PDF bytes returns pdf hint without OCR", async () => {
  const mod = await import("../../src/core/document-source.js");
  const text = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const data = new TextEncoder().encode(text);
  const c = mod.classifyDocumentBytes(data, "application/pdf", "doc.pdf");
  assert.equal(c.inputKind, "pdf");
  assert.equal(c.sniffedMime, "application/pdf");
  assert.equal(c.needsOcr, false);
});

void test("PRD 659: classify PNG bytes returns image hint with OCR flag", async () => {
  const mod = await import("../../src/core/document-source.js");
  const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const c = mod.classifyDocumentBytes(data, "image/png", "scan.png");
  assert.equal(c.inputKind, "image");
  assert.equal(c.needsOcr, true);
});

void test("PRD 659: classify OOXML docx returns office hint", async () => {
  const mod = await import("../../src/core/document-source.js");
  const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
  const tail = new TextEncoder().encode("[Content_Types].xml word/document.xml");
  const data = new Uint8Array(head.length + tail.length);
  data.set(head, 0);
  data.set(tail, head.length);
  const c = mod.classifyDocumentBytes(
    data,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "report.docx",
  );
  assert.equal(c.inputKind, "office");
  assert.equal(c.needsOcr, false);
});

void test("PRD 659: encrypted PDF rejected", async () => {
  const mod = await import("../../src/core/document-source.js");
  const text = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Encrypt 2 0 R >>\nendobj\n";
  const data = new TextEncoder().encode(text);
  assert.throws(() => mod.classifyDocumentBytes(data, "application/pdf", "locked.pdf"), {
    message: /encrypted/i,
  });
});

void test("PRD 659: OOXML with macro rejected", async () => {
  const mod = await import("../../src/core/document-source.js");
  const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const tail = new TextEncoder().encode("xl/vbaProject.bin malicious");
  const data = new Uint8Array(head.length + tail.length);
  data.set(head, 0);
  data.set(tail, head.length);
  assert.throws(
    () =>
      mod.classifyDocumentBytes(
        data,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "budget.xlsx",
      ),
    { message: /macro/i },
  );
});

void test("PRD 659: generic zip archive rejected", async () => {
  const mod = await import("../../src/core/document-source.js");
  const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const tail = new TextEncoder().encode("random archive content");
  const data = new Uint8Array(head.length + tail.length);
  data.set(head, 0);
  data.set(tail, head.length);
  assert.throws(() => mod.classifyDocumentBytes(data, "application/zip", "bundle.zip"), {
    message: /archive/i,
  });
});

void test("PRD 659: MIME mismatch between sniff and declared rejected", async () => {
  const mod = await import("../../src/core/document-source.js");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => mod.classifyDocumentBytes(png, "application/pdf", "fake.pdf"), {
    message: /MIME.*mismatch|mismatch.*MIME/i,
  });
});

void test("PRD 659: byte limits enforced on inline bytes", async () => {
  const mod = await import("../../src/core/document-source.js");
  const data = new Uint8Array(1024);
  assert.throws(
    () =>
      mod.validateDocumentByteLimits(
        data,
        { maxBytes: 100, maxPages: 10, maxTimeMs: 1000, maxMemoryMb: 64 },
        1,
      ),
    { message: /exceeds|limit/i },
  );
});

void test("PRD 659: page limits enforced via estimated PDF pages", async () => {
  const mod = await import("../../src/core/document-source.js");
  let text = "%PDF-1.7\n";
  for (let i = 0; i < 5; i += 1) {
    text += `${String(i)} 0 obj\n<< /Type /Page >>\nendobj\n`;
  }
  const data = new TextEncoder().encode(text);
  const pages = mod.estimatePdfPages(data);
  assert.equal(pages, 5);
  assert.throws(
    () =>
      mod.validateDocumentByteLimits(
        data,
        { maxBytes: 10_000_000, maxPages: 2, maxTimeMs: 1000, maxMemoryMb: 64 },
        pages,
      ),
    { message: /pages|limit/i },
  );
});

void test("PRD 659: preflight inline source accepted with classification", async () => {
  const mod = await import("../../src/core/document-source.js");
  const data = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
  const result = mod.preflightInlineSource(
    { kind: "inline", data, declaredMime: "application/pdf", filename: "a.pdf" },
    { maxBytes: 10_000_000, maxPages: 100, maxTimeMs: 5000, maxMemoryMb: 256 },
  );
  assert.equal(result.accepted, true);
  if (result.accepted) {
    assert.equal(result.inputKind, "pdf");
  }
});

void test("PRD 659: preflight URL source deferred without fetching", async () => {
  const mod = await import("../../src/core/document-source.js");
  const result = mod.preflightDocumentSource(
    { kind: "url", url: "https://example.com/report.pdf" },
    { maxBytes: 10_000_000, maxPages: 100, maxTimeMs: 5000, maxMemoryMb: 256 },
  );
  assert.equal(result.accepted, true);
  if (result.accepted && "deferred" in result) {
    assert.equal(result.deferred, true);
  } else {
    assert.fail("URL preflight must be deferred");
  }
});

void test("PRD 659: preflight rejects local path without network access", async () => {
  const mod = await import("../../src/core/document-source.js");
  assert.throws(
    () =>
      mod.preflightDocumentSource(
        { kind: "url", url: "/etc/passwd" },
        { maxBytes: 10_000_000, maxPages: 100, maxTimeMs: 5000, maxMemoryMb: 256 },
      ),
    { message: /local path/ },
  );
});

void test("PRD 659: transient cache entry cannot be used as durable artifact", async () => {
  const mod = await import("../../src/core/document-source.js");
  const transient = {
    kind: "transient_cache" as const,
    contentHash: "sha256-abc",
    expiresAt: Date.now() + 60_000,
  };
  assert.throws(() => mod.requireDurableForArtifact(transient), {
    message: /transient/i,
  });
  const durable = {
    kind: "durable_artifact" as const,
    refId: "art_123",
    ownershipScope: "deploy_prod",
  };
  assert.doesNotThrow(() => mod.requireDurableForArtifact(durable));
});
