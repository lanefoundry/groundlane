import assert from "node:assert/strict";
import test from "node:test";

import {
  CompositeSearchBudget,
  consumeProviderAttemptBudget,
  DailySearchBudget,
  MinuteRateLimiter,
  MonthlySearchBudget,
} from "../../src/core/search-budget.js";

void test("MonthlySearchBudget atomically caps attempts and leaves unspecified providers unlimited", () => {
  const budget = new MonthlySearchBudget({ tavily: 2 });
  assert.equal(budget.remaining("tavily"), 2);
  assert.equal(budget.tryConsume("tavily"), true);
  assert.equal(budget.tryConsume("tavily"), true);
  assert.equal(budget.tryConsume("tavily"), false);
  assert.equal(budget.remaining("tavily"), 0);
  assert.equal(budget.tryConsume("custom"), true);
  assert.equal(budget.remaining("custom"), undefined);
});

void test("MonthlySearchBudget resets when the UTC month changes", () => {
  let now = new Date("2026-08-31T23:59:59Z");
  const budget = new MonthlySearchBudget({ serpapi: 1 }, () => now);
  assert.equal(budget.tryConsume("serpapi"), true);
  assert.equal(budget.tryConsume("serpapi"), false);
  now = new Date("2026-09-01T00:00:00Z");
  assert.equal(budget.remaining("serpapi"), 1);
  assert.equal(budget.tryConsume("serpapi"), true);
});

void test("MonthlySearchBudget rejects invalid limits", () => {
  assert.throws(() => new MonthlySearchBudget({ tavily: -1 }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => new MonthlySearchBudget({ tavily: 1.5 }), {
    code: "INVALID_INPUT",
  });
});

void test("DailySearchBudget caps attempts and resets at UTC day boundary", () => {
  let now = new Date("2026-08-24T23:59:59Z");
  const budget = new DailySearchBudget({ you: 2 }, () => now);
  assert.equal(budget.remaining("you"), 2);
  assert.equal(budget.tryConsume("you"), true);
  assert.equal(budget.tryConsume("you"), true);
  assert.equal(budget.tryConsume("you"), false);
  assert.equal(budget.remaining("you"), 0);
  now = new Date("2026-08-25T00:00:00Z");
  assert.equal(budget.remaining("you"), 2);
  assert.equal(budget.tryConsume("you"), true);
});

void test("DailySearchBudget leaves unspecified providers unlimited", () => {
  const budget = new DailySearchBudget({ you: 1 });
  assert.equal(budget.tryConsume("tavily"), true);
  assert.equal(budget.remaining("tavily"), undefined);
});

void test("DailySearchBudget snapshots configured and unbounded providers", () => {
  let now = new Date("2026-08-24T12:00:00Z");
  const budget = new DailySearchBudget({ you: 2 }, () => now);
  assert.equal(budget.tryConsume("you"), true);
  assert.deepEqual(budget.snapshots(["you", "tavily"]), [
    {
      period: "daily",
      provider: "you",
      limited: true,
      limit: 2,
      used: 1,
      remaining: 1,
      exhausted: false,
      resetAt: "2026-08-25T00:00:00.000Z",
    },
    {
      period: "daily",
      provider: "tavily",
      limited: false,
      used: 0,
      exhausted: false,
      resetAt: "2026-08-25T00:00:00.000Z",
    },
  ]);
  now = new Date("2026-08-25T00:00:00Z");
  assert.equal(budget.snapshots(["you"])[0]?.used, 0);
});

void test("DailySearchBudget rejects invalid limits", () => {
  assert.throws(() => new DailySearchBudget({ you: -1 }), { code: "INVALID_INPUT" });
  assert.throws(() => new DailySearchBudget({ you: 0.5 }), { code: "INVALID_INPUT" });
});

void test("MinuteRateLimiter enforces sliding window per-minute cap", () => {
  let time = 1000000;
  const limiter = new MinuteRateLimiter({ jina: 3 }, () => time);
  assert.equal(limiter.remaining("jina"), 3);
  assert.equal(limiter.tryConsume("jina"), true);
  assert.equal(limiter.tryConsume("jina"), true);
  assert.equal(limiter.tryConsume("jina"), true);
  assert.equal(limiter.tryConsume("jina"), false);
  assert.equal(limiter.remaining("jina"), 0);
  time += 61_000;
  assert.equal(limiter.remaining("jina"), 3);
  assert.equal(limiter.tryConsume("jina"), true);
});

void test("MinuteRateLimiter sliding window prunes old entries", () => {
  let time = 0;
  const limiter = new MinuteRateLimiter({ x: 2 }, () => time);
  limiter.tryConsume("x");
  time += 30_000;
  limiter.tryConsume("x");
  assert.equal(limiter.remaining("x"), 0);
  time += 31_000;
  assert.equal(limiter.remaining("x"), 1);
  assert.equal(limiter.tryConsume("x"), true);
  assert.equal(limiter.tryConsume("x"), false);
});

void test("MinuteRateLimiter leaves unconfigured providers unlimited", () => {
  const limiter = new MinuteRateLimiter({ jina: 1 });
  assert.equal(limiter.tryConsume("browserless"), true);
  assert.equal(limiter.remaining("browserless"), undefined);
});

void test("MinuteRateLimiter rejects invalid limits", () => {
  assert.throws(() => new MinuteRateLimiter({ jina: 0 }), { code: "INVALID_INPUT" });
  assert.throws(() => new MinuteRateLimiter({ jina: -1 }), { code: "INVALID_INPUT" });
});

void test("CompositeSearchBudget returns the tightest remaining across windows", () => {
  const monthly = new MonthlySearchBudget({ tavily: 100 });
  const daily = new DailySearchBudget({ tavily: 5 });
  const composite = new CompositeSearchBudget([monthly, daily]);
  assert.equal(composite.remaining("tavily"), 5);
  assert.equal(composite.remaining("exa"), undefined);
});

void test("CompositeSearchBudget blocks when any window is exhausted", () => {
  const monthly = new MonthlySearchBudget({ you: 1000 });
  let now = new Date("2026-08-24T12:00:00Z");
  const daily = new DailySearchBudget({ you: 2 }, () => now);
  const composite = new CompositeSearchBudget([monthly, daily]);
  assert.equal(composite.tryConsume("you"), true);
  assert.equal(composite.tryConsume("you"), true);
  assert.equal(composite.tryConsume("you"), false);
  assert.equal(monthly.remaining("you"), 998);
  assert.equal(daily.remaining("you"), 0);
  now = new Date("2026-08-25T00:00:00Z");
  assert.equal(composite.tryConsume("you"), true);
});

void test("CompositeSearchBudget exposes each configured window snapshot", () => {
  const monthly = new MonthlySearchBudget({ you: 3 }, () => new Date("2026-08-24T12:00:00Z"));
  const daily = new DailySearchBudget({ you: 2 }, () => new Date("2026-08-24T12:00:00Z"));
  const composite = new CompositeSearchBudget([monthly, daily]);
  assert.equal(composite.tryConsume("you"), true);
  assert.deepEqual(
    composite.snapshots(["you"]).map((snapshot) => ({
      period: snapshot.period,
      provider: snapshot.provider,
      limit: snapshot.limit,
      used: snapshot.used,
      remaining: snapshot.remaining,
    })),
    [
      { period: "monthly", provider: "you", limit: 3, used: 1, remaining: 2 },
      { period: "daily", provider: "you", limit: 2, used: 1, remaining: 1 },
    ],
  );
});

void test("CompositeSearchBudget consumes from all trackers on success", () => {
  const monthly = new MonthlySearchBudget({ a: 10 });
  const daily = new DailySearchBudget({ a: 5 });
  const composite = new CompositeSearchBudget([monthly, daily]);
  composite.tryConsume("a");
  assert.equal(monthly.remaining("a"), 9);
  assert.equal(daily.remaining("a"), 4);
});

void test("CompositeSearchBudget does not consume when pre-check fails", () => {
  const monthly = new MonthlySearchBudget({ a: 0 });
  const daily = new DailySearchBudget({ a: 5 });
  const composite = new CompositeSearchBudget([monthly, daily]);
  assert.equal(composite.tryConsume("a"), false);
  assert.equal(daily.remaining("a"), 5);
});

void test("consumeProviderAttemptBudget reserves before provider dispatch", () => {
  const budget = new MonthlySearchBudget({ you: 1 });
  assert.equal(consumeProviderAttemptBudget(budget, "you", "provider-budget", false), undefined);
  assert.equal(
    consumeProviderAttemptBudget(budget, "you", "provider-budget", false),
    "you budget exhausted",
  );
  assert.throws(
    () => consumeProviderAttemptBudget(budget, "you", "provider-budget", true),
    { code: "PROVIDER_UNAVAILABLE", stage: "provider-budget" },
  );
});
