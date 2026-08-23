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
