import assert from "node:assert/strict";
import test from "node:test";

import type {
  CrawlProvider,
  CrawlProviderId,
  CrawlProviderResult,
  CrawlRequest,
} from "../../src/core/contracts.js";
import { CrawlRouter } from "../../src/core/crawl-router.js";
import { GroundlaneError } from "../../src/core/errors.js";

function crawlResult(id: CrawlProviderId): CrawlProviderResult {
  return {
    provider: id,
    url: "https://example.com",
    status: "completed",
    pages: [
      {
        url: `https://example.com/${id}`,
        contentChars: 0,
        truncated: false,
        provider: id,
      },
      {
        url: "https://example.com/shared",
        contentChars: 0,
        truncated: false,
        provider: id,
      },
    ],
    durationMs: 1,
    warnings: [],
  };
}

function provider(
  id: CrawlProviderId,
  behavior: "ok" | "retry" | "fatal",
  supports = true,
): CrawlProvider {
  return {
    id,
    supports: () => supports,
    crawl(): Promise<CrawlProviderResult> {
      if (behavior === "retry") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "down", true));
      }
      if (behavior === "fatal") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "bad request"));
      }
      return Promise.resolve(crawlResult(id));
    },
  };
}

const request: CrawlRequest = {
  url: "https://example.com",
  maxPages: 10,
  maxContentChars: 1_000,
};

void test("CrawlRouter fans out to multiple providers in parallel and dedupes pages", async () => {
  const calls: CrawlProviderId[] = [];
  const makeProvider = (id: CrawlProviderId): CrawlProvider => ({
    id,
    supports: () => true,
    crawl(): Promise<CrawlProviderResult> {
      calls.push(id);
      return Promise.resolve(crawlResult(id));
    },
  });

  const result = await new CrawlRouter(
    [makeProvider("firecrawl"), makeProvider("tavily")],
    ["firecrawl", "tavily"],
  ).crawl(request, new AbortController().signal);

  assert.deepEqual(calls.sort(), ["firecrawl", "tavily"]);
  assert.equal(result.strategy, "parallel");
  assert.deepEqual(result.providersSelected, ["firecrawl", "tavily"]);
  assert.deepEqual(result.providersAttempted, ["firecrawl", "tavily"]);
  assert.deepEqual(result.providersSucceeded, ["firecrawl", "tavily"]);
  assert.equal(result.pages.filter((page) => page.url === "https://example.com/shared").length, 1);
});

void test("CrawlRouter returns partial success with sanitized warnings", async () => {
  const result = await new CrawlRouter(
    [provider("firecrawl", "ok"), provider("tavily", "retry")],
    ["firecrawl", "tavily"],
  ).crawl(request, new AbortController().signal);

  assert.deepEqual(result.providersSucceeded, ["firecrawl"]);
  assert.deepEqual(result.warnings, ["tavily unavailable"]);
});

void test("CrawlRouter fallback stops at first successful provider", async () => {
  const result = await new CrawlRouter(
    [provider("firecrawl", "retry"), provider("tavily", "ok")],
    ["firecrawl", "tavily"],
  ).crawl({ ...request, strategy: "fallback" }, new AbortController().signal);

  assert.equal(result.strategy, "fallback");
  assert.deepEqual(result.providersAttempted, ["firecrawl", "tavily"]);
  assert.deepEqual(result.providersSucceeded, ["tavily"]);
});

void test("CrawlRouter rejects unsafe URLs and conflicting selectors", async () => {
  await assert.rejects(
    new CrawlRouter([provider("firecrawl", "ok")], ["firecrawl"]).crawl(
      { ...request, url: "http://127.0.0.1/" },
      new AbortController().signal,
    ),
    { code: "URL_BLOCKED" },
  );
  await assert.rejects(
    new CrawlRouter([provider("firecrawl", "ok")], ["firecrawl"]).crawl(
      { ...request, provider: "firecrawl", providers: ["firecrawl"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("CrawlRouter explicit provider propagates non-retryable errors", async () => {
  await assert.rejects(
    new CrawlRouter([provider("firecrawl", "fatal")], ["firecrawl"]).crawl(
      { ...request, provider: "firecrawl" },
      new AbortController().signal,
    ),
    /bad request/u,
  );
});

