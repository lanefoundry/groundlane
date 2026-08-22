import assert from "node:assert/strict";
import test from "node:test";

import type { SearchResult } from "../../src/core/contracts.js";
import { canonicalSearchResultUrl, fuseSearchResults } from "../../src/core/search-fusion.js";

function result(
  provider: string,
  items: Array<{ title: string; url: string; score?: number }>,
): SearchResult {
  return {
    query: "groundlane",
    provider,
    results: items.map((item) => ({
      ...item,
      snippet: `${provider} snippet`,
      provider,
    })),
    durationMs: 1,
    warnings: [],
  };
}

void test("canonicalSearchResultUrl removes fragments and conservative tracking parameters", () => {
  assert.equal(
    canonicalSearchResultUrl(
      "HTTPS://Example.COM:443/docs?utm_source=test&id=2&gclid=x#section",
    ),
    "https://example.com/docs?id=2",
  );
  assert.equal(
    canonicalSearchResultUrl("https://example.com/docs?id=2&version=3"),
    "https://example.com/docs?id=2&version=3",
  );
  assert.equal(canonicalSearchResultUrl("javascript:alert(1)"), undefined);
});

void test("RRF merges canonical duplicates without adding raw provider scores", () => {
  const fused = fuseSearchResults(
    [
      result("tavily", [
        { title: "Shared from Tavily", url: "https://example.com/a?utm_source=t", score: 0.9 },
        { title: "Tavily only", url: "https://tavily.example/b", score: 0.8 },
      ]),
      result("exa", [
        { title: "Shared from Exa", url: "https://example.com/a#top", score: 7 },
        { title: "Exa only", url: "https://exa.example/c", score: 6 },
      ]),
    ],
    5,
  );

  assert.equal(fused[0]?.url, "https://example.com/a");
  assert.equal(fused[0]?.title, "Shared from Tavily");
  assert.equal(fused[0]?.score, 0.9);
  assert.equal(fused[0]?.fusionScore, 2 / 61);
  assert.deepEqual(fused[0]?.sources, [
    { provider: "tavily", rank: 1, rawScore: 0.9 },
    { provider: "exa", rank: 1, rawScore: 7 },
  ]);
  assert.equal(fused.length, 3);
});

void test("RRF ordering is stable and caps repeated hostnames", () => {
  const fused = fuseSearchResults(
    [
      result("tavily", [
        { title: "A", url: "https://same.example/a" },
        { title: "B", url: "https://same.example/b" },
        { title: "C", url: "https://same.example/c" },
      ]),
      result("exa", [{ title: "D", url: "https://other.example/d" }]),
    ],
    4,
  );

  assert.deepEqual(
    fused.map((item) => item.url),
    ["https://same.example/a", "https://other.example/d", "https://same.example/b"],
  );
});
