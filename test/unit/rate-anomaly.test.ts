import assert from "node:assert/strict";
import test from "node:test";

import { RateAnomalyDetector } from "../../src/core/rate-anomaly.js";

void test("allows calls within the window limit", () => {
  const detector = new RateAnomalyDetector({ windowMs: 60_000, maxCallsPerWindow: 5, maxCallsPerToolPerWindow: 3 });
  const result = detector.record("cred-a", "web_search");
  assert.equal(result.allowed, true);
  assert.equal(result.callsInWindow, 1);
});

void test("blocks when total calls exceed window limit", () => {
  const detector = new RateAnomalyDetector({ windowMs: 60_000, maxCallsPerWindow: 3, maxCallsPerToolPerWindow: 10 });
  detector.record("cred-a", "web_search");
  detector.record("cred-a", "web_fetch");
  detector.record("cred-a", "parse");
  const result = detector.record("cred-a", "web_search");
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes("4 calls"));
  assert.equal(result.callsInWindow, 4);
  assert.equal(result.limit, 3);
});

void test("blocks when per-tool calls exceed limit", () => {
  const detector = new RateAnomalyDetector({ windowMs: 60_000, maxCallsPerWindow: 100, maxCallsPerToolPerWindow: 2 });
  detector.record("cred-a", "web_search");
  detector.record("cred-a", "web_search");
  const result = detector.record("cred-a", "web_search");
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes("web_search"));
  assert.equal(result.callsInWindow, 3);
  assert.equal(result.limit, 2);
});

void test("different credentials are tracked independently", () => {
  const detector = new RateAnomalyDetector({ windowMs: 60_000, maxCallsPerWindow: 2, maxCallsPerToolPerWindow: 10 });
  detector.record("cred-a", "web_search");
  detector.record("cred-a", "web_search");
  const resultA = detector.record("cred-a", "web_search");
  assert.equal(resultA.allowed, false);

  const resultB = detector.record("cred-b", "web_search");
  assert.equal(resultB.allowed, true);
});

void test("different tools are tracked independently for per-tool limit", () => {
  const detector = new RateAnomalyDetector({ windowMs: 60_000, maxCallsPerWindow: 100, maxCallsPerToolPerWindow: 2 });
  detector.record("cred-a", "web_search");
  detector.record("cred-a", "web_search");
  const searchResult = detector.record("cred-a", "web_search");
  assert.equal(searchResult.allowed, false);

  const fetchResult = detector.record("cred-a", "web_fetch");
  assert.equal(fetchResult.allowed, true);
});

void test("uses default options when none provided", () => {
  const detector = new RateAnomalyDetector();
  const result = detector.record("cred-a", "web_search");
  assert.equal(result.allowed, true);
  assert.equal(result.limit, 100);
});

void test("reason message includes window duration", () => {
  const detector = new RateAnomalyDetector({ windowMs: 120_000, maxCallsPerWindow: 1, maxCallsPerToolPerWindow: 10 });
  detector.record("cred-a", "web_search");
  const result = detector.record("cred-a", "web_fetch");
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes("120s"));
});
