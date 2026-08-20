import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpRegistry } from "../../src/mcp/registry.js";

void test("registry applies modules in insertion order", async () => {
  const applied: string[] = [];
  const modules = ["search", "fetch"].map((name) => ({
    name,
    register() {
      applied.push(name);
    },
  }));
  const registry = createMcpRegistry(modules);

  await registry.registerAll({} as McpServer);

  assert.deepEqual(registry.names(), ["search", "fetch"]);
  assert.deepEqual(applied, ["search", "fetch"]);
});

void test("registry rejects duplicate module names", () => {
  const module = { name: "fetch", register() {} };
  const registry = createMcpRegistry([module]);

  assert.throws(
    () => registry.add(module),
    /MCP module already registered: fetch/,
  );
});
