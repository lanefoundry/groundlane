import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

const configSchema = z.object({
  name: z.string(),
  kv_namespaces: z.array(z.object({ id: z.string() })),
  d1_databases: z.array(z.object({ database_id: z.string(), database_name: z.string() })),
  r2_buckets: z.array(z.object({ bucket_name: z.string() })),
  vars: z.record(z.string(), z.string()),
  containers: z.array(z.object({ max_instances: z.number() })),
});

void test("PRD staging never shares production storage or provider credentials", async () => {
  const read = async (name: string) => {
    const text = await readFile(new URL(`../../${name}`, import.meta.url), "utf8");
    const parsed = ts.parseConfigFileTextToJson(name, text);
    assert.equal(parsed.error, undefined);
    return configSchema.parse(parsed.config as unknown);
  };
  const [production, staging] = await Promise.all([read("wrangler.jsonc"), read("wrangler.staging.jsonc")]);
  assert.equal(staging.name, "groundlane-prd-staging");
  assert.notEqual(staging.name, production.name);
  for (const binding of staging.d1_databases) {
    assert.ok(binding.database_name.startsWith("groundlane-prd-staging"));
    assert.ok(!production.d1_databases.some(other => other.database_id === binding.database_id));
  }
  for (const binding of staging.r2_buckets) {
    assert.ok(binding.bucket_name.startsWith("groundlane-prd-staging"));
    assert.ok(!production.r2_buckets.some(other => other.bucket_name === binding.bucket_name));
  }
  for (const binding of staging.kv_namespaces) {
    assert.ok(!production.kv_namespaces.some(other => other.id === binding.id));
  }
  assert.equal(staging.vars.GROUNDLANE_MCP_PROTOCOL_MODE, "legacy-only");
  assert.equal(staging.vars.DOCUMENT_CACHE_EDGE_ENABLED, "true");
  assert.equal(staging.vars.BROWSER_BACKEND, "disabled");
  assert.ok(staging.containers.every(container => container.max_instances === 1));
  assert.deepEqual(Object.keys(staging.vars).filter(name => /(?:TOKEN|SECRET|API_KEY|ACCESS_KEY)/u.test(name)), []);
});
