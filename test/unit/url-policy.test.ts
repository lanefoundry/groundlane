import assert from "node:assert/strict";
import test from "node:test";
import { GroundlaneError } from "../../src/core/errors.js";
import { isPublicAddress, parsePublicUrl, resolvePublicUrl, resolveRedirect } from "../../src/core/url-policy.js";

void test("parsePublicUrl accepts default HTTP(S) and rejects unsafe forms", () => {
  assert.equal(parsePublicUrl("https://example.com/a").href, "https://example.com/a");
  for (const value of ["file:///etc/passwd", "https://user:pass@example.com", "http://example.com:8080"]) assert.throws(() => parsePublicUrl(value), GroundlaneError);
});

void test("address policy blocks private, metadata, reserved and mapped IPv6 ranges", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fc00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

void test("resolvePublicUrl rejects hostname when any DNS answer is private", async () => {
  await assert.rejects(resolvePublicUrl("https://example.com", { lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]) }), { code: "URL_BLOCKED" });
});

void test("resolvePublicUrl returns validated addresses and caches DNS", async () => {
  let calls = 0; const cache = new Map<string, readonly { address: string; family: 4 | 6 }[]>();
  const lookup = () => { calls += 1; return Promise.resolve([{ address: "93.184.216.34", family: 4 as const }]); };
  const first = await resolvePublicUrl("https://example.com/a", { lookup, cache });
  await resolvePublicUrl("https://example.com/b", { lookup, cache });
  assert.equal(first.addresses[0]?.address, "93.184.216.34"); assert.equal(calls, 1);
});

void test("resolvePublicUrl stops before DNS when validation is aborted", async () => {
  const controller = new AbortController();
  const reason = new GroundlaneError("DEADLINE_EXCEEDED", "provider-url", "Provider URL validation deadline exceeded", true);
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(
    resolvePublicUrl("https://example.com/a", {
      lookup: () => {
        calls += 1;
        return Promise.resolve([{ address: "93.184.216.34", family: 4 as const }]);
      },
      signal: controller.signal,
    }),
    { code: "DEADLINE_EXCEEDED" },
  );
  assert.equal(calls, 0);
});

void test("redirect resolution handles relative locations and rejects malformed targets", () => {
  assert.equal(resolveRedirect(new URL("https://example.com/a"), "/b"), "https://example.com/b");
  assert.throws(() => resolveRedirect(new URL("https://example.com"), "http://["), GroundlaneError);
});
