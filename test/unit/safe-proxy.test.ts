import assert from "node:assert/strict";
import test from "node:test";
import { parseConnectAuthority, sanitizeProxyHeaders } from "../../src/adapters/browser/safe-proxy.js";
import { detectChallenge } from "../../src/core/browser-policy.js";

void test("parseConnectAuthority handles host and IPv6 targets", () => {
  assert.deepEqual(parseConnectAuthority("example.com:443"), { hostname: "example.com", port: 443 });
  assert.deepEqual(parseConnectAuthority("[2606:4700:4700::1111]:8443"), { hostname: "[2606:4700:4700::1111]", port: 8443 });
  assert.throws(() => parseConnectAuthority("example.com:99999"));
});

void test("sanitizeProxyHeaders removes proxy credentials and preserves target host", () => {
  assert.deepEqual(sanitizeProxyHeaders({ host: "bad", "proxy-authorization": "secret", "proxy-connection": "keep-alive", accept: "text/html" }, "example.com"), { host: "example.com", accept: "text/html" });
});

void test("detectChallenge recognizes hardened browser challenge signals", () => {
  assert.equal(detectChallenge("Just a moment...", ""), true);
  assert.equal(detectChallenge("Example", "Verify you are human"), true);
  assert.equal(detectChallenge("Example", "Ordinary article"), false);
});
