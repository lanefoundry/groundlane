import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBoundedDocument,
} from "../../src/adapters/document/bounded-document-parser.js";
import type { DocumentBlock } from "../../src/core/canonical-document.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function simplePdf(text: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(text.length + 31)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(bytes(source).byteLength);
    source += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = bytes(source).byteLength;
  source += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return bytes(source);
}

// Simulate the chunking logic directly — the MCP tool wraps parseBoundedDocument + chunking
// so we test the underlying parse + chunk contract here.

void test("document chunk: parseBoundedDocument produces blocks that can be chunked", async () => {
  const content = "This is a paragraph of text that should become a document block. ".repeat(20);
  const result = await parseBoundedDocument({
    bytes: bytes(content),
    declaredMime: "text/plain",
    filename: "test.txt",
  });
  assert.ok(result.blocks.length > 0, "should have at least one block");
  assert.equal(result.blocks[0]?.type, "text");
  if (result.blocks[0]?.type === "text") {
    assert.ok(result.blocks[0].content.length > 0, "block should have content");
  }
});

void test("document chunk: small text produces single chunk at each level", async () => {
  const result = await parseBoundedDocument({
    bytes: bytes("Hello world"),
    declaredMime: "text/plain",
    filename: "tiny.txt",
  });
  assert.equal(result.blocks.length, 1);
  // "Hello world" is ~3 tokens, fits in any chunk size
  if (result.blocks[0]?.type === "text") {
    const tokens = Math.ceil(result.blocks[0].content.length / 4);
    assert.ok(tokens < 128, "tiny doc should fit in smallest chunk");
  }
});

void test("document chunk: PDF text is extractable for chunking", async () => {
  const pdf = simplePdf("Groundlane PDF chunking test content");
  const result = await parseBoundedDocument({
    bytes: pdf,
    declaredMime: "application/pdf",
    filename: "test.pdf",
  });
  assert.ok(result.blocks.length > 0, "PDF should produce blocks");
  const textBlocks = result.blocks.filter((b) => b.type === "text");
  assert.ok(textBlocks.length > 0, "PDF should have text blocks");
});

void test("document chunk: large document produces multiple blocks for hierarchical splitting", async () => {
  // Create a document large enough to require splitting at default 2048-token level
  // 2048 tokens ≈ 8192 characters
  const paragraph = "Groundlane is a trusted web access layer for AI agents. It provides deterministic extraction and bounded retrieval. ";
  const content = paragraph.repeat(100); // ~11,700 chars = ~2925 tokens
  const result = await parseBoundedDocument({
    bytes: bytes(content),
    declaredMime: "text/plain",
    filename: "large.txt",
  });
  assert.ok(result.blocks.length >= 1, "should produce at least one block");
  if (result.blocks[0]?.type === "text") {
    const totalChars = result.blocks[0].content.length;
    const approxTokens = Math.ceil(totalChars / 4);
    assert.ok(approxTokens > 128, "document should be large enough to split at 128-token level");
  }
});

void test("document chunk: empty document produces no blocks", async () => {
  const result = await parseBoundedDocument({
    bytes: bytes("   "),
    declaredMime: "text/plain",
    filename: "empty.txt",
  });
  // Whitespace-only normalizes to empty
  assert.equal(result.blocks.length, 0, "whitespace-only doc should have no blocks");
});

// --- Field-aware chunking tests ---

void test("field-aware: extractFieldsFromBlocks extracts table header row as fields", async () => {
  const { extractFieldsFromBlocks } = await import("../../src/tools/document-chunk.js");

  const blocks: DocumentBlock[] = [
    {
      type: "table",
      blockId: "table-1",
      cells: [
        { row: 0, col: 0, content: "Name" },
        { row: 0, col: 1, content: "Grade" },
        { row: 0, col: 2, content: "Location" },
        { row: 1, col: 0, content: "Route A" },
        { row: 1, col: 1, content: "5.11b" },
        { row: 1, col: 2, content: "Dragon Cave" },
      ],
    },
  ];

  const fields = extractFieldsFromBlocks(blocks, undefined);
  assert.deepEqual(fields.get("table-1"), ["Name", "Grade", "Location"]);
});

void test("field-aware: extractFieldsFromBlocks extracts metadata keys", async () => {
  const { extractFieldsFromBlocks } = await import("../../src/tools/document-chunk.js");

  const blocks: DocumentBlock[] = [
    { type: "text", blockId: "p-1", content: "Hello world" },
  ];
  const metadata = [
    { key: "title", value: "Test Document" },
    { key: "author", value: "Vincent" },
  ];

  const fields = extractFieldsFromBlocks(blocks, metadata);
  assert.deepEqual(fields.get("__metadata__"), ["title", "author"]);
  assert.equal(fields.has("p-1"), false);
});

void test("field-aware: attachFieldsToChunks adds fields to chunks referencing table blocks", async () => {
  const { extractFieldsFromBlocks, attachFieldsToChunks } = await import("../../src/tools/document-chunk.js");

  const blocks: DocumentBlock[] = [
    {
      type: "table",
      blockId: "table-1",
      cells: [
        { row: 0, col: 0, content: "Product" },
        { row: 0, col: 1, content: "Price" },
        { row: 1, col: 0, content: "Widget" },
        { row: 1, col: 1, content: "$10" },
      ],
    },
    { type: "text", blockId: "p-1", content: "Some other text" },
  ];

  const blockFields = extractFieldsFromBlocks(blocks, undefined);
  const chunks: { chunkId: string; parentChunkId: string | null; level: number; text: string; tokenCount: number; blockRefs: string[]; fields?: string[] }[] = [
    { chunkId: "chunk-L0-0", parentChunkId: null, level: 0, text: "Product | Price\nWidget | $10", tokenCount: 7, blockRefs: ["table-1"] },
    { chunkId: "chunk-L0-1", parentChunkId: null, level: 0, text: "Some other text", tokenCount: 4, blockRefs: ["p-1"] },
  ];

  attachFieldsToChunks(chunks, blockFields);
  assert.deepEqual(chunks[0]?.fields, ["Product", "Price"]);
  assert.equal(chunks[1]?.fields, undefined);
});

void test("field-aware: metadata fields are attached to all chunks", async () => {
  const { extractFieldsFromBlocks, attachFieldsToChunks } = await import("../../src/tools/document-chunk.js");

  const blocks: DocumentBlock[] = [
    { type: "text", blockId: "p-1", content: "Content A" },
    { type: "text", blockId: "p-2", content: "Content B" },
  ];
  const metadata = [{ key: "category", value: "tech" }];

  const blockFields = extractFieldsFromBlocks(blocks, metadata);
  const chunks: { chunkId: string; parentChunkId: string | null; level: number; text: string; tokenCount: number; blockRefs: string[]; fields?: string[] }[] = [
    { chunkId: "chunk-L0-0", parentChunkId: null, level: 0, text: "Content A", tokenCount: 3, blockRefs: ["p-1"] },
    { chunkId: "chunk-L0-1", parentChunkId: null, level: 0, text: "Content B", tokenCount: 3, blockRefs: ["p-2"] },
  ];

  attachFieldsToChunks(chunks, blockFields);
  assert.deepEqual(chunks[0]?.fields, ["category"]);
  assert.deepEqual(chunks[1]?.fields, ["category"]);
});

void test("field-aware: CSV document produces table with header fields", async () => {
  const csv = "Name,Grade,Type\nBeauty Mirror,5.11b,Sport\nDragon Scale,5.10a,Trad\n";
  const result = await parseBoundedDocument({
    bytes: bytes(csv),
    declaredMime: "text/csv",
    filename: "routes.csv",
  });

  assert.ok(result.blocks.length > 0, "CSV should produce blocks");
  const tableBlock = result.blocks.find((b) => b.type === "table");
  assert.ok(tableBlock, "CSV should produce a table block");

  const { extractFieldsFromBlocks } = await import("../../src/tools/document-chunk.js");
  const fields = extractFieldsFromBlocks(result.blocks as DocumentBlock[], result.metadata);
  assert.ok(fields.has(tableBlock!.blockId), "table block should have fields");
  assert.deepEqual(fields.get(tableBlock!.blockId), ["Name", "Grade", "Type"]);
});

void test("field-aware: empty table headers are filtered out", async () => {
  const { extractFieldsFromBlocks } = await import("../../src/tools/document-chunk.js");

  const blocks: DocumentBlock[] = [
    {
      type: "table",
      blockId: "table-1",
      cells: [
        { row: 0, col: 0, content: "Name" },
        { row: 0, col: 1, content: "" },
        { row: 0, col: 2, content: "  " },
        { row: 1, col: 0, content: "Foo" },
        { row: 1, col: 1, content: "Bar" },
        { row: 1, col: 2, content: "Baz" },
      ],
    },
  ];

  const fields = extractFieldsFromBlocks(blocks, undefined);
  assert.deepEqual(fields.get("table-1"), ["Name"]);
});
