import assert from "node:assert/strict";
import test from "node:test";

import { BraveNewsProvider } from "../../src/adapters/news/brave.js";
import { SerperNewsProvider } from "../../src/adapters/news/serper.js";
import { SerpApiNewsProvider } from "../../src/adapters/news/serpapi.js";

const signal = new AbortController().signal;

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error("expected string body");
  return JSON.parse(body) as unknown;
}

void test("Brave news maps the News Search endpoint", async () => {
  let requestedUrl = "";
  let token = "";
  const provider = new BraveNewsProvider({
    apiKey: "brave-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      token = new Headers(init.headers).get("x-subscription-token") ?? "";
      return Promise.resolve(
        Response.json({
          results: [
            { title: "Brave news", url: "https://example.com/a", description: "Alpha", age: "2 hours ago" },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.news(
    { query: "ai", maxResults: 3, timeRange: "day", country: "tw", language: "en" },
    signal,
  );

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/news/search");
  assert.equal(url.searchParams.get("q"), "ai");
  assert.equal(url.searchParams.get("count"), "3");
  assert.equal(url.searchParams.get("freshness"), "pd");
  assert.equal(url.searchParams.get("country"), "TW");
  assert.equal(token, "brave-secret");
  assert.equal(result.results[0]?.title, "Brave news");
  assert.equal(result.results[0]?.publishedAt, "2 hours ago");
  assert.doesNotMatch(JSON.stringify(result), /brave-secret/u);
});

void test("Serper news maps google.serper.dev/news", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let body: unknown;
  const provider = new SerperNewsProvider({
    apiKey: "serper-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({
          news: [
            {
              title: "Serper news",
              link: "https://example.com/b",
              snippet: "Beta",
              source: "Example",
              date: "1 day ago",
              imageUrl: "https://example.com/image.jpg",
            },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.news(
    { query: "ai", maxResults: 5, country: "us", language: "en" },
    signal,
  );

  assert.equal(requestedUrl, "https://google.serper.dev/news");
  assert.equal(apiKey, "serper-secret");
  assert.deepEqual(body, { q: "ai", num: 5, gl: "us", hl: "en" });
  assert.equal(result.results[0]?.source, "Example");
  assert.equal(result.results[0]?.thumbnailUrl, "https://example.com/image.jpg");
  assert.doesNotMatch(JSON.stringify(result), /serper-secret/u);
});

void test("SerpApi news maps google_news and flattens stories", async () => {
  let requestedUrl = "";
  const provider = new SerpApiNewsProvider({
    apiKey: "serpapi-secret",
    fetch: (url) => {
      requestedUrl = url;
      return Promise.resolve(
        Response.json({
          news_results: [
            {
              title: "Top news",
              stories: [
                {
                  title: "SerpApi nested",
                  link: "https://example.com/c",
                  snippet: "Gamma",
                  source: { name: "Nested Source" },
                  iso_date: "2026-08-29T00:00:00Z",
                },
              ],
            },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.news(
    { query: "ai", maxResults: 5, timeRange: "week", country: "us", language: "en" },
    signal,
  );

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://serpapi.com/search.json");
  assert.equal(url.searchParams.get("engine"), "google_news");
  assert.equal(url.searchParams.get("q"), "ai");
  assert.equal(url.searchParams.get("api_key"), "serpapi-secret");
  assert.equal(url.searchParams.get("when"), "7d");
  assert.equal(result.results[0]?.title, "SerpApi nested");
  assert.equal(result.results[0]?.source, "Nested Source");
  assert.doesNotMatch(JSON.stringify(result), /serpapi-secret/u);
});
