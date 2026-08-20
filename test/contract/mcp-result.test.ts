import assert from "node:assert/strict";
import test from "node:test";

import {
  structuredToolError,
  structuredToolResult,
} from "../../src/mcp/results.js";

void test("structured result supports new and legacy MCP clients", () => {
  const value = { status: "ok", count: 2 } as const;
  const result = structuredToolResult(value);

  assert.deepEqual(result.structuredContent, value);
  assert.deepEqual(result.content, [
    { type: "text", text: '{"status":"ok","count":2}' },
  ]);
  assert.equal(result.isError, undefined);
});

void test("structured errors retain structured and legacy payloads", () => {
  const value = { code: "upstream_timeout" } as const;
  const result = structuredToolError(value, "The upstream timed out");

  assert.deepEqual(result.structuredContent, value);
  assert.deepEqual(result.content, [
    { type: "text", text: "The upstream timed out" },
  ]);
  assert.equal(result.isError, true);
});
