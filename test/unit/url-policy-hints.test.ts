import assert from "node:assert/strict";
import test from "node:test";

import { GroundlaneError, type HintValue } from "../../src/core/errors.js";
import { parsePublicUrl, resolvePublicUrl, resolveRedirect, throwIfAborted } from "../../src/core/url-policy.js";

function readHint(error: unknown): HintValue | undefined {
  if (!(error instanceof Error) || !("hint" in error)) return undefined;
  const h = (error as { hint?: unknown }).hint;
  if (!h || typeof h !== "object") return undefined;
  const obj = h as { code?: unknown; text?: unknown };
  if (typeof obj.code !== "string" || typeof obj.text !== "string") return undefined;
  return { code: obj.code, text: obj.text };
}

void test("parsePublicUrl rejects non-URL with hint url.invalid", () => {
  try {
    parsePublicUrl("not a url");
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "url.invalid");
  }
});

void test("parsePublicUrl blocks ftp with hint url.blocked.invalid_protocol", () => {
  try {
    parsePublicUrl("ftp://example.com/file");
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "url.blocked.invalid_protocol");
  }
});

void test("parsePublicUrl blocks credentials with hint url.blocked.credentials", () => {
  try {
    parsePublicUrl("https://user:pass@example.com/");
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "url.blocked.credentials");
  }
});

void test("parsePublicUrl blocks bad port with hint url.blocked.invalid_port", () => {
  try {
    parsePublicUrl("http://example.com:8080/", new Set([80, 443]));
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "url.blocked.invalid_port");
  }
});

void test("parsePublicUrl allows 80/443 (control)", () => {
  assert.doesNotThrow(() => parsePublicUrl("https://example.com/"));
});

void test("resolvePublicUrl blocks localhost with hint dns.blocked.localhost", async () => {
  try {
    await resolvePublicUrl("http://localhost/");
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "dns.blocked.localhost");
  }
});

void test("resolvePublicUrl blocks private IP with hint dns.blocked.private_address", async () => {
  try {
    await resolvePublicUrl("http://10.0.0.1/");
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "dns.blocked.private_address");
  }
});

void test("resolveRedirect throws with hint redirect.invalid_location on malformed Location", () => {
  try {
    // Unterminated IPv6 host causes `new URL` to throw, exercising the catch.
    resolveRedirect(new URL("https://example.com/"), "http://[::1");
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "redirect.invalid_location");
  }
});

void test("throwIfAborted propagates an existing GroundlaneError reason verbatim", () => {
  const controller = new AbortController();
  controller.abort(new GroundlaneError("CANCELLED", "test", "custom"));
  try {
    throwIfAborted(controller.signal, "test", "fallback message");
    assert.fail("expected throw");
  } catch (error) {
    assert.equal((error as { code: string }).code, "CANCELLED");
  }
});

void test("throwIfAborted with no reason uses stage-prefixed hint", () => {
  const controller = new AbortController();
  controller.abort();
  try {
    throwIfAborted(controller.signal, "url", "aborted");
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "url.cancelled");
    assert.equal(hint.text, "aborted");
  }
});
