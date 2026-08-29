import assert from "node:assert/strict";
import test from "node:test";

import { DynamicPenaltyHealthTracker } from "../../src/core/provider-health.js";

void test("DynamicPenaltyHealthTracker starts healthy with zero penalty", () => {
  const tracker = new DynamicPenaltyHealthTracker();
  assert.equal(tracker.isHealthy("tavily"), true);
  assert.equal(tracker.penalty("tavily"), 0);
});

void test("DynamicPenaltyHealthTracker increments penalty on failure", () => {
  const time = 0;
  const tracker = new DynamicPenaltyHealthTracker(
    { penaltyIncrement: 3, decayPerMinute: 1, circuitThreshold: 5, circuitCooldownMs: 60_000 },
    () => time,
  );
  tracker.recordFailure("tavily");
  assert.equal(tracker.penalty("tavily"), 3);
  tracker.recordFailure("tavily");
  assert.equal(tracker.penalty("tavily"), 6);
});

void test("DynamicPenaltyHealthTracker decays penalty over time", () => {
  let time = 0;
  const tracker = new DynamicPenaltyHealthTracker(
    { penaltyIncrement: 3, decayPerMinute: 1, circuitThreshold: 10, circuitCooldownMs: 60_000 },
    () => time,
  );
  tracker.recordFailure("exa");
  assert.equal(tracker.penalty("exa"), 3);
  time += 60_000;
  assert.equal(tracker.penalty("exa"), 2);
  time += 120_000;
  assert.equal(tracker.penalty("exa"), 0);
});

void test("DynamicPenaltyHealthTracker resets on success", () => {
  const tracker = new DynamicPenaltyHealthTracker();
  tracker.recordFailure("brave");
  tracker.recordFailure("brave");
  assert.ok(tracker.penalty("brave") > 0);
  tracker.recordSuccess("brave");
  assert.equal(tracker.isHealthy("brave"), true);
  tracker.recordSuccess("brave");
  assert.equal(tracker.penalty("brave") < 6, true);
});

void test("DynamicPenaltyHealthTracker trips circuit breaker after threshold failures", () => {
  const time = 0;
  const tracker = new DynamicPenaltyHealthTracker(
    { penaltyIncrement: 3, decayPerMinute: 1, circuitThreshold: 3, circuitCooldownMs: 10_000 },
    () => time,
  );
  tracker.recordFailure("serpapi");
  assert.equal(tracker.isHealthy("serpapi"), true);
  tracker.recordFailure("serpapi");
  assert.equal(tracker.isHealthy("serpapi"), true);
  tracker.recordFailure("serpapi");
  assert.equal(tracker.isHealthy("serpapi"), false);
});

void test("DynamicPenaltyHealthTracker circuit breaker recovers after cooldown", () => {
  let time = 0;
  const tracker = new DynamicPenaltyHealthTracker(
    { penaltyIncrement: 3, decayPerMinute: 1, circuitThreshold: 3, circuitCooldownMs: 10_000 },
    () => time,
  );
  tracker.recordFailure("x");
  tracker.recordFailure("x");
  tracker.recordFailure("x");
  assert.equal(tracker.isHealthy("x"), false);
  time += 10_000;
  assert.equal(tracker.isHealthy("x"), true);
});

void test("DynamicPenaltyHealthTracker circuit re-opens on failure during half-open", () => {
  let time = 0;
  const tracker = new DynamicPenaltyHealthTracker(
    { penaltyIncrement: 3, decayPerMinute: 1, circuitThreshold: 3, circuitCooldownMs: 10_000 },
    () => time,
  );
  tracker.recordFailure("y");
  tracker.recordFailure("y");
  tracker.recordFailure("y");
  time += 10_000;
  assert.equal(tracker.isHealthy("y"), true);
  tracker.recordFailure("y");
  assert.equal(tracker.isHealthy("y"), false);
});

void test("DynamicPenaltyHealthTracker circuit fully closes on success during half-open", () => {
  let time = 0;
  const tracker = new DynamicPenaltyHealthTracker(
    { penaltyIncrement: 3, decayPerMinute: 1, circuitThreshold: 3, circuitCooldownMs: 10_000 },
    () => time,
  );
  tracker.recordFailure("z");
  tracker.recordFailure("z");
  tracker.recordFailure("z");
  time += 10_000;
  tracker.recordSuccess("z");
  assert.equal(tracker.isHealthy("z"), true);
  tracker.recordFailure("z");
  assert.equal(tracker.isHealthy("z"), true);
});

void test("DynamicPenaltyHealthTracker isolates providers independently", () => {
  const tracker = new DynamicPenaltyHealthTracker(
    { penaltyIncrement: 3, decayPerMinute: 1, circuitThreshold: 2, circuitCooldownMs: 60_000 },
  );
  tracker.recordFailure("a");
  tracker.recordFailure("a");
  assert.equal(tracker.isHealthy("a"), false);
  assert.equal(tracker.isHealthy("b"), true);
  assert.equal(tracker.penalty("b"), 0);
});
