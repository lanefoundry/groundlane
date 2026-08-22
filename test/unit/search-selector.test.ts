import assert from "node:assert/strict";
import test from "node:test";

import { selectSearchProviders } from "../../src/core/search-selector.js";

void test("balanced selection prefers two complementary provider families", () => {
  assert.deepEqual(
    selectSearchProviders(["tavily", "linkup", "exa", "brave"], "balanced"),
    ["tavily", "exa"],
  );
});

void test("deep selection prefers three complementary families before filling by order", () => {
  assert.deepEqual(
    selectSearchProviders(
      ["tavily", "linkup", "exa", "parallel", "brave", "serpapi"],
      "deep",
    ),
    ["tavily", "exa", "brave"],
  );
});

void test("selection is bounded and deterministic when every provider has one family", () => {
  assert.deepEqual(
    selectSearchProviders(["serpapi", "serper", "browserbase"], "balanced"),
    ["serpapi", "serper"],
  );
  assert.deepEqual(
    selectSearchProviders(["serpapi", "serper", "browserbase"], "fallback"),
    ["serpapi", "serper", "browserbase"],
  );
});
