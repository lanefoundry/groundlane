import assert from "node:assert/strict";
import test from "node:test";

import { parseDocument } from "../../src/core/parse-document.js";

const html = `<!doctype html>
<html>
  <head>
    <title>Parser Fixture</title>
    <link rel="canonical" href="/canonical">
    <meta name="description" content="A deterministic parser fixture">
    <meta name="author" content="Groundlane">
    <meta property="article:published_time" content="2026-08-30T00:00:00Z">
    <meta property="og:title" content="OpenGraph Title">
  </head>
  <body>
    <nav><a href="/noise">Noise</a></nav>
    <main>
      <article>
        <h1>Parser Fixture</h1>
        <p>Groundlane parses documents into useful structures.</p>
        <a href="/docs" rel="help">Docs</a>
        <a href="mailto:hello@example.com">Mail</a>
        <img src="/image.png" alt="Preview image">
        <table>
          <caption>Scores</caption>
          <thead><tr><th>Name</th><th>Score</th></tr></thead>
          <tbody><tr><td>Groundlane</td><td>10</td></tr></tbody>
        </table>
      </article>
    </main>
  </body>
</html>`;

void test("parseDocument extracts document, metadata, links, media and tables", () => {
  const parsed = parseDocument(html, {
    purpose: "all",
    baseUrl: "https://example.com/base/page",
    maxOutputChars: 20_000,
  });

  assert.equal(parsed.purpose, "all");
  assert.equal(parsed.title, "OpenGraph Title");
  assert.equal(parsed.description, "A deterministic parser fixture");
  assert.equal(parsed.author, "Groundlane");
  assert.equal(parsed.publishedAt, "2026-08-30T00:00:00Z");
  assert.equal(parsed.canonicalUrl, "https://example.com/canonical");
  assert.match(parsed.text ?? "", /Groundlane parses documents/u);
  assert.deepEqual(parsed.links?.find((link) => link.text === "Docs"), {
    url: "https://example.com/docs",
    text: "Docs",
    rel: "help",
    internal: true,
  });
  assert.deepEqual(parsed.images?.[0], {
    url: "https://example.com/image.png",
    alt: "Preview image",
  });
  assert.deepEqual(parsed.tables?.[0], {
    caption: "Scores",
    headers: ["Name", "Score"],
    rows: [
      ["Name", "Score"],
      ["Groundlane", "10"],
    ],
  });
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.warnings, []);
});

void test("parseDocument can return a purpose-specific subset", () => {
  const parsed = parseDocument(html, {
    purpose: "links",
    baseUrl: "https://example.com/base/page",
    maxOutputChars: 20_000,
  });

  assert.equal(parsed.purpose, "links");
  assert.equal(parsed.text, undefined);
  assert.equal(parsed.metadata, undefined);
  assert.equal(parsed.images, undefined);
  assert.equal(parsed.tables, undefined);
  assert.equal(parsed.links?.some((link) => link.url.startsWith("mailto:")), false);
});

void test("parseDocument prefers explicit metadata titles", () => {
  const parsed = parseDocument(`<!doctype html>
    <html><head>
      <title>Page Title - Site</title>
      <meta name="twitter:title" content="Twitter Title">
      <meta property="og:title" content="OpenGraph Title">
    </head><body><main><h1>Main Heading</h1></main></body></html>`, {
    purpose: "metadata",
    baseUrl: "https://example.com/",
    maxOutputChars: 20_000,
  });

  assert.equal(parsed.title, "OpenGraph Title");
});

void test("parseDocument uses h1 before a site-suffixed page title", () => {
  const parsed = parseDocument(`<!doctype html>
    <html><head><title>Article Fixture - Site</title></head>
    <body><main><h1>Article Fixture</h1><p>Body</p></main></body></html>`, {
    purpose: "metadata",
    baseUrl: "https://example.com/",
    maxOutputChars: 20_000,
  });

  assert.equal(parsed.title, "Article Fixture");
});

void test("parseDocument falls back to cleaned page title", () => {
  const parsed = parseDocument(`<!doctype html>
    <html><head><title>Standalone Documentation | Groundlane</title></head>
    <body><p>Body</p></body></html>`, {
    purpose: "metadata",
    baseUrl: "https://example.com/",
    maxOutputChars: 20_000,
  });

  assert.equal(parsed.title, "Standalone Documentation");
});

void test("parseDocument rejects empty input and bounds large parsed output", () => {
  assert.throws(
    () => parseDocument("   ", {
      purpose: "all",
      baseUrl: "https://example.com/",
      maxOutputChars: 1_000,
    }),
    { code: "INVALID_INPUT" },
  );

  assert.throws(
    () => parseDocument(`<main>${"<p>large</p>".repeat(1_000)}</main>`, {
      purpose: "all",
      baseUrl: "https://example.com/",
      maxOutputChars: 1_000,
    }),
    { code: "OUTPUT_LIMIT" },
  );
});
