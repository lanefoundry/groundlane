import assert from "node:assert/strict";
import test from "node:test";

import type {
  NewsProvider,
  NewsProviderId,
  NewsProviderResult,
  NewsRequest,
} from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { NewsRouter } from "../../src/core/news-router.js";

function newsResult(id: NewsProviderId): NewsProviderResult {
  return {
    provider: id,
    query: "groundlane",
    results: [
      { title: `${id} news`, url: `https://example.com/${id}`, snippet: "news", provider: id },
      { title: "shared", url: "https://example.com/shared", snippet: "shared", provider: id },
    ],
    durationMs: 1,
    warnings: [],
  };
}

function provider(id: NewsProviderId, behavior: "ok" | "retry" | "fatal", supports = true): NewsProvider {
  return {
    id,
    supports: () => supports,
    news(): Promise<NewsProviderResult> {
      if (behavior === "retry") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_news", "down", true));
      }
      if (behavior === "fatal") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_news", "bad request"));
      }
      return Promise.resolve(newsResult(id));
    },
  };
}

const request: NewsRequest = {
  query: "groundlane",
  maxResults: 10,
};

void test("NewsRouter fans out to multiple providers in parallel and dedupes results", async () => {
  const calls: NewsProviderId[] = [];
  const makeProvider = (id: NewsProviderId): NewsProvider => ({
    id,
    supports: () => true,
    news(): Promise<NewsProviderResult> {
      calls.push(id);
      return Promise.resolve(newsResult(id));
    },
  });

  const result = await new NewsRouter(
    [makeProvider("brave"), makeProvider("serper"), makeProvider("serpapi")],
    ["brave", "serper", "serpapi"],
  ).news(request, new AbortController().signal);

  assert.deepEqual(calls.sort(), ["brave", "serpapi", "serper"]);
  assert.equal(result.strategy, "parallel");
  assert.deepEqual(result.providersSelected, ["brave", "serper", "serpapi"]);
  assert.deepEqual(result.providersAttempted, ["brave", "serper", "serpapi"]);
  assert.deepEqual(result.providersSucceeded, ["brave", "serper", "serpapi"]);
  assert.equal(result.results.filter((item) => item.url === "https://example.com/shared").length, 1);
});

void test("NewsRouter returns partial success with sanitized warnings", async () => {
  const result = await new NewsRouter(
    [provider("brave", "ok"), provider("serper", "retry")],
    ["brave", "serper"],
  ).news(request, new AbortController().signal);

  assert.deepEqual(result.providersSucceeded, ["brave"]);
  assert.deepEqual(result.warnings, ["serper unavailable"]);
});

void test("NewsRouter fallback stops at first successful provider", async () => {
  const result = await new NewsRouter(
    [provider("brave", "retry"), provider("serpapi", "ok")],
    ["brave", "serpapi"],
  ).news({ ...request, strategy: "fallback" }, new AbortController().signal);

  assert.equal(result.strategy, "fallback");
  assert.deepEqual(result.providersAttempted, ["brave", "serpapi"]);
  assert.deepEqual(result.providersSucceeded, ["serpapi"]);
});

void test("NewsRouter rejects invalid input and conflicting provider selectors", async () => {
  await assert.rejects(
    new NewsRouter([provider("brave", "ok")], ["brave"]).news(
      { ...request, country: "usa" },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
  await assert.rejects(
    new NewsRouter([provider("brave", "ok")], ["brave"]).news(
      { ...request, provider: "brave", providers: ["brave"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("NewsRouter explicit provider propagates non-retryable errors", async () => {
  await assert.rejects(
    new NewsRouter([provider("brave", "fatal")], ["brave"]).news(
      { ...request, provider: "brave" },
      new AbortController().signal,
    ),
    /bad request/u,
  );
});
