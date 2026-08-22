import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSearchOutputWithinLimit,
  webSearchInputSchema,
} from "../../src/tools/web-search.js";

const result = {
  query: "groundlane",
  provider: "test",
  results: [
    {
      title: "A",
      url: "https://example.com",
      snippet: "result",
      provider: "test",
    },
  ],
  durationMs: 1,
  warnings: [],
};

void test("search output is rejected before exceeding the configured character limit", () => {
  assert.doesNotThrow(() => assertSearchOutputWithinLimit(result, 1_000));
  assert.throws(() => assertSearchOutputWithinLimit(result, 10), {
    code: "OUTPUT_LIMIT",
  });
});

void test("web_search defaults auto requests to balanced strategy", () => {
  assert.deepEqual(webSearchInputSchema.parse({ query: "groundlane" }), {
    query: "groundlane",
    maxResults: 5,
    provider: "auto",
    strategy: "balanced",
  });
});

void test("web_search rejects conflicting single and candidate provider selectors", () => {
  assert.throws(() =>
    webSearchInputSchema.parse({
      query: "groundlane",
      provider: "tavily",
      providers: ["tavily", "exa"],
    }),
  );
});
