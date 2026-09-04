import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateStatus,
  buildTruncatedResult,
  CANONICAL_SCHEMA_VERSION,
  checkOutputBounds,
  DEFAULT_PROJECTION_KIND,
  extractContentCore,
  projectToMarkdown,
  projectToText,
  rebuildSourceBinding,
  validateBlock,
  validateCapabilityState,
  validateEnvelope,
  validateSourceSpan,
  type AssetBlock,
  type CanonicalDocumentEnvelope,
  type CapabilityStates,
  type DocumentBlock,
  type DocumentProvenance,
  type FormulaBlock,
  type OutputBounds,
  type SourceIdentity,
  type TableBlock,
  type TextBlock,
} from "../../src/core/canonical-document.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvenance(overrides?: Partial<DocumentProvenance>): DocumentProvenance {
  return {
    engine: "test-engine",
    model: "test-model",
    version: "1.0.0",
    cost: 0.01,
    confidence: 0.95,
    ...overrides,
  };
}

function makeSourceIdentity(overrides?: Partial<SourceIdentity>): SourceIdentity {
  return {
    contentHash: "abc123def456",
    url: "https://example.com/doc.pdf",
    ...overrides,
  };
}

function makeTextBlock(id: string, content: string): TextBlock {
  return { type: "text", blockId: id, content };
}

function makeTableBlock(id: string): TableBlock {
  return {
    type: "table",
    blockId: id,
    cells: [
      { row: 0, col: 0, content: "Header" },
      { row: 1, col: 0, content: "Value" },
    ],
  };
}

function makeAssetBlock(id: string): AssetBlock {
  return {
    type: "asset",
    blockId: id,
    assetRef: "asset-ref-001",
    mimeType: "image/png",
    altText: "A diagram",
  };
}

function makeFormulaBlock(id: string): FormulaBlock {
  return {
    type: "formula",
    blockId: id,
    expression: "E = mc^2",
    format: "latex",
  };
}

function makeEnvelope(
  overrides?: Partial<CanonicalDocumentEnvelope>,
): CanonicalDocumentEnvelope {
  const blocks: DocumentBlock[] = overrides?.blocks
    ? [...overrides.blocks]
    : [makeTextBlock("b1", "Hello world")];
  const readingOrder = overrides?.readingOrder ?? blocks.map((b) => b.blockId);

  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    documentId: "doc-001",
    canonicalContentId: "content-001",
    sourceIdentity: makeSourceIdentity(),
    blocks,
    readingOrder,
    status: "success",
    capabilityStates: { text: "available", tables: "available" },
    warnings: [],
    errors: [],
    provenance: makeProvenance(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 678: Canonical document envelope
// ---------------------------------------------------------------------------

void test("PRD 678: valid envelope accepted", () => {
  const envelope = makeEnvelope();
  assert.doesNotThrow(() => validateEnvelope(envelope));
});

void test("PRD 678: missing schemaVersion rejected", () => {
  const envelope = makeEnvelope({ schemaVersion: "" });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /non-empty schemaVersion/ },
  );
});

void test("PRD 678: missing documentId rejected", () => {
  const envelope = makeEnvelope({ documentId: "" });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /non-empty documentId/ },
  );
});

void test("PRD 678: missing canonicalContentId rejected", () => {
  const envelope = makeEnvelope({ canonicalContentId: "" });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /non-empty canonicalContentId/ },
  );
});

void test("PRD 678: duplicate block IDs rejected", () => {
  const blocks = [
    makeTextBlock("dup", "first"),
    makeTextBlock("dup", "second"),
  ];
  const envelope = makeEnvelope({ blocks, readingOrder: ["dup"] });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /Duplicate block ID/ },
  );
});

void test("PRD 678: provenance engine required", () => {
  const envelope = makeEnvelope({ provenance: makeProvenance({ engine: "" }) });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /provenance must include engine/ },
  );
});

void test("PRD 678: provenance model required", () => {
  const envelope = makeEnvelope({ provenance: makeProvenance({ model: "" }) });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /provenance must include model/ },
  );
});

void test("PRD 678: provenance version required", () => {
  const envelope = makeEnvelope({ provenance: makeProvenance({ version: "" }) });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /provenance must include version/ },
  );
});

void test("PRD 678: provenance cost must be non-negative", () => {
  const envelope = makeEnvelope({ provenance: makeProvenance({ cost: -1 }) });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /cost must be non-negative/ },
  );
});

void test("PRD 678: provenance confidence must be 0..1", () => {
  const envelope = makeEnvelope({ provenance: makeProvenance({ confidence: 1.5 }) });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /confidence must be between 0 and 1/ },
  );
});

void test("PRD 678: blocks must have stable unique IDs", () => {
  const blocks = [
    makeTextBlock("b1", "first"),
    makeTextBlock("b2", "second"),
    makeTextBlock("b3", "third"),
  ];
  const envelope = makeEnvelope({ blocks });
  assert.doesNotThrow(() => validateEnvelope(envelope));
  // Verify IDs are preserved
  assert.deepEqual(
    envelope.blocks.map((b) => b.blockId),
    ["b1", "b2", "b3"],
  );
});

void test("PRD 678: reading order references existing block IDs", () => {
  const blocks = [makeTextBlock("b1", "hello")];
  const envelope = makeEnvelope({ blocks, readingOrder: ["b1", "missing"] });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /unknown block ID.*missing/ },
  );
});

void test("PRD 678: sourceIdentity contentHash required", () => {
  const envelope = makeEnvelope({
    sourceIdentity: { contentHash: "" },
  });
  assert.throws(
    () => validateEnvelope(envelope),
    { message: /sourceIdentity must have a contentHash/ },
  );
});

// ---------------------------------------------------------------------------
// PRD 679: Content core extraction and source binding
// ---------------------------------------------------------------------------

void test("PRD 679: extractContentCore excludes source-specific fields", () => {
  const envelope = makeEnvelope({
    sourceIdentity: {
      contentHash: "hash1",
      url: "https://example.com/doc.pdf",
      filename: "doc.pdf",
      artifactRef: "art-ref-1",
    },
  });

  const core = extractContentCore(envelope);

  // Core must not contain source-specific fields
  assert.equal("documentId" in core, false);
  assert.equal("sourceIdentity" in core, false);

  // Core must retain content fields
  assert.equal(core.schemaVersion, envelope.schemaVersion);
  assert.equal(core.canonicalContentId, envelope.canonicalContentId);
  assert.deepEqual(core.blocks, envelope.blocks);
  assert.deepEqual(core.readingOrder, envelope.readingOrder);
  assert.deepEqual(core.provenance, envelope.provenance);
});

void test("PRD 679: same hash different sources produce identical core", () => {
  const sharedBlocks = [makeTextBlock("b1", "shared content")];
  const sharedHash = "shared-hash-abc";

  const envelope1 = makeEnvelope({
    documentId: "doc-from-url",
    blocks: sharedBlocks,
    sourceIdentity: {
      contentHash: sharedHash,
      url: "https://example.com/document.pdf",
    },
  });

  const envelope2 = makeEnvelope({
    documentId: "doc-from-file",
    blocks: sharedBlocks,
    sourceIdentity: {
      contentHash: sharedHash,
      filename: "document.pdf",
    },
  });

  const core1 = extractContentCore(envelope1);
  const core2 = extractContentCore(envelope2);

  assert.deepEqual(core1, core2);
});

void test("PRD 679: rebuilt envelope has current source identity", () => {
  const envelope = makeEnvelope({
    sourceIdentity: {
      contentHash: "hash1",
      url: "https://old.example.com/doc.pdf",
    },
  });

  const core = extractContentCore(envelope);
  const newSource: SourceIdentity = {
    contentHash: "hash1",
    url: "https://new.example.com/doc.pdf",
  };

  const rebuilt = rebuildSourceBinding(core, newSource, "new-doc-id");

  assert.equal(rebuilt.documentId, "new-doc-id");
  assert.equal(rebuilt.sourceIdentity.url, "https://new.example.com/doc.pdf");
  assert.deepEqual(rebuilt.blocks, envelope.blocks);
});

void test("PRD 679: citation provenance does not leak from core", () => {
  const envelope = makeEnvelope({
    sourceIdentity: {
      contentHash: "hash1",
      url: "https://secret.example.com/private.pdf",
      filename: "private.pdf",
      artifactRef: "secret-ref",
    },
  });

  const core = extractContentCore(envelope);
  const coreJson = JSON.stringify(core);

  assert.equal(coreJson.includes("secret.example.com"), false);
  assert.equal(coreJson.includes("private.pdf"), false);
  assert.equal(coreJson.includes("secret-ref"), false);
});

// ---------------------------------------------------------------------------
// PRD 680: Typed blocks, source spans, capability states
// ---------------------------------------------------------------------------

void test("PRD 680: TextBlock validates", () => {
  const block = makeTextBlock("t1", "Hello");
  assert.doesNotThrow(() => validateBlock(block));
});

void test("PRD 680: TableBlock validates", () => {
  const block = makeTableBlock("tbl1");
  assert.doesNotThrow(() => validateBlock(block));
});

void test("PRD 680: AssetBlock validates", () => {
  const block = makeAssetBlock("asset1");
  assert.doesNotThrow(() => validateBlock(block));
});

void test("PRD 680: FormulaBlock validates", () => {
  const block = makeFormulaBlock("f1");
  assert.doesNotThrow(() => validateBlock(block));
});

void test("PRD 680: block with empty blockId rejected", () => {
  const block = makeTextBlock("", "content");
  assert.throws(
    () => validateBlock(block),
    { message: /non-empty blockId/ },
  );
});

void test("PRD 680: AssetBlock without assetRef rejected", () => {
  const block: AssetBlock = {
    type: "asset",
    blockId: "a1",
    assetRef: "",
    mimeType: "image/png",
  };
  assert.throws(
    () => validateBlock(block),
    { message: /must have an assetRef/ },
  );
});

void test("PRD 680: PageBboxSpan validates", () => {
  assert.doesNotThrow(() =>
    validateSourceSpan({
      kind: "page-bbox",
      page: 0,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      contentHash: "hash1",
    }),
  );
});

void test("PRD 680: CharOffsetSpan validates", () => {
  assert.doesNotThrow(() =>
    validateSourceSpan({
      kind: "char-offset",
      start: 0,
      end: 100,
      contentHash: "hash1",
    }),
  );
});

void test("PRD 680: SheetCellSpan validates", () => {
  assert.doesNotThrow(() =>
    validateSourceSpan({
      kind: "sheet-cell",
      sheet: "Sheet1",
      startCell: "A1",
      endCell: "B5",
      contentHash: "hash1",
    }),
  );
});

void test("PRD 680: SlideShapeSpan validates", () => {
  assert.doesNotThrow(() =>
    validateSourceSpan({
      kind: "slide-shape",
      slide: 0,
      shapeId: "shape-1",
      contentHash: "hash1",
    }),
  );
});

void test("PRD 680: MediaTimeSpan validates", () => {
  assert.doesNotThrow(() =>
    validateSourceSpan({
      kind: "media-time",
      startMs: 0,
      endMs: 5000,
      contentHash: "hash1",
    }),
  );
});

void test("PRD 680: CharOffsetSpan with end <= start rejected", () => {
  assert.throws(
    () => validateSourceSpan({
      kind: "char-offset",
      start: 100,
      end: 50,
      contentHash: "hash1",
    }),
    { message: /end must be greater than start/ },
  );
});

void test("PRD 680: CapabilityState only allows valid values", () => {
  assert.doesNotThrow(() => validateCapabilityState("available"));
  assert.doesNotThrow(() => validateCapabilityState("unsupported"));
  assert.doesNotThrow(() => validateCapabilityState("not_run"));
  assert.doesNotThrow(() => validateCapabilityState("failed"));
  assert.throws(
    () => validateCapabilityState("pending"),
    { message: /Invalid capability state/ },
  );
});

void test("PRD 680: available with empty results is valid", () => {
  const envelope = makeEnvelope({
    blocks: [], // empty results
    readingOrder: [],
    capabilityStates: { text: "available" },
  });
  // available capability with empty block array is valid
  assert.doesNotThrow(() => validateEnvelope(envelope));
  assert.equal(envelope.blocks.length, 0);
});

void test("PRD 680: aggregateStatus returns success when all required available", () => {
  const states: CapabilityStates = {
    text: "available",
    tables: "available",
  };
  assert.equal(aggregateStatus(states, ["text", "tables"]), "success");
});

void test("PRD 680: aggregateStatus returns partial when any unsupported", () => {
  const states: CapabilityStates = {
    text: "available",
    tables: "unsupported",
  };
  assert.equal(aggregateStatus(states, ["text", "tables"]), "partial");
});

void test("PRD 680: aggregateStatus returns failed when any failed", () => {
  const states: CapabilityStates = {
    text: "available",
    tables: "failed",
  };
  assert.equal(aggregateStatus(states, ["text", "tables"]), "failed");
});

void test("PRD 680: aggregateStatus failed takes precedence over unsupported", () => {
  const states: CapabilityStates = {
    text: "unsupported",
    tables: "failed",
  };
  assert.equal(aggregateStatus(states, ["text", "tables"]), "failed");
});

void test("PRD 680: aggregateStatus treats missing capability as failed", () => {
  const states: CapabilityStates = { text: "available" };
  assert.equal(aggregateStatus(states, ["text", "missing_cap"]), "failed");
});

// ---------------------------------------------------------------------------
// PRD 681: Projections
// ---------------------------------------------------------------------------

void test("PRD 681: default projection kind is markdown", () => {
  assert.equal(DEFAULT_PROJECTION_KIND, "markdown");
});

void test("PRD 681: projectToMarkdown deterministic for same envelope", () => {
  const envelope = makeEnvelope({
    blocks: [
      makeTextBlock("b1", "First paragraph"),
      makeTextBlock("b2", "Second paragraph"),
    ],
    readingOrder: ["b1", "b2"],
  });

  const proj1 = projectToMarkdown(envelope);
  const proj2 = projectToMarkdown(envelope);

  assert.equal(proj1.content, proj2.content);
  assert.equal(proj1.kind, "markdown");
});

void test("PRD 681: projectToText deterministic for same envelope", () => {
  const envelope = makeEnvelope({
    blocks: [
      makeTextBlock("b1", "First"),
      makeTextBlock("b2", "Second"),
    ],
    readingOrder: ["b1", "b2"],
  });

  const proj1 = projectToText(envelope);
  const proj2 = projectToText(envelope);

  assert.equal(proj1.content, proj2.content);
  assert.equal(proj1.kind, "text");
});

void test("PRD 681: projection preserves reading order", () => {
  const envelope = makeEnvelope({
    blocks: [
      makeTextBlock("b1", "First"),
      makeTextBlock("b2", "Second"),
      makeTextBlock("b3", "Third"),
    ],
    readingOrder: ["b3", "b1", "b2"],
  });

  const proj = projectToMarkdown(envelope);
  assert.ok(proj.content.indexOf("Third") < proj.content.indexOf("First"));
  assert.ok(proj.content.indexOf("First") < proj.content.indexOf("Second"));
});

void test("PRD 681: table references intact in markdown projection", () => {
  const envelope = makeEnvelope({
    blocks: [
      makeTextBlock("b1", "Before table"),
      makeTableBlock("tbl1"),
      makeTextBlock("b2", "After table"),
    ],
    readingOrder: ["b1", "tbl1", "b2"],
  });

  const proj = projectToMarkdown(envelope);
  assert.ok(proj.content.includes("Header"));
  assert.ok(proj.content.includes("Value"));
  assert.ok(proj.content.includes("|"));
});

void test("PRD 681: projection includes version and documentId", () => {
  const envelope = makeEnvelope();
  const proj = projectToMarkdown(envelope);

  assert.ok(proj.projectionVersion);
  assert.equal(proj.sourceDocumentId, envelope.documentId);
  assert.equal(proj.canonicalContentId, envelope.canonicalContentId);
});

void test("PRD 681: text projection is lossy", () => {
  const envelope = makeEnvelope({
    blocks: [makeTableBlock("tbl1")],
    readingOrder: ["tbl1"],
  });
  const proj = projectToText(envelope);
  assert.equal(proj.lossy, true);
});

void test("PRD 681: markdown projection is not lossy", () => {
  const envelope = makeEnvelope();
  const proj = projectToMarkdown(envelope);
  assert.equal(proj.lossy, false);
});

// ---------------------------------------------------------------------------
// PRD 683: Output bounds
// ---------------------------------------------------------------------------

void test("PRD 683: output within bounds passes", () => {
  const envelope = makeEnvelope({
    blocks: [makeTextBlock("b1", "short")],
    readingOrder: ["b1"],
  });
  const bounds: OutputBounds = {
    maxBytes: 1_000_000,
    maxChars: 1_000_000,
    maxBlocks: 100,
    maxTables: 10,
    maxAssets: 10,
  };
  const result = checkOutputBounds(envelope, bounds);
  assert.equal(result.withinBounds, true);
});

void test("PRD 683: output exceeding bytes triggers truncation", () => {
  const envelope = makeEnvelope({
    blocks: [makeTextBlock("b1", "x".repeat(1000))],
    readingOrder: ["b1"],
  });
  const bounds: OutputBounds = {
    maxBytes: 10,
    maxChars: 1_000_000,
    maxBlocks: 100,
    maxTables: 10,
    maxAssets: 10,
  };
  const result = checkOutputBounds(envelope, bounds);
  assert.equal(result.withinBounds, false);
  assert.equal(result.exceededDimension, "bytes");
});

void test("PRD 683: output exceeding blocks triggers truncation", () => {
  const blocks = Array.from({ length: 20 }, (_, i) =>
    makeTextBlock(`b${String(i)}`, `block ${String(i)}`),
  );
  const envelope = makeEnvelope({
    blocks,
    readingOrder: blocks.map((b) => b.blockId),
  });
  const bounds: OutputBounds = {
    maxBytes: 1_000_000,
    maxChars: 1_000_000,
    maxBlocks: 5,
    maxTables: 10,
    maxAssets: 10,
  };
  const result = checkOutputBounds(envelope, bounds);
  assert.equal(result.withinBounds, false);
  assert.equal(result.exceededDimension, "blocks");
});

void test("PRD 683: output exceeding tables triggers truncation", () => {
  const blocks = Array.from({ length: 5 }, (_, i) =>
    makeTableBlock(`tbl${String(i)}`),
  );
  const envelope = makeEnvelope({
    blocks,
    readingOrder: blocks.map((b) => b.blockId),
  });
  const bounds: OutputBounds = {
    maxBytes: 1_000_000,
    maxChars: 1_000_000,
    maxBlocks: 100,
    maxTables: 2,
    maxAssets: 10,
  };
  const result = checkOutputBounds(envelope, bounds);
  assert.equal(result.withinBounds, false);
  assert.equal(result.exceededDimension, "tables");
});

void test("PRD 683: output exceeding assets triggers truncation", () => {
  const blocks = Array.from({ length: 5 }, (_, i) =>
    makeAssetBlock(`asset${String(i)}`),
  );
  const envelope = makeEnvelope({
    blocks,
    readingOrder: blocks.map((b) => b.blockId),
  });
  const bounds: OutputBounds = {
    maxBytes: 1_000_000,
    maxChars: 1_000_000,
    maxBlocks: 100,
    maxTables: 10,
    maxAssets: 2,
  };
  const result = checkOutputBounds(envelope, bounds);
  assert.equal(result.withinBounds, false);
  assert.equal(result.exceededDimension, "assets");
});

void test("PRD 683: 'all' is not the default projection kind", () => {
  assert.notEqual(DEFAULT_PROJECTION_KIND, "all");
});

void test("PRD 683: truncated result includes provenance and artifactRef", () => {
  const envelope = makeEnvelope();
  const boundsCheck = {
    withinBounds: false as const,
    exceededDimension: "bytes",
    actualValue: 5000,
    limitValue: 1000,
  };
  const result = buildTruncatedResult(envelope, "art-ref-storage-neutral", boundsCheck);
  assert.equal(result.truncated, true);
  assert.equal(result.artifactRef, "art-ref-storage-neutral");
  assert.deepEqual(result.provenance, envelope.provenance);
  assert.ok(result.summary.includes("bytes"));
});

void test("PRD 683: billing not double-counted when returning canonical + projections", () => {
  // The projection result carries no cost of its own; provenance is on the
  // envelope only. Verify projection has no billing/cost field.
  const envelope = makeEnvelope();
  const mdProj = projectToMarkdown(envelope);
  const txtProj = projectToText(envelope);

  // ProjectionResult type has no cost/billing field -- verify at runtime
  assert.equal("cost" in mdProj, false);
  assert.equal("billingProvenance" in mdProj, false);
  assert.equal("cost" in txtProj, false);
  assert.equal("billingProvenance" in txtProj, false);

  // Provenance lives only on the envelope
  assert.ok(envelope.provenance.cost >= 0);
});
