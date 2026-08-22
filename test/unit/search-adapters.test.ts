import assert from "node:assert/strict";
import test from "node:test";
import { BraveSearchProvider } from "../../src/adapters/search/brave.js";
import { BrowserbaseSearchProvider } from "../../src/adapters/search/browserbase.js";
import { ExaSearchProvider } from "../../src/adapters/search/exa.js";
import { FirecrawlSearchProvider } from "../../src/adapters/search/firecrawl.js";
import { LinkupSearchProvider } from "../../src/adapters/search/linkup.js";
import { ParallelSearchProvider } from "../../src/adapters/search/parallel.js";
import { SerperSearchProvider } from "../../src/adapters/search/serper.js";
import { SerpApiSearchProvider } from "../../src/adapters/search/serpapi.js";
import { TavilySearchProvider } from "../../src/adapters/search/tavily.js";
import { YouSearchProvider } from "../../src/adapters/search/you.js";
import { validateItems } from "../../src/adapters/search/common.js";

void test("search adapter capability declarations are truthful", () => {
  const fetcher = () => Promise.resolve(Response.json({ results: [] }));
  const validateUrl = () => Promise.resolve();
  assert.equal(new TavilySearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports(), true);
  assert.equal(new ExaSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports({ query: "q", maxResults: 1, excludeDomains: ["x.com"] }), false);
  assert.equal(new BraveSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports({ query: "q", maxResults: 1, domains: ["x.com"] }), false);
  assert.equal(new BrowserbaseSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports({ query: "q", maxResults: 5, timeRange: "day" }), false);
  assert.equal(new ParallelSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports({ query: "q", maxResults: 5, timeRange: "day" }), false);
  assert.equal(new FirecrawlSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports({ query: "q", maxResults: 1, domains: ["x.com"], excludeDomains: ["y.com"] }), false);
  assert.equal(new LinkupSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports(), true);
  assert.equal(new SerperSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports({ query: "q", maxResults: 1, timeRange: "day" }), false);
  assert.equal(new YouSearchProvider({ apiKey: "k", fetch: fetcher, validateUrl }).supports({ query: "q", maxResults: 1, domains: ["x.com"], excludeDomains: ["y.com"] }), false);
});

void test("provider URL validation has a fixed candidate bound", async () => {
  let validations = 0;
  const items = Array.from({ length: 101 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.com/${index}`,
    snippet: "bounded",
    provider: "test",
  }));

  const result = await validateItems(items, () => {
    validations += 1;
    return Promise.resolve();
  });

  assert.equal(validations, 100);
  assert.equal(result.length, 100);
});

void test("Linkup maps current v1 search contract and filters", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const provider = new LinkupSearchProvider({
    apiKey: "linkup-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        Response.json({
          results: [
            {
              name: "Linkup result",
              url: "https://example.com/linkup",
              content: "Evidence from Linkup",
            },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
    now: () => new Date("2026-08-22T12:00:00Z"),
  });

  const result = await provider.search(
    {
      query: "groundlane",
      maxResults: 4,
      domains: ["example.com"],
      excludeDomains: ["ads.example.com"],
      timeRange: "week",
    },
    new AbortController().signal,
  );

  assert.equal(requestedUrl, "https://api.linkup.so/v1/search");
  assert.equal(authorization, "Bearer linkup-secret");
  assert.deepEqual(body, {
    q: "groundlane",
    depth: "standard",
    outputType: "searchResults",
    maxResults: 4,
    includeDomains: ["example.com"],
    excludeDomains: ["ads.example.com"],
    fromDate: "2026-08-15",
    toDate: "2026-08-22",
  });
  assert.equal(result.results[0]?.title, "Linkup result");
  assert.equal(result.results[0]?.snippet, "Evidence from Linkup");
  assert.equal(result.results[0]?.provider, "linkup");
  assert.doesNotMatch(JSON.stringify(result), /linkup-secret/u);
});

void test("Serper authenticates and normalizes organic results", async () => {
  let apiKey = "";
  let body: unknown;
  const provider = new SerperSearchProvider({
    apiKey: "serper-secret",
    fetch: (_url, init) => {
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        Response.json({
          organic: [
            {
              title: "Serper result",
              link: "https://example.com/serper",
              snippet: "Google result snippet",
              position: 2,
              date: "Aug 22, 2026",
            },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.search(
    { query: "groundlane", maxResults: 3 },
    new AbortController().signal,
  );

  assert.equal(apiKey, "serper-secret");
  assert.deepEqual(body, { q: "groundlane", num: 3 });
  assert.equal(result.results[0]?.provider, "serper");
  assert.equal(result.results[0]?.publishedAt, "Aug 22, 2026");
  assert.equal(result.results[0]?.score, undefined);
  assert.doesNotMatch(JSON.stringify(result), /serper-secret/u);
});

void test("You.com maps domain/freshness filters and web/news results", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let body: unknown;
  const provider = new YouSearchProvider({
    apiKey: "you-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        Response.json({
          results: {
            web: [
              {
                title: "You web result",
                url: "https://example.com/you",
                description: "Fallback description",
                snippets: ["First highlight", "Second highlight"],
              },
            ],
            news: [
              {
                title: "You news result",
                url: "https://example.com/you-news",
                description: "News description",
                page_age: "2026-08-22",
              },
            ],
          },
          metadata: { search_uuid: "request-id", query: "groundlane", latency: 12 },
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.search(
    {
      query: "groundlane",
      maxResults: 4,
      domains: ["example.com"],
      timeRange: "month",
    },
    new AbortController().signal,
  );

  assert.equal(requestedUrl, "https://ydc-index.io/v1/search");
  assert.equal(apiKey, "you-secret");
  assert.deepEqual(body, {
    query: "groundlane",
    count: 4,
    freshness: "month",
    include_domains: ["example.com"],
  });
  assert.equal(result.results[0]?.snippet, "First highlight\nSecond highlight");
  assert.equal(result.results[0]?.provider, "you");
  assert.equal(result.results[1]?.publishedAt, "2026-08-22");
  assert.doesNotMatch(JSON.stringify(result), /you-secret|request-id/u);
});

void test("You.com validates all candidates before router-level truncation", async () => {
  const provider = new YouSearchProvider({
    apiKey: "you-secret",
    fetch: () =>
      Promise.resolve(
        Response.json({
          results: {
            web: [
              { title: "Unsafe", url: "http://127.0.0.1", description: "private" },
              { title: "Safe", url: "https://example.com/safe", description: "public" },
            ],
          },
        }),
      ),
    validateUrl: (url) =>
      url.includes("127.0.0.1")
        ? Promise.reject(new Error("blocked"))
        : Promise.resolve(),
  });

  const result = await provider.search(
    { query: "groundlane", maxResults: 1 },
    new AbortController().signal,
  );

  assert.deepEqual(result.results.map((item) => item.url), ["https://example.com/safe"]);
});

void test("Browserbase authenticates and normalizes Search API results", async () => {
  let apiKey = "";
  let body: unknown;
  const provider = new BrowserbaseSearchProvider({
    apiKey: "browserbase-secret",
    fetch: (_url, init) => {
      apiKey = new Headers(init.headers).get("x-bb-api-key") ?? "";
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(Response.json({
        results: [{ title: "Browserbase result", url: "https://example.com/browserbase", publishedDate: "2026-08-21" }],
      }));
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.search(
    { query: "groundlane provider", maxResults: 5 },
    new AbortController().signal,
  );

  assert.equal(apiKey, "browserbase-secret");
  assert.deepEqual(body, { query: "groundlane provider", numResults: 5 });
  assert.equal(result.results[0]?.provider, "browserbase");
  assert.equal(result.results[0]?.publishedAt, "2026-08-21");
  assert.doesNotMatch(JSON.stringify(result), /browserbase-secret/u);
});

void test("Parallel maps domain policy and LLM-optimized excerpts", async () => {
  let body: unknown;
  const provider = new ParallelSearchProvider({
    apiKey: "parallel-secret",
    fetch: (_url, init) => {
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(Response.json({
        results: [{
          title: "Parallel result",
          url: "https://example.com/parallel",
          publish_date: "2026-08-21",
          excerpts: ["First excerpt", "Second excerpt"],
        }],
        warnings: ["normalized input"],
      }));
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.search(
    { query: "groundlane", maxResults: 4, domains: ["example.com"], excludeDomains: ["ads.example.com"] },
    new AbortController().signal,
  );

  assert.deepEqual(body, {
    objective: "groundlane",
    search_queries: ["groundlane"],
    mode: "turbo",
    advanced_settings: {
      max_results: 4,
      source_policy: {
        include_domains: ["example.com"],
        exclude_domains: ["ads.example.com"],
      },
    },
  });
  assert.equal(result.results[0]?.snippet, "First excerpt\n\nSecond excerpt");
  assert.equal(result.results[0]?.provider, "parallel");
  assert.deepEqual(result.warnings, ["normalized input"]);
});

void test("Firecrawl maps filters and normalizes v2 web results", async () => {
  let body: unknown;
  const provider = new FirecrawlSearchProvider({
    apiKey: "firecrawl-secret",
    fetch: (_url, init) => {
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(Response.json({
        success: true,
        data: {
          web: [{ title: "Firecrawl result", url: "https://example.com/firecrawl", description: "Snippet" }],
        },
        warning: "partial index",
      }));
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.search(
    { query: "groundlane", maxResults: 3, domains: ["example.com"], timeRange: "week" },
    new AbortController().signal,
  );

  assert.deepEqual(body, {
    query: "groundlane",
    limit: 3,
    sources: ["web"],
    includeDomains: ["example.com"],
    highlights: false,
    tbs: "qdr:w",
  });
  assert.equal(result.results[0]?.provider, "firecrawl");
  assert.deepEqual(result.warnings, ["partial index"]);
});

void test("SerpApi maps Google organic results and domain/time filters", async () => {
  let requestedUrl = "";
  const provider = new SerpApiSearchProvider({
    apiKey: "serp-secret",
    fetch: (url) => {
      requestedUrl = url;
      return Promise.resolve(Response.json({
        organic_results: [
          { title: "Organic result", link: "https://example.com/serp", snippet: "Snippet", date: "Aug 21, 2026" },
        ],
      }));
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.search(
    {
      query: "groundlane",
      maxResults: 3,
      domains: ["example.com", "example.org"],
      excludeDomains: ["ads.example.net"],
      timeRange: "month",
    },
    new AbortController().signal,
  );

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://serpapi.com/search.json");
  assert.equal(url.searchParams.get("engine"), "google");
  assert.equal(url.searchParams.get("num"), "3");
  assert.equal(url.searchParams.get("tbs"), "qdr:m");
  assert.equal(
    url.searchParams.get("q"),
    "groundlane (site:example.com OR site:example.org) -site:ads.example.net",
  );
  assert.equal(url.searchParams.get("api_key"), "serp-secret");
  assert.equal(result.results[0]?.provider, "serpapi");
  assert.equal(result.results[0]?.publishedAt, "Aug 21, 2026");
  assert.doesNotMatch(JSON.stringify(result), /serp-secret/u);
});

void test("SerpApi maps quota errors without exposing the provider message", async () => {
  const provider = new SerpApiSearchProvider({
    apiKey: "serp-secret",
    fetch: () => Promise.resolve(Response.json({ error: "Your account has run out of searches." })),
    validateUrl: () => Promise.resolve(),
  });

  await assert.rejects(
    provider.search({ query: "q", maxResults: 1 }, new AbortController().signal),
    { code: "RATE_LIMITED", message: "SerpApi quota or rate limit reached" },
  );
});

void test("Tavily normalizes results, drops unsafe URLs and never exposes its key", async () => {
  let authorization = "";
  const provider = new TavilySearchProvider({
    apiKey: "secret",
    fetch: (_url, init) => { authorization = new Headers(init.headers).get("authorization") ?? ""; return Promise.resolve(Response.json({ results: [{ title: "Good", url: "https://example.com", content: "Snippet", score: 0.8 }, { title: "Bad", url: "http://127.0.0.1", content: "private" }] })); },
    validateUrl: (url) => url.includes("127.0.0.1") ? Promise.reject(new Error("blocked")) : Promise.resolve(),
  });
  const result = await provider.search({ query: "q", maxResults: 5 }, new AbortController().signal);
  assert.equal(authorization, "Bearer secret"); assert.equal(result.results.length, 1); assert.equal(result.results[0]?.provider, "tavily"); assert.doesNotMatch(JSON.stringify(result), /secret/);
});

void test("provider status and malformed JSON map to stable retryable errors", async () => {
  const rateLimited = new BraveSearchProvider({ apiKey: "k", fetch: () => Promise.resolve(new Response("", { status: 429 })), validateUrl: () => Promise.resolve() });
  await assert.rejects(rateLimited.search({ query: "q", maxResults: 1 }, new AbortController().signal), { code: "RATE_LIMITED", retryable: true });
  const malformed = new ExaSearchProvider({ apiKey: "k", fetch: () => Promise.resolve(new Response("bad", { status: 200 })), validateUrl: () => Promise.resolve() });
  await assert.rejects(malformed.search({ query: "q", maxResults: 1 }, new AbortController().signal), { code: "UPSTREAM_ERROR", retryable: true });
  const oversized = new BraveSearchProvider({
    apiKey: "k",
    fetch: () => Promise.resolve(new Response("{}", { headers: { "content-length": "2000001" } })),
    validateUrl: () => Promise.resolve(),
  });
  await assert.rejects(
    oversized.search({ query: "q", maxResults: 1 }, new AbortController().signal),
    { code: "OUTPUT_LIMIT", retryable: true },
  );
});
