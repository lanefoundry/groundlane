import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../../src/config.js";

void test("self-hosted durable corpus configuration is explicit and bounded", () => {
  const token = "x".repeat(32);
  const defaults = parseConfig({ GROUNDLANE_AUTH_TOKEN: token });
  assert.equal(defaults.corpusStatePath, undefined);
  assert.equal(defaults.corpusTenantId, "default");
  assert.equal(defaults.corpusMaxSourceBytes, 1_000_000);

  const configured = parseConfig({
    GROUNDLANE_AUTH_TOKEN: token,
    CORPUS_STATE_PATH: "/var/lib/groundlane/corpus.sqlite",
    CORPUS_TENANT_ID: "deployment-a",
    CORPUS_MAX_SOURCE_BYTES: "2097152",
  });
  assert.equal(configured.corpusStatePath, "/var/lib/groundlane/corpus.sqlite");
  assert.equal(configured.corpusTenantId, "deployment-a");
  assert.equal(configured.corpusMaxSourceBytes, 2_097_152);
  assert.throws(() => parseConfig({
    GROUNDLANE_AUTH_TOKEN: token,
    CORPUS_MAX_SOURCE_BYTES: "33554433",
  }), /CORPUS_MAX_SOURCE_BYTES|less than or equal/u);
});
