import assert from "node:assert/strict";
import test from "node:test";

import { MonthlySearchBudget } from "../../src/core/search-budget.js";

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
