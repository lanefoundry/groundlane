import assert from "node:assert/strict";
import test from "node:test";

import { providerCapabilities, providerCapability } from "../../src/core/provider-capabilities.js";

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
});
