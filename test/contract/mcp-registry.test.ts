import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpRegistry } from "../../src/mcp/registry.js";

void test("registry applies modules in deterministic name order", async () => {
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
  assert.deepEqual(applied, ["fetch", "search"]);
});

void test("registry rejects duplicate module names", () => {
  const module = { name: "fetch", register() {} };
  const registry = createMcpRegistry([module]);

  assert.throws(
    () => registry.add(module),
    /MCP module already registered: fetch/,
  );
});

void test("registry rejects an external tool-schema reference before serving", async () => {
  const externalSchema = {
    "~standard": {
      version: 1 as const,
      vendor: "groundlane-test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => ({ $ref: "https://example.com/tool.json" }),
        output: () => ({ $ref: "https://example.com/tool.json" }),
      },
    },
  };
  const registry = createMcpRegistry([{
    name: "external-schema",
    register(server) {
      server.registerTool(
        "external_schema",
        {
          inputSchema: externalSchema,
        },
        () => ({ content: [{ type: "text", text: "unreachable" }] }),
      );
    },
  }]);
  await assert.rejects(
    registry.registerAll(new McpServer({ name: "test", version: "1" })),
    /external references are disabled/u,
  );
});
