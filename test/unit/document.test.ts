import assert from "node:assert/strict";
import test from "node:test";
import type { RawDocument } from "../../src/core/contracts.js";
import { extractFields } from "../../src/core/extract-fields.js";
import { normalizeDocument } from "../../src/core/normalize-document.js";

const html = "<!doctype html><html><head><title> Example </title><style>.x{}</style></head><body><main><h1>Hello</h1><a href='/a'>One</a><a href='/b'>Two</a><script>bad()</script></main></body></html>";
const raw: RawDocument = { requestedUrl: "https://example.com", finalUrl: "https://example.com", status: 200, headers: {}, contentType: "text/html", body: new TextEncoder().encode(html), engine: "http", backend: "direct" };

void test("normalizeDocument produces cleaned text, markdown and bounded Unicode output", () => {
  const text = normalizeDocument(raw, "text", 100);
  assert.equal(text.title, "Example"); assert.match(text.content, /Hello/); assert.doesNotMatch(text.content, /bad/);
  assert.match(normalizeDocument(raw, "markdown", 100).content, /# Hello/);
  const truncated = normalizeDocument({ ...raw, body: new TextEncoder().encode("😀😀") }, "text", 1);
  assert.equal(truncated.content, "😀"); assert.equal(truncated.truncated, true);
});

void test("normalizeDocument applies selectors and reports invalid/unmatched selectors", () => {
  assert.match(normalizeDocument(raw, "html", 100, "main").content, /<h1>Hello<\/h1>/);
  assert.throws(() => normalizeDocument(raw, "text", 100, "["), { code: "INVALID_INPUT" });
  assert.throws(() => normalizeDocument(raw, "text", 100, ".missing"), { code: "INVALID_INPUT" });
});

void test("extractFields deterministically extracts text, HTML, attributes and arrays", () => {
  const result = extractFields(html, [
    { name: "heading", selector: "h1", value: "text" },
    { name: "links", selector: "a", value: "attribute", attribute: "href", many: true },
    { name: "missing", selector: ".none", value: "html" },
  ], { maxFields: 5, maxValuesPerField: 5, maxOutputChars: 1_000 });
  assert.deepEqual(result.data, { heading: "Hello", links: ["/a", "/b"], missing: null });
  assert.deepEqual(result.missingFields, ["missing"]);
});

void test("extractFields validates names, selectors, attributes and output bound", () => {
  const limits = { maxFields: 2, maxValuesPerField: 2, maxOutputChars: 10 };
  assert.throws(() => extractFields(html, [{ name: "bad-name", selector: "h1", value: "text" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ name: "x", selector: "[", value: "text" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ name: "x", selector: "a", value: "attribute" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ name: "heading", selector: "h1", value: "text" }], limits), { code: "OUTPUT_LIMIT" });
});
