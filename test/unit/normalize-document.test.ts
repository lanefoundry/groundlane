import assert from "node:assert/strict";
import test from "node:test";
import type { RawDocument } from "../../src/core/contracts.js";
import { normalizeDocument } from "../../src/core/normalize-document.js";

function raw(requestedUrl: string, finalUrl: string, body: string): RawDocument {
  return { requestedUrl, finalUrl, status: 200, headers: {}, contentType: "text/html", body: new TextEncoder().encode(body), engine: "browser", backend: "browser" };
}

void test("normalizeDocument flags a redirect that lands on a login page", () => {
  const result = normalizeDocument(raw("https://example.com/app/doc", "https://example.com/login?returnTo=%2Fapp%2Fdoc", "<html><body>Sign in to continue</body></html>"), "text", 1_000);
  assert.ok(result.warnings.includes("navigation ended at a login page; the target content likely requires authentication"));
});

void test("normalizeDocument does not flag a direct fetch of a login page without redirect", () => {
  const result = normalizeDocument(raw("https://example.com/login", "https://example.com/login", "<html><body>Sign in</body></html>"), "text", 1_000);
  assert.ok(!result.warnings.some((warning) => warning.includes("login")));
});

void test("normalizeDocument flags an empty document after rendering", () => {
  const result = normalizeDocument(raw("https://example.com/", "https://example.com/", "<html><head><script>boot()</script></head><body></body></html>"), "text", 1_000);
  assert.ok(result.warnings.includes("document contained no extractable text"));
});

const heroParagraph = "Run experiments, manage feature flags, and let your data warehouse do the heavy lifting with statistical defaults built on years of operating evidence. ".repeat(4);
const cardTitles = ["Sequential testing, guardrails, CUPED. Built in.", "Ramps up while metrics hold.", "Same numbers, everywhere.", "Flags that clean up after themselves.", "Get the answer, and the cause.", "No vendor lock-in.", "Typed schemas and targeting.", "Sessions behind the stats.", "Warehouse powered analytics.", "Automatic guardrails.", "Variance reduction by default.", "Migration kits for SDKs."];
const cards = cardTitles.map((title, index) => `<a class="card" href="/f${index}"><h3>${title} Capability ${index} for every product team that wants evidence.</h3></a>`).join("");
const posts = [1, 2, 3, 4, 5].map((index) => `<li><a href="/blog/${index}">Introducing thing ${index}</a> short teaser ${index}</li>`).join("");
const landingPage = `<html><head><title>Product</title></head><body><nav><a href="/pricing">Pricing</a><a href="/blog">Blog</a></nav><div id="root"><div id="content"><div class="wrap"><section><h1>Ship every product decision with evidence behind it.</h1><p>${heroParagraph}</p></section></div></div><div class="grid"><div class="row">${cards}</div></div><div class="stats"><b>300+</b>Teams<b>750M+</b>Users</div><div class="list"><ul>${posts}</ul></div></div><footer><a href="/terms">Terms</a></footer></body></html>`;

void test("normalizeDocument extract=full keeps landing-page structure that article extraction drops", () => {
  const source = raw("https://example.com/", "https://example.com/", landingPage);
  const full = normalizeDocument(source, "markdown", 50_000, undefined, "full");
  assert.ok(full.content.includes("Sequential testing, guardrails, CUPED. Built in."));
  assert.ok(full.content.includes("Flags that clean up after themselves."));
  assert.ok(full.content.includes("Introducing thing 3"));
  assert.equal(full.warnings.some((warning) => warning.includes("content extraction")), false);
});

void test("normalizeDocument warns when article extraction removes most of the page", () => {
  const source = raw("https://example.com/", "https://example.com/", landingPage);
  const article = normalizeDocument(source, "markdown", 50_000);
  assert.ok(!article.content.includes("Flags that clean up after themselves."));
  assert.ok(article.warnings.some((warning) => warning.includes("content extraction removed most of the page")));
});

void test("normalizeDocument does not warn when article extraction keeps the page", () => {
  const body = `<html><body><article><h1>Title</h1>${"<p>This is a real paragraph of article text that should be kept intact.</p>".repeat(8)}</article></body></html>`;
  const result = normalizeDocument(raw("https://example.com/a", "https://example.com/a", body), "markdown", 50_000);
  assert.equal(result.warnings.some((warning) => warning.includes("content extraction")), false);
});
