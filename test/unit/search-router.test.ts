import assert from "node:assert/strict";
import test from "node:test";
import type { SearchProvider, SearchRequest, SearchResult } from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { SearchRouter } from "../../src/core/search-router.js";
import { MonthlySearchBudget } from "../../src/core/search-budget.js";

function provider(id: string, behavior: "ok" | "retry" | "fatal", supports = true): SearchProvider {
  return { id, supports: () => supports, search: (request): Promise<SearchResult> => {
    if (behavior === "retry") return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "search", "down", true));
    if (behavior === "fatal") return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "search", "bad request"));
    return Promise.resolve({ query: request.query, provider: id, results: [{ title: "A", url: "https://example.com", snippet: "S", provider: "wrong" }, { title: "B", url: "https://example.org", snippet: "S", provider: "wrong" }], durationMs: 1, warnings: [] });
  } };
}
const request: SearchRequest = { query: "test", maxResults: 1, provider: "auto" };

void test("SearchRouter uses configured order, fallback and attribution", async () => {
  const result = await new SearchRouter([provider("a", "retry"), provider("b", "ok")], ["a", "b"]).search(request, new AbortController().signal);
  assert.equal(result.provider, "b"); assert.equal(result.results.length, 1); assert.equal(result.results[0]?.provider, "b"); assert.deepEqual(result.warnings, ["a unavailable"]);
});

void test("SearchRouter does not fall back on non-retryable errors or explicit provider", async () => {
  await assert.rejects(new SearchRouter([provider("a", "fatal"), provider("b", "ok")], ["a", "b"]).search(request, new AbortController().signal), /bad request/);
  await assert.rejects(new SearchRouter([provider("a", "retry"), provider("b", "ok")], ["a", "b"]).search({ ...request, provider: "a" }, new AbortController().signal), /down/);
});

void test("SearchRouter rejects unsupported requests", async () => {
  await assert.rejects(new SearchRouter([provider("a", "ok", false)], ["a"]).search(request, new AbortController().signal), { code: "PROVIDER_UNAVAILABLE" });
});

void test("SearchRouter excludes unhealthy providers and validates its public bound", async () => {
  const result = await new SearchRouter([provider("a", "ok"), provider("b", "ok")], ["a", "b"], (id) => id !== "a").search(request, new AbortController().signal);
  assert.equal(result.provider, "b");
  await assert.rejects(new SearchRouter([provider("a", "ok")], ["a"]).search({ query: "q", maxResults: 51 }, new AbortController().signal), { code: "INVALID_INPUT" });
});

void test("SearchRouter skips exhausted monthly budgets and counts attempts", async () => {
  const budget = new MonthlySearchBudget({ a: 0, b: 1 });
  const router = new SearchRouter(
    [provider("a", "ok"), provider("b", "ok")],
    ["a", "b"],
    undefined,
    budget,
  );
  const result = await router.search(request, new AbortController().signal);
  assert.equal(result.provider, "b");
  assert.deepEqual(result.warnings, ["a monthly budget exhausted"]);
  assert.equal(budget.remaining("b"), 0);
  await assert.rejects(
    router.search({ ...request, provider: "b" }, new AbortController().signal),
    { code: "PROVIDER_UNAVAILABLE", stage: "search-budget" },
  );
});
