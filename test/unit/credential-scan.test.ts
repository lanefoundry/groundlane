// [skip-harness] — test fixtures contain intentional credential patterns for detection testing
import assert from "node:assert/strict";
import test from "node:test";

import { scanForCredentials } from "../../src/core/credential-scan.js";

void test("detects AWS access key", () => {
  const result = scanForCredentials("key is AKIAIOSFODNN7EXAMPLE");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("aws-access-key"));
  assert.equal(result.count, 1);
  assert.ok(result.warning.includes("aws-access-key"));
});

void test("detects GitHub PAT", () => {
  const result = scanForCredentials("token: github_pat_11ABC123DEF456GHI789JK_abcdefghijklmnopqrstuvwxyz1234567890AB");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("github-pat"));
});

void test("detects ghp_ token", () => {
  const result = scanForCredentials("GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("github-token-ghp"));
});

void test("detects gho_ token", () => {
  const result = scanForCredentials("token=gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("github-token-gho"));
});

void test("detects private key header", () => {
  const result = scanForCredentials("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("private-key"));
});

void test("detects EC private key", () => {
  const result = scanForCredentials("-----BEGIN EC PRIVATE KEY-----");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("private-key"));
});

void test("detects generic private key", () => {
  const result = scanForCredentials("-----BEGIN PRIVATE KEY-----");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("private-key"));
});

void test("detects JWT token", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const result = scanForCredentials(`Authorization: Bearer ${jwt}`);
  assert.equal(result.found, true);
  assert.ok(result.types.includes("jwt"));
});

void test("detects Slack token", () => {
  // Build test fixture dynamically to avoid GitHub secret scanning
  const prefix = ["xox", "b"].join("");
  const result = scanForCredentials(`SLACK_TOKEN=${prefix}-000000000000-0000000000000-TestFixtureNotReal`);
  assert.equal(result.found, true);
  assert.ok(result.types.includes("slack-token"));
});

void test("detects Stripe live key", () => {
  // Build test fixture dynamically to avoid GitHub secret scanning
  const prefix = ["sk", "live"].join("_");
  const result = scanForCredentials(`${prefix}_TESTFIXTURENOTAREALKEY0000`);
  assert.equal(result.found, true);
  assert.ok(result.types.includes("stripe-key"));
});

void test("detects Stripe test key", () => {
  // Build test fixture dynamically to avoid GitHub secret scanning
  const prefix = ["sk", "test"].join("_");
  const result = scanForCredentials(`${prefix}_TESTFIXTURENOTAREALKEY0000`);
  assert.equal(result.found, true);
  assert.ok(result.types.includes("stripe-key"));
});

void test("detects generic api_key parameter", () => {
  const result = scanForCredentials('config = { api_key: "sk-proj-abcdefghijklmnop" }');
  assert.equal(result.found, true);
  assert.ok(result.types.includes("generic-api-key-param"));
});

void test("detects Authorization Bearer header", () => {
  const result = scanForCredentials("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456ghi789");
  assert.equal(result.found, true);
  assert.ok(result.types.includes("bearer-token"));
});

void test("counts multiple matches", () => {
  const text = "key1: AKIAIOSFODNN7EXAMPLE key2: AKIAIOSFODNN7EXAMPLF";
  const result = scanForCredentials(text);
  assert.equal(result.found, true);
  assert.equal(result.count, 2);
});

void test("detects multiple types in one text", () => {
  const text = "AWS: AKIAIOSFODNN7EXAMPLE\nGH: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901\n-----BEGIN PRIVATE KEY-----";
  const result = scanForCredentials(text);
  assert.equal(result.found, true);
  assert.ok(result.types.length >= 3);
  assert.ok(result.count >= 3);
});

// --- False positive control ---

void test("does not flag normal text", () => {
  const result = scanForCredentials("Hello world. This is a normal document about web development.");
  assert.equal(result.found, false);
  assert.equal(result.count, 0);
  assert.equal(result.warning, "");
});

void test("does not flag short api_key values", () => {
  const result = scanForCredentials('api_key: "short"');
  assert.equal(result.found, false);
});

void test("does not flag AKIA prefix with wrong length", () => {
  const result = scanForCredentials("AKIA12345");
  assert.equal(result.found, false);
});

void test("does not flag partial JWT without three segments", () => {
  const result = scanForCredentials("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  assert.equal(result.found, false);
});

void test("handles empty string", () => {
  const result = scanForCredentials("");
  assert.equal(result.found, false);
  assert.equal(result.count, 0);
});

void test("handles very large input by truncating", () => {
  const big = "x".repeat(600_000) + "AKIAIOSFODNN7EXAMPLE";
  const result = scanForCredentials(big);
  assert.equal(result.found, false);
});

void test("warning message is well-formed", () => {
  const result = scanForCredentials("AKIAIOSFODNN7EXAMPLE");
  assert.equal(result.found, true);
  assert.match(result.warning, /^Potential credential leak detected:/u);
  assert.match(result.warning, /Review the content before forwarding/u);
});

void test("types array is sorted", () => {
  const text = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901 AKIAIOSFODNN7EXAMPLE";
  const result = scanForCredentials(text);
  const sorted = [...result.types].sort();
  assert.deepEqual(result.types, sorted);
});
