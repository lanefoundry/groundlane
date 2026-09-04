import assert from "node:assert/strict";
import test from "node:test";
import type { RawDocument } from "../../src/core/contracts.js";
import { extractFields } from "../../src/core/extract-fields.js";
import { normalizeDocument } from "../../src/core/normalize-document.js";
import { extractReadableDocument } from "../../src/core/readable-document.js";

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

void test("normalizeDocument reads the primary article and excludes page chrome", () => {
  const page = `<!doctype html>
<html lang="en">
  <head>
    <title>Reader title</title>
    <meta name="description" content="A useful summary">
    <meta name="author" content="Groundlane Team">
    <meta property="article:published_time" content="2026-08-22T08:00:00Z">
  </head>
  <body>
    <header>Products Pricing Login</header>
    <main>
      <article>
        <h1>Reader title</h1>
        <p>primary article body with <a href="/docs/reader">docs link</a>.</p>
        <img src="data:image/png;base64,AAAA" alt="chart">
      </article>
    </main>
    <aside>Related promotion</aside>
    <footer>Copyright</footer>
  </body>
</html>`;
  const result = normalizeDocument(
    { ...raw, finalUrl: "https://example.com/posts/reader", body: new TextEncoder().encode(page) },
    "markdown",
    2_000,
  );

  assert.equal(result.title, "Reader title");
  assert.equal(result.description, "A useful summary");
  assert.equal(result.author, "Groundlane Team");
  assert.equal(result.publishedAt, "2026-08-22T08:00:00Z");
  assert.match(result.content, /primary article body/u);
  assert.match(result.content, /https:\/\/example\.com\/docs\/reader/u);
  assert.doesNotMatch(result.content, /javascript:|data:image/u);
  assert.doesNotMatch(result.content, /Products Pricing Login|Related promotion|Copyright/u);
});

void test("normalizeDocument falls back to body content and preserves selector semantics", () => {
  const page = "<!doctype html><html><body><main><p>primary body fallback</p></main></body></html>";
  const result = normalizeDocument({ ...raw, body: new TextEncoder().encode(page) }, "markdown", 200);
  assert.match(result.content, /primary body fallback/u);
  assert.doesNotMatch(result.content, /<main>/u);
});

void test("normalizeDocument bounds article metadata without splitting Unicode", () => {
  const page = "<!doctype html><html><body><main><article><h1>Title</h1><p>Body text that should fit well within the cap.</p></article></main></body></html>";
  const truncated = normalizeDocument({ ...raw, body: new TextEncoder().encode(page) }, "markdown", 12);
  assert.equal(truncated.truncated, true);
  assert.match(truncated.content, /Title/u);
});

void test("extractReadableDocument strips unsafe URL schemes from sanitized html", () => {
  const page = `<!doctype html><html><body><main><a href="https://example.com/docs">Docs</a><a href="javascript:alert(1)">Run</a><a href="data:text/html;base64,xxx">Embed</a></main></body></html>`;
  const doc = extractReadableDocument(page, "https://example.com");
  assert.match(doc.html, /https:\/\/example\.com\/docs/u);
  assert.doesNotMatch(doc.html, /javascript:|data:text\/html/u);
});

void test("extractFields deterministically extracts text, HTML, attributes and arrays", () => {
  const page = "<!doctype html><html><body><main><h1>One</h1><h1>Two</h1><a href='/a'>A</a><a href='/b'>B</a><img src='/x.png' alt='pic'/></main></body></html>";
  const result = extractFields(page, [
    { name: "headings", selector: "h1", value: "text", many: true },
    { name: "links", selector: "a", value: "attribute", attribute: "href", many: true },
    { name: "firstHeadingHtml", selector: "h1", value: "html" },
    { name: "imgAlt", selector: "img", value: "attribute", attribute: "alt" },
  ], { maxFields: 10, maxValuesPerField: 5, maxOutputChars: 5_000 });

  assert.deepEqual(result.data, {
    headings: ["One", "Two"],
    links: ["/a", "/b"],
    firstHeadingHtml: "One",
    imgAlt: "pic",
  });
});

void test("extractFields validates names, selectors, attributes and output bound", () => {
  const limits = { maxFields: 5, maxValuesPerField: 5, maxOutputChars: 50 };
  assert.throws(() => extractFields(html, [{ name: "1bad", selector: "h1", value: "text" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ name: "x", selector: "[", value: "text" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ name: "x", selector: "h1", value: "attribute" }], limits), { code: "INVALID_INPUT" });
  assert.throws(
    () => extractFields(html, [{ name: "x", selector: "h1", value: "html", many: true }], { maxFields: 1, maxValuesPerField: 100, maxOutputChars: 5 }),
    { code: "OUTPUT_LIMIT" },
  );
});

void test("extractFields supports bounded deterministic pattern extraction", () => {
  const page = "Plan: Starter costs $19/month. Plan: Pro costs $49/month.";
  const result = extractFields(page, [
    {
      engine: "pattern",
      name: "plans",
      pattern: "Plan:\\s+(?<plan>[A-Za-z]+)\\s+costs\\s+\\$\\d+\\/month",
      group: "plan",
      many: true,
    },
    { engine: "pattern", name: "firstPrice", pattern: "\\$(\\d+)\\/month", group: 1 },
    { engine: "pattern", name: "missing", pattern: "Enterprise:\\s+(\\w+)" },
  ], { maxFields: 5, maxValuesPerField: 1, maxOutputChars: 1_000 });

  assert.deepEqual(result.data, {
    plans: ["Starter"],
    firstPrice: "19",
    missing: null,
  });
  assert.deepEqual(result.missingFields, ["missing"]);
});

void test("extractFields validates pattern shape", () => {
  const limits = { maxFields: 3, maxValuesPerField: 3, maxOutputChars: 1_000 };
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "[" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "x", flags: "ii" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "x", flags: "g" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "(a+)+" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "(?=Hello)Hello" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "(Hello)\\1" }], limits), { code: "INVALID_INPUT" });
  assert.throws(
    () => extractFields("x".repeat(1_000_001), [{ engine: "pattern", name: "x", pattern: "x" }], limits),
    { code: "OUTPUT_LIMIT" },
  );
});

void test("extractFields supports s flag and inline (?is) modifier for cross-line patterns", () => {
  const crossLineHtml = "line1\nKEY=42\nline2\nKEY=99";
  const limits = { maxFields: 4, maxValuesPerField: 5, maxOutputChars: 1_000 };

  const withExplicitS = extractFields(crossLineHtml, [
    { engine: "pattern", name: "k", pattern: "line\\d\\sKEY=(\\d+)", flags: "s", group: 1, many: true },
  ], limits);
  assert.deepEqual(withExplicitS.data.k, ["42", "99"]);

  const withInline = extractFields(crossLineHtml, [
    { engine: "pattern", name: "k", pattern: "(?is)line\\d\\sKEY=(\\d+)", group: 1, many: true },
  ], limits);
  assert.deepEqual(withInline.data.k, ["42", "99"]);

  const merged = extractFields(crossLineHtml, [
    { engine: "pattern", name: "k", pattern: "(?i)line\\d\\sKEY=(\\d+)", flags: "s", group: 1, many: true },
  ], limits);
  assert.deepEqual(merged.data.k, ["42", "99"]);
});

void test("extractFields rejects unsupported inline modifier flags", () => {
  const limits = { maxFields: 1, maxValuesPerField: 1, maxOutputChars: 1_000 };
  assert.throws(
    () => extractFields("x", [{ engine: "pattern", name: "x", pattern: "(?g)x" }], limits),
    { code: "INVALID_INPUT" },
  );
});

void test("extractFields attaches hint to OUTPUT_LIMIT errors", () => {
  const limits = { maxFields: 1, maxValuesPerField: 1, maxOutputChars: 1_000 };
  try {
    extractFields("x".repeat(1_000_001), [{ engine: "pattern", name: "x", pattern: "x" }], limits);
    assert.fail("expected throw");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !("hint" in error)) {
      assert.fail("expected GroundlaneError-shaped throw");
    }
    assert.equal((error as { code: string }).code, "OUTPUT_LIMIT");
    const hint = (error as { hint?: { code: string; text: string } }).hint;
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "extract.pattern.input_too_large");
    assert.match(hint.text, /Lower maxBytes/);
  }
});

// ---------------------------------------------------------------------------
// PRD 668: Parse flat schema compatibility (additive/versioned, no breaking)
// ---------------------------------------------------------------------------

void test("PRD 668: parse all-purpose flat schema keeps required fields", async () => {
  const { parseDocument } = await import("../../src/core/parse-document.js");
  const page = "<!doctype html><html><head><title>T</title></head><body><main><article><h1>T</h1><p>body</p></article></main></body></html>";
  const result = parseDocument(page, { purpose: "all", baseUrl: "https://example.com/a", maxOutputChars: 50_000 });
  for (const field of ["purpose", "truncated", "warnings"] as const) {
    assert.ok(field in result, `missing required flat field ${field}`);
  }
  assert.equal(result.purpose, "all");
  assert.equal(Array.isArray(result.warnings), true);
});

void test("PRD 668: parse additive change passes, required removal fails", async () => {
  const { validateParseBackwardCompat } = await import("../../src/core/document-source.js");
  const previous = {
    schemaVersion: "1.0.0",
    requiredFields: ["purpose", "truncated", "warnings"],
    optionalFields: ["title", "content"],
  };
  const additive = {
    schemaVersion: "1.1.0",
    requiredFields: ["purpose", "truncated", "warnings"],
    optionalFields: ["title", "content", "canonicalUrl", "tables"],
  };
  assert.doesNotThrow(() => validateParseBackwardCompat(previous, additive));
  const breaking = {
    schemaVersion: "2.0.0",
    requiredFields: ["purpose", "truncated"],
    optionalFields: ["title"],
  };
  assert.throws(() => validateParseBackwardCompat(previous, breaking), { message: /warnings/ });
});

void test("PRD 668: parse flat output has no canonical-envelope-only fields", async () => {
  const { parseDocument } = await import("../../src/core/parse-document.js");
  const page = "<!doctype html><html><head><title>T</title></head><body><main><p>body</p></main></body></html>";
  const result = parseDocument(page, { purpose: "all", baseUrl: "https://example.com/a", maxOutputChars: 50_000 }) as unknown as Record<string, unknown>;
  for (const envelopeOnly of ["canonicalContentId", "blocks", "readingOrder", "capabilityStates", "provenance", "schemaVersion", "documentId"]) {
    assert.equal(envelopeOnly in result, false, `${envelopeOnly} must not leak into flat parse schema`);
  }
});

void test("PRD 668: parse purpose narrowing keeps required-field contract", async () => {
  const { parseDocument } = await import("../../src/core/parse-document.js");
  const page = "<!doctype html><html><head><title>T</title></head><body><main><article><h1>T</h1><p>body</p><a href=\"/x\">X</a></article></main></body></html>";
  const options = { baseUrl: "https://example.com/a", maxOutputChars: 50_000 } as const;
  for (const purpose of ["document", "metadata", "links", "media", "tables", "all"] as const) {
    const result = parseDocument(page, { purpose, ...options });
    assert.equal(result.purpose, purpose);
    assert.equal(typeof result.truncated, "boolean");
    assert.ok(Array.isArray(result.warnings));
  }
});