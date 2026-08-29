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
    <html>
      <head>
        <title>Fallback title</title>
        <meta property="og:title" content="Reader title">
        <meta name="description" content="A useful summary">
        <meta name="author" content="Groundlane Team">
        <meta property="article:published_time" content="2026-08-22T08:00:00Z">
      </head>
      <body>
        <nav>Products Pricing Login</nav>
        <main>
          <article>
            <h1>Reader title</h1>
            <p>This is the primary article body with enough useful text to be selected.</p>
            <p>It includes a <a href="/docs/reader">reader guide</a> for agents.</p>
            <p><a href="javascript:alert(1)">unsafe link</a><img src="data:image/png;base64,abc" alt="unsafe image"></p>
            <aside>Related promotion</aside>
          </article>
        </main>
        <footer>Copyright and footer links</footer>
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
  const page = "<html><body><nav>Selected navigation</nav><div>Short but useful body copy.</div></body></html>";
  const pageRaw = { ...raw, body: new TextEncoder().encode(page) };

  assert.match(normalizeDocument(pageRaw, "text", 1_000).content, /Short but useful body copy/u);
  assert.equal(
    normalizeDocument(pageRaw, "text", 1_000, "nav").content,
    "Selected navigation",
  );
});

void test("normalizeDocument bounds article metadata without splitting Unicode", () => {
  const page = `<html><head><meta name="description" content="${"😀".repeat(1_001)}"></head><body><main>Readable body</main></body></html>`;
  const result = normalizeDocument(
    { ...raw, body: new TextEncoder().encode(page) },
    "text",
    1_000,
  );

  assert.equal(Array.from(result.description ?? "").length, 1_000);
  assert.match(result.description ?? "", /^😀+$/u);
});

void test("extractReadableDocument resolves public links and strips unsafe URL schemes", () => {
  const page = `<html><head><title>Safe Reader</title></head><body><article>
    <h1>Safe Reader</h1>
    <p>This paragraph is intentionally long enough for deterministic article extraction.</p>
    <p><a href="/guide">public guide</a><a href="javascript:alert(1)" onclick="alert(2)">unsafe link</a></p>
    <img src="data:image/png;base64,abc" srcset="data:image/png;base64,def 2x" onerror="alert(3)" alt="unsafe image">
  </article></body></html>`;
  const result = extractReadableDocument(page, "https://example.com/posts/reader");

  assert.match(result.html, /href="https:\/\/example\.com\/guide"/u);
  assert.doesNotMatch(result.html, /javascript:|data:image|onclick|onerror|srcset/u);
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
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "x", flags: "s" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "x", flags: "ii" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "(a+)+" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "(?=Hello)Hello" }], limits), { code: "INVALID_INPUT" });
  assert.throws(() => extractFields(html, [{ engine: "pattern", name: "x", pattern: "(Hello)\\1" }], limits), { code: "INVALID_INPUT" });
  assert.throws(
    () => extractFields("x".repeat(1_000_001), [{ engine: "pattern", name: "x", pattern: "x" }], limits),
    { code: "OUTPUT_LIMIT" },
  );
});
