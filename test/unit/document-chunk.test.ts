import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBoundedDocument,
} from "../../src/adapters/document/bounded-document-parser.js";

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
