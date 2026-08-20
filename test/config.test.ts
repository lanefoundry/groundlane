import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, parseSearchMonthlyRequestBudgets } from "../src/config.js";

const token = "x".repeat(32);

void test("parseConfig applies bounded defaults and deduplicates provider order", () => {
  const config = parseConfig({
    GROUNDLANE_AUTH_TOKEN: token,
    SEARCH_PROVIDER_ORDER: "exa,tavily,exa,unknown",
    EXA_API_KEY: "exa-key",
  });

  assert.equal(config.port, 8080);
  assert.deepEqual(config.searchProviderOrder, ["exa", "tavily"]);
  assert.deepEqual(config.providerKeys, { exa: "exa-key" });
  assert.equal(config.searchMonthlyRequestBudgets.serpapi, 250);
  assert.equal(config.readerBackend, "disabled");
  assert.equal(config.browserBackend, "disabled");
  assert.equal(config.browserlessRegion, "sfo");
});

void test("parseSearchMonthlyRequestBudgets validates provider names and duplicates", () => {
  assert.deepEqual(parseSearchMonthlyRequestBudgets("tavily:10,serpapi:0"), {
    tavily: 10,
    serpapi: 0,
  });
  assert.throws(
    () => parseSearchMonthlyRequestBudgets("unknown:10"),
    /Invalid SEARCH_MONTHLY_REQUEST_BUDGETS/u,
  );
  assert.throws(
    () => parseSearchMonthlyRequestBudgets("tavily:10,tavily:20"),
    /Duplicate SEARCH_MONTHLY_REQUEST_BUDGETS/u,
  );
});

void test("parseConfig rejects short authentication tokens", () => {
  assert.throws(
    () => parseConfig({ GROUNDLANE_AUTH_TOKEN: "short" }),
    /Too small|greater than or equal to 32/u,
  );
});

void test("parseConfig rejects an empty provider order", () => {
  assert.throws(
    () =>
      parseConfig({
        GROUNDLANE_AUTH_TOKEN: token,
        SEARCH_PROVIDER_ORDER: "unknown",
      }),
    /SEARCH_PROVIDER_ORDER/u,
  );
});

void test("parseConfig treats blank optional provider keys as unset", () => {
  const config = parseConfig({
    GROUNDLANE_AUTH_TOKEN: token,
    TAVILY_API_KEY: "",
    EXA_API_KEY: "   ",
    BRAVE_API_KEY: "",
    FIRECRAWL_API_KEY: "",
    SERPAPI_API_KEY: "",
    BROWSERBASE_API_KEY: "",
    PARALLEL_API_KEY: "",
    BROWSERLESS_TOKEN: "",
  });

  assert.deepEqual(config.providerKeys, {});
});

void test("parseConfig requires a Browserless token for the remote browser backend", () => {
  assert.throws(
    () =>
      parseConfig({
        GROUNDLANE_AUTH_TOKEN: token,
        BROWSER_BACKEND: "browserless",
      }),
    /BROWSERLESS_TOKEN/u,
  );
  const config = parseConfig({
    GROUNDLANE_AUTH_TOKEN: token,
    READER_BACKEND: "jina",
    BROWSER_BACKEND: "browserless",
    BROWSERLESS_TOKEN: "browserless-token",
    BROWSERLESS_REGION: "lon",
  });
  assert.equal(config.readerBackend, "jina");
  assert.equal(config.browserBackend, "browserless");
  assert.equal(config.browserlessToken, "browserless-token");
  assert.equal(config.browserlessRegion, "lon");
});
