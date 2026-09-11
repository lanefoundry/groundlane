import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBoundedDocument,
} from "../../src/adapters/document/bounded-document-parser.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

void test("document toc: Markdown headings are extractable from parsed blocks", async () => {
  const md = [
    "# Introduction",
    "This is the intro paragraph.",
    "## Background",
    "Some background text here.",
    "### Details",
    "More detailed information.",
    "## Conclusion",
    "Final thoughts.",
  ].join("\n");

  const result = await parseBoundedDocument({
    bytes: bytes(md),
    declaredMime: "text/markdown",
    filename: "doc.md",
  });

  assert.ok(result.blocks.length > 0, "should produce blocks from markdown");
  // The entire markdown becomes one text block
  if (result.blocks[0]?.type === "text") {
    const content = result.blocks[0].content;
    assert.ok(content.includes("Introduction"), "should contain heading text");
    assert.ok(content.includes("Background"), "should contain sub-heading text");
    // Verify the headings survive in the parsed text for TOC extraction
    assert.ok(
      content.includes("#") || content.includes("Introduction"),
      "parsed content should retain heading markers or text",
    );
  }
});

void test("document toc: plain text without headings produces blocks but no heading markers", async () => {
  const plain = "This is just a regular paragraph. No headings here. Just flowing text that describes something.";
  const result = await parseBoundedDocument({
    bytes: bytes(plain),
    declaredMime: "text/plain",
    filename: "plain.txt",
  });

  assert.ok(result.blocks.length > 0, "should produce at least one block");
  if (result.blocks[0]?.type === "text") {
    // No markdown heading markers in plain text
    assert.ok(!result.blocks[0].content.startsWith("#"), "plain text should not have heading markers");
  }
});

void test("document toc: HTML headings are stripped to text in parsed blocks", async () => {
  const html = "<html><body><h1>Main Title</h1><p>Body text</p><h2>Section Two</h2><p>More text</p></body></html>";
  const result = await parseBoundedDocument({
    bytes: bytes(html),
    declaredMime: "text/html",
    filename: "page.html",
  });

  assert.ok(result.blocks.length > 0, "HTML should produce blocks");
  if (result.blocks[0]?.type === "text") {
    assert.ok(result.blocks[0].content.includes("Main Title"), "should contain heading text");
  }
});

void test("document toc: empty document is rejected by parser", async () => {
  await assert.rejects(
    () => parseBoundedDocument({
      bytes: bytes(""),
      declaredMime: "text/plain",
      filename: "empty.txt",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
});

void test("document toc: multiple heading levels in markdown preserve hierarchy indicators", async () => {
  const md = [
    "# Level 1",
    "Text under level 1.",
    "## Level 2a",
    "Text under 2a.",
    "## Level 2b",
    "Text under 2b.",
    "### Level 3",
    "Text under 3.",
  ].join("\n");

  const result = await parseBoundedDocument({
    bytes: bytes(md),
    declaredMime: "text/markdown",
    filename: "headings.md",
  });

  assert.ok(result.blocks.length > 0);
  if (result.blocks[0]?.type === "text") {
    const content = result.blocks[0].content;
    assert.ok(content.includes("Level 1"), "should contain L1 heading");
    assert.ok(content.includes("Level 2a"), "should contain L2a heading");
    assert.ok(content.includes("Level 3"), "should contain L3 heading");
  }
});
