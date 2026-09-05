import assert from "node:assert/strict";
import test from "node:test";
import { validateSmokeEndpoint, validateUploadEndpoint, verifyCacheResult } from "../../scripts/smoke-document-cache.mjs";

void test("cache smoke only permits the isolated staging worker or loopback", () => {
  for (const url of ["https://groundlane-prd-staging.example.workers.dev/mcp", "http://127.0.0.1:8080/mcp", "http://localhost:8080/mcp"]) {
    assert.equal(validateSmokeEndpoint(url).pathname, "/mcp");
  }
  for (const url of ["https://groundlane.example.workers.dev/mcp", "https://groundlane-prd-staging.evil.test/mcp", "https://groundlane-prd-staging.example.workers.dev.evil.test/mcp", "http://groundlane-prd-staging.example.workers.dev/mcp", "https://user:secret@groundlane-prd-staging.example.workers.dev/mcp", "http://127.0.0.1:8080/mcp?secret=x", "http://127.0.0.1:8080/admin"]) {
    assert.throws(() => validateSmokeEndpoint(url), /Unsafe smoke endpoint/u);
  }
});

void test("upload handoff destination stays on R2 and rejects redirects or arbitrary origins", () => {
  assert.equal(validateUploadEndpoint("https://abc123.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=secret").hostname, "abc123.r2.cloudflarestorage.com");
  for (const url of ["https://evil.test/a", "http://abc123.r2.cloudflarestorage.com/a", "https://abc123.r2.cloudflarestorage.com:444/a", "https://user:secret@abc123.r2.cloudflarestorage.com/a", "https://abc123.r2.cloudflarestorage.com.evil.test/a"]) {
    assert.throws(() => validateUploadEndpoint(url), /Unsafe upload endpoint/u);
  }
});

const miss = { cached: false, cache: { requestedMode: "use", enabled: true, stored: true, createdAt: 1000, expiresAt: 61000 }, envelope: { canonicalContentId: "content-1", sourceIdentity: { contentHash: "hash-1", filename: "a.json" } } };
void test("cache smoke rejects degraded execution and false cache successes", () => {
  verifyCacheResult(miss, "use", false, true);
  for (const value of [
    { ...miss, cached: true },
    { ...miss, cache: { ...miss.cache, enabled: false } },
    { ...miss, cache: { ...miss.cache, degraded: true } },
    { ...miss, cache: { ...miss.cache, error: "upstream secret" } },
    { ...miss, cache: { ...miss.cache, expiresAt: 999 } },
  ]) assert.throws(() => verifyCacheResult(value, "use", false, true));
  assert.throws(() => verifyCacheResult({ ...miss, cached: true, cache: { ...miss.cache, stored: false } }, "use", true, false));
  verifyCacheResult({ ...miss, cached: true, cache: { ...miss.cache, stored: false, ageSeconds: 0, originalEngine: "groundlane", originalModel: "none" } }, "use", true, false);
});
