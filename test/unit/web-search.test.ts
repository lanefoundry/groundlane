import assert from "node:assert/strict";
import test from "node:test";

import { assertSearchOutputWithinLimit } from "../../src/tools/web-search.js";

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
