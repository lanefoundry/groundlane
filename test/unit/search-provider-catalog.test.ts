import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../../src/config.js";
import { createSearchProviders } from "../../src/composition.js";
import {
  DEFAULT_SEARCH_PROVIDER_ORDER,
  SEARCH_PROVIDER_IDS,
} from "../../src/core/search-provider-catalog.js";
import { webSearchInputSchema } from "../../src/tools/web-search.js";

void test("catalog, public schema, config, and composition expose the same providers", () => {
  const token = "x".repeat(32);
  const config = parseConfig({
    GROUNDLANE_AUTH_TOKEN: token,
    SEARCH_PROVIDER_ORDER: SEARCH_PROVIDER_IDS.join(","),
    TAVILY_API_KEY: "tavily",
    EXA_API_KEY: "exa",
    PARALLEL_API_KEY: "parallel",
    BROWSERBASE_API_KEY: "browserbase",
    BRAVE_API_KEY: "brave",
    FIRECRAWL_API_KEY: "firecrawl",
    SERPAPI_API_KEY: "serpapi",
    LINKUP_API_KEY: "linkup",
    SERPER_API_KEY: "serper",
    YOU_API_KEY: "you",
  });

  assert.deepEqual(config.searchProviderOrder, SEARCH_PROVIDER_IDS);
  assert.deepEqual(
    createSearchProviders(config).map((provider) => provider.id).sort(),
    [...SEARCH_PROVIDER_IDS].sort(),
  );
  for (const provider of SEARCH_PROVIDER_IDS) {
    assert.equal(
      webSearchInputSchema.safeParse({ query: "q", provider }).success,
      true,
      `public schema rejected ${provider}`,
    );
  }
});

void test("only renewable search providers are routed automatically", () => {
  const automatic = new Set<string>(DEFAULT_SEARCH_PROVIDER_ORDER);
  assert.equal(automatic.has("linkup"), true);
  assert.equal(automatic.has("serper"), false);
  assert.equal(automatic.has("you"), false);
});
