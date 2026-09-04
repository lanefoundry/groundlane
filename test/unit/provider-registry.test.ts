import assert from "node:assert/strict";
import test from "node:test";

import {
  createBuiltInRegistry,
  ProviderRegistry,
  type ProviderRegistration,
} from "../../src/core/provider-registry.js";
import {
  DEFAULT_SEARCH_PROVIDER_ORDER,
  SEARCH_PROVIDER_IDS,
} from "../../src/core/search-provider-catalog.js";
import {
  providerCapability,
} from "../../src/core/provider-capabilities.js";
import {
  searchProviderFamily,
  searchProviderWeight,
} from "../../src/core/search-provider-profile.js";
import { parseConfig } from "../../src/config.js";
import { createSearchProviders } from "../../src/composition.js";
import { ANSWER_PROVIDER_IDS } from "../../src/core/answer-router.js";
import { RESEARCH_PROVIDER_IDS } from "../../src/core/research-router.js";
import { CONTENT_PROVIDER_IDS } from "../../src/core/content-router.js";
import { MAP_PROVIDER_IDS } from "../../src/core/map-router.js";
import { CRAWL_PROVIDER_IDS } from "../../src/core/crawl-router.js";
import { NEWS_PROVIDER_IDS } from "../../src/core/news-router.js";
import { IMAGES_PROVIDER_IDS } from "../../src/core/images-router.js";

function makeCustomRegistration(
  id: string,
  overrides?: Partial<ProviderRegistration>,
): ProviderRegistration {
  return {
    id,
    protocol: "groundlane-provider-v1",
    enabled: false,
    backend: "http-compatible",
    ownership: "operator-hosted",
    capabilities: { search: true },
    family: "general-web",
    weight: 0.5,
    filterSpec: { mode: "none", timeRange: false },
    defaultMonthlyBudget: 0,
    vendorFeatures: [],
    groundlaneTools: ["web_search"],
    filterSupport: "none",
    balanceSupport: "not_implemented",
    notes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 614: Single source of truth
// ---------------------------------------------------------------------------

void test("PRD 614: adding a registration makes it visible to all registry queries", () => {
  const registry = createBuiltInRegistry();
  const initialCount = registry.ids().length;

  registry.register(makeCustomRegistration("custom.acme-search", {
    enabled: true,
    capabilities: { search: true },
    family: "custom-family",
    weight: 0.42,
    filterSpec: { mode: "include-only", timeRange: true },
    defaultMonthlyBudget: 50,
    vendorFeatures: ["Custom Search"],
    groundlaneTools: ["web_search"],
    filterSupport: "include only",
    balanceSupport: "dashboard",
    notes: ["Acme provider"],
  }));

  assert.equal(registry.ids().length, initialCount + 1);
  assert.ok(registry.ids().includes("custom.acme-search"));
  assert.ok(registry.has("custom.acme-search"));
  assert.ok(registry.enabledIds().includes("custom.acme-search"));

  assert.equal(registry.family("custom.acme-search"), "custom-family");
  assert.equal(registry.weight("custom.acme-search"), 0.42);
  assert.deepEqual(registry.filterSpec("custom.acme-search"), { mode: "include-only", timeRange: true });

  const caps = registry.providerCapabilities();
  assert.ok("custom.acme-search" in caps);
  assert.deepEqual(caps["custom.acme-search"]?.vendorFeatures, ["Custom Search"]);
  assert.equal(caps["custom.acme-search"]?.balanceSupport, "dashboard");
});

void test("PRD 614: disabled registration excluded from enabledIds but present in ids", () => {
  const registry = createBuiltInRegistry();
  registry.register(makeCustomRegistration("custom.disabled-one"));

  assert.ok(registry.ids().includes("custom.disabled-one"));
  assert.ok(!registry.enabledIds().includes("custom.disabled-one"));
});

// ---------------------------------------------------------------------------
// PRD 615: Backward compatibility — registry matches existing static maps
// ---------------------------------------------------------------------------

void test("PRD 615: built-in registry IDs match SEARCH_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  assert.deepEqual(
    [...registry.ids()].sort(),
    [...SEARCH_PROVIDER_IDS].sort(),
  );
});

void test("PRD 615: built-in default order providers are all registered", () => {
  const registry = createBuiltInRegistry();
  for (const id of DEFAULT_SEARCH_PROVIDER_ORDER) {
    assert.ok(registry.has(id), `DEFAULT_SEARCH_PROVIDER_ORDER entry "${id}" not in registry`);
  }
});

void test("PRD 615: registry capabilities match CAPABILITIES map for each provider", () => {
  const registry = createBuiltInRegistry();
  for (const id of SEARCH_PROVIDER_IDS) {
    const reg = registry.get(id);
    assert.ok(reg, `missing registration for ${id}`);

    const cap = providerCapability(id);
    assert.deepEqual([...reg.vendorFeatures], [...cap.vendorFeatures], `vendorFeatures mismatch for ${id}`);
    assert.deepEqual([...reg.groundlaneTools], [...cap.groundlaneTools], `groundlaneTools mismatch for ${id}`);
    assert.equal(reg.filterSupport, cap.filterSupport, `filterSupport mismatch for ${id}`);
    assert.equal(reg.balanceSupport, cap.balanceSupport, `balanceSupport mismatch for ${id}`);
    assert.deepEqual([...reg.notes], [...cap.notes], `notes mismatch for ${id}`);
  }
});

void test("PRD 615: registry families match PROVIDER_FAMILIES", () => {
  const registry = createBuiltInRegistry();
  for (const id of SEARCH_PROVIDER_IDS) {
    assert.equal(
      registry.family(id),
      searchProviderFamily(id),
      `family mismatch for ${id}`,
    );
  }
});

void test("PRD 615: registry weights match PROVIDER_WEIGHTS", () => {
  const registry = createBuiltInRegistry();
  for (const id of SEARCH_PROVIDER_IDS) {
    assert.equal(
      registry.weight(id),
      searchProviderWeight(id),
      `weight mismatch for ${id}`,
    );
  }
});

void test("PRD 615: registry filterSpecs contain expected values", () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.filterSpec("tavily").mode, "combined");
  assert.equal(registry.filterSpec("tavily").timeRange, true);
  assert.equal(registry.filterSpec("exa").mode, "include-only");
  assert.equal(registry.filterSpec("exa").timeRange, false);
  assert.equal(registry.filterSpec("browserbase").mode, "none");
  assert.equal(registry.filterSpec("serper").mode, "none");
  assert.equal(registry.filterSpec("you").mode, "include-or-exclude");
  assert.equal(registry.filterSpec("firecrawl").mode, "include-or-exclude");
  assert.equal(registry.filterSpec("keenable").mode, "include-only");
  assert.equal(registry.filterSpec("keenable").maxIncludeDomains, 1);
  assert.equal(registry.filterSpec("linkup").mode, "combined");
  assert.equal(registry.filterSpec("linkup").timeRange, true);
  for (const id of SEARCH_PROVIDER_IDS) {
    const spec = registry.filterSpec(id);
    assert.ok(spec, `filterSpec missing for ${id}`);
    assert.ok(["none", "include-only", "exclude-only", "include-or-exclude", "combined"].includes(spec.mode));
  }
});

void test("PRD 615: registry search capability matches SEARCH_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registrySearch = registry.ids().filter((id) => registry.get(id)?.capabilities.search);
  assert.deepEqual([...registrySearch].sort(), [...SEARCH_PROVIDER_IDS].sort());
});

void test("PRD 615: registry answer capability matches ANSWER_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registryAnswer = registry.ids().filter((id) => registry.get(id)?.capabilities.answer);
  assert.deepEqual(
    [...registryAnswer].sort(),
    [...ANSWER_PROVIDER_IDS].sort(),
    "answer capability mismatch",
  );
});

void test("PRD 615: registry research capability matches RESEARCH_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registryResearch = registry.ids().filter((id) => registry.get(id)?.capabilities.research);
  assert.deepEqual(
    [...registryResearch].sort(),
    [...RESEARCH_PROVIDER_IDS].sort(),
    "research capability mismatch",
  );
});

void test("PRD 615: registry content capability matches CONTENT_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registryContent = registry.ids().filter((id) => registry.get(id)?.capabilities.content);
  assert.deepEqual(
    [...registryContent].sort(),
    [...CONTENT_PROVIDER_IDS].sort(),
    "content capability mismatch",
  );
});

void test("PRD 615: registry map capability matches MAP_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registryMap = registry.ids().filter((id) => registry.get(id)?.capabilities.map);
  assert.deepEqual(
    [...registryMap].sort(),
    [...MAP_PROVIDER_IDS].sort(),
    "map capability mismatch",
  );
});

void test("PRD 615: registry crawl capability matches CRAWL_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registryCrawl = registry.ids().filter((id) => registry.get(id)?.capabilities.crawl);
  assert.deepEqual(
    [...registryCrawl].sort(),
    [...CRAWL_PROVIDER_IDS].sort(),
    "crawl capability mismatch",
  );
});

void test("PRD 615: registry news capability matches NEWS_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registryNews = registry.ids().filter((id) => registry.get(id)?.capabilities.news);
  assert.deepEqual(
    [...registryNews].sort(),
    [...NEWS_PROVIDER_IDS].sort(),
    "news capability mismatch",
  );
});

void test("PRD 615: registry images capability matches IMAGES_PROVIDER_IDS", () => {
  const registry = createBuiltInRegistry();
  const registryImages = registry.ids().filter((id) => registry.get(id)?.capabilities.images);
  assert.deepEqual(
    [...registryImages].sort(),
    [...IMAGES_PROVIDER_IDS].sort(),
    "images capability mismatch",
  );
});

void test("PRD 615: registry balance capability matches providers with provider_balance tool", () => {
  const registry = createBuiltInRegistry();
  const registryBalance = registry.ids().filter((id) => registry.get(id)?.capabilities.balance);
  const capsBalance = SEARCH_PROVIDER_IDS.filter((id) =>
    providerCapability(id).groundlaneTools.includes("provider_balance"),
  );
  assert.deepEqual(
    [...registryBalance].sort(),
    [...capsBalance].sort(),
    "balance capability mismatch",
  );
});

void test("PRD 615: registry monthly budgets match DEFAULT_SEARCH_PROVIDER_BUDGETS", () => {
  const registry = createBuiltInRegistry();
  const expected: Record<string, number> = {
    tavily: 800, exa: 1200, brave: 1000, you: 3000, tinyfish: 3000,
    keenable: 100, browserbase: 1000, firecrawl: 500, linkup: 100,
    parallel: 500, serpapi: 250, searchapi: 0, serper: 0,
  };
  for (const [id, budget] of Object.entries(expected)) {
    assert.equal(
      registry.get(id)?.defaultMonthlyBudget,
      budget,
      `monthly budget mismatch for ${id}`,
    );
  }
});

void test("PRD 615: registry daily budgets match DEFAULT_SEARCH_DAILY_BUDGETS", () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.get("you")?.defaultDailyBudget, 100);
  for (const id of SEARCH_PROVIDER_IDS) {
    if (id !== "you") {
      assert.equal(registry.get(id)?.defaultDailyBudget, undefined, `${id} should have no daily budget`);
    }
  }
});

void test("PRD 615: composition createSearchProviders still produces correct providers", () => {
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
    SEARCHAPI_API_KEY: "searchapi",
    LINKUP_API_KEY: "linkup",
    KEENABLE_API_KEY: "keenable",
    TINYFISH_API_KEY: "tinyfish",
    SERPER_API_KEY: "serper",
    YOU_API_KEY: "you",
  });
  const providers = createSearchProviders(config);
  assert.deepEqual(
    providers.map((p) => p.id).sort(),
    [...SEARCH_PROVIDER_IDS].sort(),
  );
});

void test("PRD 615: composition createSearchProviders with no keys produces keenable and you", () => {
  const token = "x".repeat(32);
  const config = parseConfig({ GROUNDLANE_AUTH_TOKEN: token });
  const providers = createSearchProviders(config);
  assert.deepEqual(
    providers.map((p) => p.id).sort(),
    ["keenable", "you"],
  );
});

// ---------------------------------------------------------------------------
// PRD 616: Registration validation
// ---------------------------------------------------------------------------

void test("PRD 616: duplicate ID is rejected", () => {
  const registry = new ProviderRegistry();
  registry.register(makeCustomRegistration("custom.dup"));
  assert.throws(
    () => registry.register(makeCustomRegistration("custom.dup")),
    { message: /Duplicate provider ID "custom\.dup"/ },
  );
});

void test("PRD 616: empty ID is rejected", () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.register(makeCustomRegistration("", { id: "" })),
    { message: /must not be empty/ },
  );
});

void test("PRD 616: built-in ID with dots is rejected", () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.register({
      ...makeCustomRegistration("has.dot"),
      id: "has.dot",
      protocol: "built-in",
    }),
    { message: /must be lowercase alphanumeric without dots/ },
  );
});

void test("PRD 616: built-in ID with uppercase is rejected", () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.register({
      ...makeCustomRegistration("Tavily"),
      id: "Tavily",
      protocol: "built-in",
    }),
    { message: /must be lowercase alphanumeric without dots/ },
  );
});

void test("PRD 616: custom ID not starting with custom. is rejected", () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.register(makeCustomRegistration("nocustomprefix")),
    { message: /must match custom\./ },
  );
});

void test("PRD 616: custom ID with uppercase after prefix is rejected", () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.register(makeCustomRegistration("custom.BadName")),
    { message: /must match custom\./ },
  );
});

void test("PRD 616: custom.* namespace enforcement - valid custom ID passes", () => {
  const registry = new ProviderRegistry();
  registry.register(makeCustomRegistration("custom.my-search"));
  assert.ok(registry.has("custom.my-search"));
  assert.ok(registry.isCustom("custom.my-search"));
});

void test("PRD 616: unknown protocol is rejected", () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.register({
      ...makeCustomRegistration("custom.test"),
      protocol: "unknown-proto" as "built-in",
    }),
    { message: /Unknown protocol/ },
  );
});

void test("PRD 616: reserved built-in IDs cannot be re-registered", () => {
  const registry = createBuiltInRegistry();
  assert.throws(
    () => registry.register({
      ...makeCustomRegistration("tavily"),
      id: "tavily",
      protocol: "built-in",
    }),
    { message: /Duplicate provider ID "tavily"/ },
  );
});

void test("PRD 616: custom.* namespace does not collide with built-in IDs", () => {
  const registry = createBuiltInRegistry();
  registry.register(makeCustomRegistration("custom.tavily"));
  assert.ok(registry.has("custom.tavily"));
  assert.ok(registry.has("tavily"));
  assert.notEqual(registry.get("custom.tavily"), registry.get("tavily"));
});

void test("PRD 616: isCustom returns false for built-in IDs", () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.isCustom("tavily"), false);
  assert.equal(registry.isCustom("exa"), false);
});

// ---------------------------------------------------------------------------
// PRD 617: Protocol v1 search only
// ---------------------------------------------------------------------------

void test("PRD 617: custom provider with only search capability registers successfully", () => {
  const registry = createBuiltInRegistry();
  registry.register(makeCustomRegistration("custom.search-only", {
    capabilities: { search: true },
  }));
  assert.ok(registry.has("custom.search-only"));
  assert.equal(registry.get("custom.search-only")?.capabilities.search, true);
});

void test("PRD 617: custom provider declaring unsupported capabilities is accepted", () => {
  const registry = createBuiltInRegistry();
  registry.register(makeCustomRegistration("custom.multi-cap", {
    capabilities: { search: true, content: true, crawl: true },
  }));
  const reg = registry.get("custom.multi-cap");
  assert.ok(reg);
  assert.equal(reg.capabilities.search, true);
  assert.equal(reg.capabilities.content, true);
  assert.equal(reg.capabilities.crawl, true);
  assert.equal(reg.protocol, "groundlane-provider-v1");
});

void test("PRD 617: all built-in providers use built-in protocol", () => {
  const registry = createBuiltInRegistry();
  for (const id of SEARCH_PROVIDER_IDS) {
    assert.equal(registry.get(id)?.protocol, "built-in", `${id} should have built-in protocol`);
  }
});

// ---------------------------------------------------------------------------
// PRD 623: Custom provider defaults
// ---------------------------------------------------------------------------

void test("PRD 623: custom providers default to disabled with zero budgets", () => {
  const reg = makeCustomRegistration("custom.zero-budget");
  assert.equal(reg.enabled, false);
  assert.equal(reg.defaultMonthlyBudget, 0);
});

void test("PRD 623: only explicit enable + positive budget allows dispatch", () => {
  const registry = createBuiltInRegistry();

  registry.register(makeCustomRegistration("custom.disabled-budget", {
    enabled: false,
    defaultMonthlyBudget: 100,
  }));
  assert.ok(!registry.enabledIds().includes("custom.disabled-budget"));

  registry.register(makeCustomRegistration("custom.enabled-zero", {
    enabled: true,
    defaultMonthlyBudget: 0,
  }));
  assert.ok(registry.enabledIds().includes("custom.enabled-zero"));
  assert.equal(registry.get("custom.enabled-zero")?.defaultMonthlyBudget, 0);

  registry.register(makeCustomRegistration("custom.enabled-budget", {
    enabled: true,
    defaultMonthlyBudget: 500,
  }));
  assert.ok(registry.enabledIds().includes("custom.enabled-budget"));
  assert.equal(registry.get("custom.enabled-budget")?.defaultMonthlyBudget, 500);
});

void test("PRD 623: auto/balanced/deep strategies should exclude custom providers", () => {
  const registry = createBuiltInRegistry();
  registry.register(makeCustomRegistration("custom.auto-excluded", {
    enabled: true,
    defaultMonthlyBudget: 1000,
  }));

  const builtInIds = registry.enabledIds().filter((id) => !registry.isCustom(id));
  const customIds = registry.enabledIds().filter((id) => registry.isCustom(id));

  assert.ok(customIds.includes("custom.auto-excluded"));
  assert.ok(!builtInIds.includes("custom.auto-excluded"));
  for (const id of SEARCH_PROVIDER_IDS) {
    assert.ok(builtInIds.includes(id), `built-in ${id} should be in non-custom enabled list`);
  }
});

void test("PRD 623: custom provider backend and ownership", () => {
  const reg = makeCustomRegistration("custom.hosted");
  assert.equal(reg.backend, "http-compatible");
  assert.equal(reg.ownership, "operator-hosted");
});

// ---------------------------------------------------------------------------
// Registry API completeness
// ---------------------------------------------------------------------------

void test("get returns undefined for unknown provider", () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.get("nonexistent"), undefined);
});

void test("has returns false for unknown provider", () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.has("nonexistent"), false);
});

void test("family falls back to general-web for unknown provider", () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.family("nonexistent"), "general-web");
});

void test("weight falls back to 0.5 for unknown provider", () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.weight("nonexistent"), 0.5);
});

void test("filterSpec falls back to none/no-timeRange for unknown provider", () => {
  const registry = createBuiltInRegistry();
  assert.deepEqual(registry.filterSpec("nonexistent"), { mode: "none", timeRange: false });
});

void test("all built-in providers are enabled", () => {
  const registry = createBuiltInRegistry();
  for (const id of SEARCH_PROVIDER_IDS) {
    assert.equal(registry.get(id)?.enabled, true, `${id} should be enabled`);
  }
});

void test("all built-in providers have envKeyName", () => {
  const registry = createBuiltInRegistry();
  for (const id of SEARCH_PROVIDER_IDS) {
    const reg = registry.get(id);
    assert.ok(reg?.envKeyName, `${id} should have envKeyName`);
    assert.ok(reg.envKeyName.endsWith("_API_KEY"), `${id} envKeyName should end with _API_KEY`);
  }
});

void test("providerCapabilities returns entry for every registered provider", () => {
  const registry = createBuiltInRegistry();
  const caps = registry.providerCapabilities();
  for (const id of SEARCH_PROVIDER_IDS) {
    assert.ok(id in caps, `providerCapabilities missing ${id}`);
    assert.equal(caps[id]?.provider, id);
  }
});
