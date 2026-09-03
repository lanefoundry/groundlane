import assert from "node:assert/strict";
import test from "node:test";

import { providerCapabilities, providerCapability } from "../../src/core/provider-capabilities.js";
import { SEARCH_PROVIDER_IDS } from "../../src/core/search-provider-catalog.js";
import { ANSWER_PROVIDER_IDS } from "../../src/core/answer-router.js";
import { RESEARCH_PROVIDER_IDS } from "../../src/core/research-router.js";
import { CONTENT_PROVIDER_IDS } from "../../src/core/content-router.js";
import { MAP_PROVIDER_IDS } from "../../src/core/map-router.js";
import { CRAWL_PROVIDER_IDS } from "../../src/core/crawl-router.js";
import { NEWS_PROVIDER_IDS } from "../../src/core/news-router.js";
import { IMAGES_PROVIDER_IDS } from "../../src/core/images-router.js";

void test("provider capabilities list exposed Groundlane tools separately from vendor features", () => {
  const you = providerCapability("you");

  assert.equal(you.provider, "you");
  assert.ok(you.vendorFeatures.includes("Contents"));
  assert.ok(you.groundlaneTools.includes("web_search"));
  assert.ok(you.groundlaneTools.includes("provider_balance"));
  assert.equal(you.balanceSupport, "api");
});

void test("provider capabilities return one entry per requested provider", () => {
  const capabilities = providerCapabilities(["linkup", "serper"]);

  assert.deepEqual(capabilities.map((item) => item.provider), ["linkup", "serper"]);
  assert.equal(capabilities[0]?.balanceSupport, "api");
  assert.equal(capabilities[1]?.balanceSupport, "dashboard");
  assert.ok(capabilities[1]?.groundlaneTools.includes("web_images"));
});

// ---------------------------------------------------------------------------
// Cross-reference: static CAPABILITIES map <-> adapter registries
// ---------------------------------------------------------------------------

/** Resolve the CAPABILITIES map keys via providerCapability: a provider has a
 *  real entry when its result does NOT contain the fallback sentinel note. */
function capabilitiesMapIds(): Set<string> {
  const ids = new Set<string>();
  for (const id of SEARCH_PROVIDER_IDS) {
    const cap = providerCapability(id);
    const isFallback = cap.notes.some((n) => n.includes("not in the static Groundlane capability catalog"));
    if (!isFallback) ids.add(id);
  }
  return ids;
}

/** Extract the set of provider IDs whose CAPABILITIES entry lists a given tool. */
function providersClaimingTool(tool: string): Set<string> {
  const ids = new Set<string>();
  for (const id of SEARCH_PROVIDER_IDS) {
    const cap = providerCapability(id);
    if (cap.groundlaneTools.includes(tool)) ids.add(id);
  }
  return ids;
}

void test("every SEARCH_PROVIDER_ID has an entry in the CAPABILITIES map", () => {
  const mapped = capabilitiesMapIds();
  const missing = SEARCH_PROVIDER_IDS.filter((id) => !mapped.has(id));
  assert.deepEqual(missing, [], `SEARCH_PROVIDER_IDS entries missing from CAPABILITIES: ${missing.join(", ")}`);
});

void test("every CAPABILITIES key is a valid SEARCH_PROVIDER_ID", () => {
  const catalogSet = new Set<string>(SEARCH_PROVIDER_IDS);
  const mapped = capabilitiesMapIds();
  const extra = [...mapped].filter((id) => !catalogSet.has(id));
  assert.deepEqual(extra, [], `CAPABILITIES keys not in SEARCH_PROVIDER_IDS: ${extra.join(", ")}`);
});

void test("CAPABILITIES web_answer providers match ANSWER_PROVIDER_IDS", () => {
  const fromCaps = providersClaimingTool("web_answer");
  const fromRegistry = new Set<string>(ANSWER_PROVIDER_IDS);
  assert.deepEqual([...fromCaps].sort(), [...fromRegistry].sort(),
    "web_answer mismatch between CAPABILITIES and ANSWER_PROVIDER_IDS");
});

void test("CAPABILITIES web_research providers match RESEARCH_PROVIDER_IDS", () => {
  const fromCaps = providersClaimingTool("web_research");
  const fromRegistry = new Set<string>(RESEARCH_PROVIDER_IDS);
  assert.deepEqual([...fromCaps].sort(), [...fromRegistry].sort(),
    "web_research mismatch between CAPABILITIES and RESEARCH_PROVIDER_IDS");
});

void test("CAPABILITIES web_content providers match CONTENT_PROVIDER_IDS", () => {
  const fromCaps = providersClaimingTool("web_content");
  const fromRegistry = new Set<string>(CONTENT_PROVIDER_IDS);
  assert.deepEqual([...fromCaps].sort(), [...fromRegistry].sort(),
    "web_content mismatch between CAPABILITIES and CONTENT_PROVIDER_IDS");
});

void test("CAPABILITIES web_map providers match MAP_PROVIDER_IDS", () => {
  const fromCaps = providersClaimingTool("web_map");
  const fromRegistry = new Set<string>(MAP_PROVIDER_IDS);
  assert.deepEqual([...fromCaps].sort(), [...fromRegistry].sort(),
    "web_map mismatch between CAPABILITIES and MAP_PROVIDER_IDS");
});

void test("CAPABILITIES web_crawl providers match CRAWL_PROVIDER_IDS", () => {
  const fromCaps = providersClaimingTool("web_crawl");
  const fromRegistry = new Set<string>(CRAWL_PROVIDER_IDS);
  assert.deepEqual([...fromCaps].sort(), [...fromRegistry].sort(),
    "web_crawl mismatch between CAPABILITIES and CRAWL_PROVIDER_IDS");
});

void test("CAPABILITIES web_news providers match NEWS_PROVIDER_IDS", () => {
  const fromCaps = providersClaimingTool("web_news");
  const fromRegistry = new Set<string>(NEWS_PROVIDER_IDS);
  assert.deepEqual([...fromCaps].sort(), [...fromRegistry].sort(),
    "web_news mismatch between CAPABILITIES and NEWS_PROVIDER_IDS");
});

void test("CAPABILITIES web_images providers match IMAGES_PROVIDER_IDS", () => {
  const fromCaps = providersClaimingTool("web_images");
  const fromRegistry = new Set<string>(IMAGES_PROVIDER_IDS);
  assert.deepEqual([...fromCaps].sort(), [...fromRegistry].sort(),
    "web_images mismatch between CAPABILITIES and IMAGES_PROVIDER_IDS");
});
