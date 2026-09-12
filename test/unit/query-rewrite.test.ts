import assert from "node:assert/strict";
import test from "node:test";

import { rewriteQuery } from "../../src/core/query-rewrite.js";

void test("returns applied:false for clean queries", () => {
  const result = rewriteQuery("cloudflare workers wasm limit");
  assert.equal(result.applied, false);
  assert.deepEqual(result.strategies, []);
});

void test("removes filler prefix: please", () => {
  const result = rewriteQuery("please find cloudflare workers limits");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.includes("remove-filler"));
  assert.ok(!result.rewritten.toLowerCase().includes("please"));
});

void test("removes filler prefix: can you", () => {
  const result = rewriteQuery("can you search for node.js release schedule");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.includes("remove-filler"));
  assert.ok(!result.rewritten.toLowerCase().startsWith("can you"));
});

void test("removes filler prefix: I want to", () => {
  const result = rewriteQuery("I want to find react hooks documentation");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.includes("remove-filler"));
});

void test("removes filler prefix: find me", () => {
  const result = rewriteQuery("find me the latest typescript release");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.includes("remove-filler"));
});

void test("removes filler prefix: help me find", () => {
  const result = rewriteQuery("help me find rust async patterns");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.includes("remove-filler"));
});

void test("quotes proper nouns: two capitalized words", () => {
  const result = rewriteQuery("how to use Model Context Protocol with agents");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.includes("quote-proper-nouns"));
  assert.ok(result.rewritten.includes('"Model Context Protocol"'));
});

void test("quotes proper nouns: multi-word proper noun", () => {
  const result = rewriteQuery("Visual Studio Code extensions for python");
  assert.equal(result.applied, true);
  assert.ok(result.rewritten.includes('"Visual Studio Code"'));
});

void test("does not double-quote already quoted proper nouns", () => {
  const result = rewriteQuery('how to use "Model Context Protocol" with agents');
  assert.ok(!result.rewritten.includes('""Model Context Protocol""'));
});

void test("adds site: prefix for github.com", () => {
  const result = rewriteQuery("github.com groundlane mcp server");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.some((s) => s.startsWith("site-prefix")));
  assert.ok(result.rewritten.startsWith("site:github.com"));
  assert.ok(result.rewritten.includes("groundlane"));
});

void test("adds site: prefix for stackoverflow.com", () => {
  const result = rewriteQuery("stackoverflow.com typescript generic constraints");
  assert.equal(result.applied, true);
  assert.ok(result.rewritten.includes("site:stackoverflow.com"));
});

void test("adds site: prefix for MDN", () => {
  const result = rewriteQuery("mdn fetch api abortcontroller");
  assert.equal(result.applied, true);
  assert.ok(result.rewritten.includes("site:developer.mozilla.org"));
});

void test("does not add site: if already present", () => {
  const result = rewriteQuery("site:github.com groundlane");
  assert.equal(result.applied, false);
});

void test("combines multiple strategies", () => {
  const result = rewriteQuery("please find Model Context Protocol on github.com");
  assert.equal(result.applied, true);
  assert.ok(result.strategies.length >= 2);
  assert.ok(!result.rewritten.toLowerCase().includes("please"));
});

void test("handles empty query", () => {
  const result = rewriteQuery("");
  assert.equal(result.applied, false);
});

void test("handles whitespace-only query", () => {
  const result = rewriteQuery("   ");
  assert.equal(result.applied, false);
});

void test("does not rewrite short technical queries", () => {
  const result = rewriteQuery("npm install --save-dev");
  assert.equal(result.applied, false);
});

void test("preserves query when no strategies apply", () => {
  const original = "cloudflare workers cpu time limit 2026";
  const result = rewriteQuery(original);
  assert.equal(result.rewritten, original);
  assert.equal(result.applied, false);
});
