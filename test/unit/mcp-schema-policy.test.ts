import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceMcpSchemaPolicy,
  McpSchemaPolicyError,
} from "../../src/mcp/schema-policy.js";

void test("schema policy accepts bounded 2020-12 composition and local references", () => {
  const result = enforceMcpSchemaPolicy({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { value: { type: "string" } },
    oneOf: [
      { $ref: "#/$defs/value" },
      { type: "number" },
    ],
  });
  assert.equal(result.compositionBranches, 2);
  assert.ok(result.nodes > 1);
});

void test("schema policy rejects external references and every resource bound", () => {
  assert.throws(
    () => enforceMcpSchemaPolicy({ $ref: "https://example.com/schema.json" }),
    /external references are disabled/u,
  );
  assert.throws(
    () => enforceMcpSchemaPolicy({ value: "x".repeat(100) }, { maxBytes: 16 }),
    /serialized size/u,
  );
  assert.throws(
    () => enforceMcpSchemaPolicy({ a: { b: { c: true } } }, { maxDepth: 2 }),
    /depth/u,
  );
  assert.throws(
    () => enforceMcpSchemaPolicy({ anyOf: [{}, {}, {}] }, { maxCompositionBranches: 2 }),
    /composition branches/u,
  );
  assert.throws(
    () => enforceMcpSchemaPolicy({ a: 1, b: 2 }, { maxNodes: 2 }),
    /node count/u,
  );
});

void test("schema admission has a deterministic time budget", () => {
  let tick = 0;
  assert.throws(
    () => enforceMcpSchemaPolicy(
      { properties: { one: { type: "string" }, two: { type: "number" } } },
      { maxAdmissionMs: 2, now: () => tick++ },
    ),
    (error: unknown) =>
      error instanceof McpSchemaPolicyError && /admission exceeds/u.test(error.message),
  );
});
