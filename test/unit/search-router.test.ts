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
const request: SearchRequest = {
  query: "test",
  maxResults: 1,
  provider: "auto",
  strategy: "fallback",
};

void test("SearchRouter uses configured order, fallback and attribution", async () => {
  const result = await new SearchRouter([provider("a", "retry"), provider("b", "ok")], ["a", "b"]).search(request, new AbortController().signal);
  assert.equal(result.provider, "b"); assert.equal(result.results.length, 1); assert.equal(result.results[0]?.provider, "b"); assert.deepEqual(result.warnings, ["a unavailable"]);
});

void test("SearchRouter defaults auto searches to balanced federation", async () => {
  const calls: string[] = [];
  const makeProvider = (id: string, url: string): SearchProvider => ({
    id,
    supports: () => true,
    search(searchRequest): Promise<SearchResult> {
      calls.push(id);
      return Promise.resolve({
        query: searchRequest.query,
        provider: id,
        results: [{ title: id, url, snippet: id, provider: id }],
        durationMs: 1,
        warnings: [],
      });
    },
  });
  const router = new SearchRouter(
    [
      makeProvider("tavily", "https://example.com/a"),
      makeProvider("linkup", "https://example.com/b"),
      makeProvider("exa", "https://example.com/a?utm_source=exa"),
    ],
    ["tavily", "linkup", "exa"],
  );

  const result = await router.search(
    { query: "test", maxResults: 5, provider: "auto" },
    new AbortController().signal,
  );

  assert.deepEqual(calls.sort(), ["exa", "tavily"]);
  assert.equal(result.strategy, "balanced");
  assert.equal(result.provider, "federated");
  assert.deepEqual(result.providersSelected, ["tavily", "exa"]);
  assert.deepEqual(result.providersSucceeded, ["tavily", "exa"]);
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0]?.sources?.map((source) => source.provider), [
    "tavily",
    "exa",
  ]);
});

void test("balanced search returns partial success with sanitized provider warnings", async () => {
  const router = new SearchRouter(
    [provider("tavily", "ok"), provider("exa", "fatal")],
    ["tavily", "exa"],
  );
  const result = await router.search(
    { query: "test", maxResults: 2, strategy: "balanced" },
    new AbortController().signal,
  );

  assert.deepEqual(result.providersSucceeded, ["tavily"]);
  assert.deepEqual(result.warnings, ["exa unavailable"]);
});

void test("balanced search continues to the next eligible batch when the first batch fails", async () => {
  const router = new SearchRouter(
    [
      provider("tavily", "retry"),
      provider("exa", "retry"),
      provider("linkup", "ok"),
      provider("keenable", "ok"),
    ],
    ["tavily", "exa", "linkup", "keenable"],
  );

  const result = await router.search(
    { query: "test", maxResults: 2, strategy: "balanced" },
    new AbortController().signal,
  );

  assert.equal(result.provider, "federated");
  assert.deepEqual(result.providersSelected, ["tavily", "exa", "linkup", "keenable"]);
  assert.deepEqual(result.providersAttempted, ["tavily", "exa", "linkup", "keenable"]);
  assert.deepEqual(result.providersSucceeded, ["linkup", "keenable"]);
  assert.deepEqual(result.warnings, ["tavily unavailable", "exa unavailable"]);
  assert.equal(result.results.length, 2);
});

void test("SearchRouter rejects conflicting provider selectors", async () => {
  await assert.rejects(
    new SearchRouter([provider("tavily", "ok")], ["tavily"]).search(
      {
        query: "test",
        maxResults: 1,
        provider: "tavily",
        providers: ["tavily"],
      },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("balanced search counts only selected attempts and skips exhausted providers", async () => {
  const budget = new MonthlySearchBudget({ tavily: 0, exa: 1, brave: 1, firecrawl: 1 });
  const router = new SearchRouter(
    [
      provider("tavily", "ok"),
      provider("exa", "ok"),
      provider("brave", "ok"),
      provider("firecrawl", "ok"),
    ],
    ["tavily", "exa", "brave", "firecrawl"],
    undefined,
    budget,
  );

  const result = await router.search(
    { query: "test", maxResults: 2, strategy: "balanced" },
    new AbortController().signal,
  );

  assert.deepEqual(result.providersSelected, ["exa", "brave"]);
  assert.deepEqual(result.providersAttempted, ["exa", "brave"]);
  assert.equal(budget.remaining("tavily"), 0);
  assert.equal(budget.remaining("exa"), 0);
  assert.equal(budget.remaining("brave"), 0);
  assert.equal(budget.remaining("firecrawl"), 1);
  assert.match(result.warnings.join(" "), /tavily budget exhausted/u);
});

void test("balanced search propagates cancellation across selected providers", async () => {
  const waitingProvider = (id: string): SearchProvider => ({
    id,
    supports: () => true,
    search(_searchRequest, signal): Promise<SearchResult> {
      return new Promise((_resolve, reject) => {
        const cancel = () => reject(
          new GroundlaneError("CANCELLED", "search", "The request was cancelled"),
        );
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = new SearchRouter(
    [waitingProvider("tavily"), waitingProvider("exa")],
    ["tavily", "exa"],
  ).search(
    { query: "test", maxResults: 2, strategy: "balanced" },
    controller.signal,
  );
  controller.abort();

  await assert.rejects(pending, { code: "CANCELLED" });
});

void test("deep search is bounded to three complementary providers", async () => {
  const router = new SearchRouter(
    [
      provider("tavily", "ok"),
      provider("linkup", "ok"),
      provider("exa", "ok"),
      provider("brave", "ok"),
      provider("firecrawl", "ok"),
    ],
    ["tavily", "linkup", "exa", "brave", "firecrawl"],
  );

  const result = await router.search(
    { query: "test", maxResults: 2, strategy: "deep" },
    new AbortController().signal,
  );

  assert.deepEqual(result.providersSelected, ["tavily", "exa", "brave"]);
  assert.deepEqual(result.providersAttempted, ["tavily", "exa", "brave"]);
  assert.deepEqual(result.providersSucceeded, ["tavily", "exa", "brave"]);
});

void test("SearchRouter does not fall back on non-retryable errors or explicit provider", async () => {
  await assert.rejects(new SearchRouter([provider("a", "fatal"), provider("b", "ok")], ["a", "b"]).search(request, new AbortController().signal), /bad request/);
  await assert.rejects(new SearchRouter([provider("a", "retry"), provider("b", "ok")], ["a", "b"]).search({ ...request, provider: "a" }, new AbortController().signal), /down/);
});

void test("SearchRouter rejects unsupported requests", async () => {
  await assert.rejects(new SearchRouter([provider("a", "ok", false)], ["a"]).search(request, new AbortController().signal), { code: "PROVIDER_UNAVAILABLE" });
});

void test("SearchRouter excludes unhealthy providers and validates its public bound", async () => {
  const health = {
    isHealthy: (id: string) => id !== "a",
    recordSuccess: () => {},
    recordFailure: () => {},
    penalty: () => 0,
  };
  const result = await new SearchRouter([provider("a", "ok"), provider("b", "ok")], ["a", "b"], health).search(request, new AbortController().signal);
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
  assert.deepEqual(result.warnings, ["a budget exhausted"]);
  assert.equal(budget.remaining("b"), 0);
  await assert.rejects(
    router.search({ ...request, provider: "b" }, new AbortController().signal),
    { code: "PROVIDER_UNAVAILABLE", stage: "search-budget" },
  );
});
