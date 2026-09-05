import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  ProtocolError,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { createContainerApp } from "../../src/container/app.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { structuredToolResult } from "../../src/mcp/results.js";

const TOKEN = "test-token-that-is-long-enough-for-tests";
const FIXTURE_ROOT = new URL("../fixtures/mcp/2025-11-25/", import.meta.url);

const rpcFixtureSchema = z.object({
  request: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()),
}).strict();

const authFixtureSchema = rpcFixtureSchema.extend({
  expectedStatus: z.number().int(),
  expectedWwwAuthenticate: z.string(),
}).strict();

const schemaFixtureSchema = z.object({
  tool: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
}).strict();

const transportFixtureSchema = z.object({
  requestHeaders: z.record(z.string(), z.string()),
  expectedResponseHeaders: z.record(z.string(), z.string()),
  requiredResponseHeaderTokens: z.record(z.string(), z.array(z.string())),
  forbiddenResponseHeaders: z.array(z.string()),
}).strict();

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8")) as unknown;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function parseSseMessage(body: string): unknown {
  const line = body.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (line === undefined) throw new Error("legacy fixture response has no SSE data line");
  return JSON.parse(line.slice("data: ".length)) as unknown;
}

void test("MCP 2025-11-25 legacy wire, schema, auth, error, and transport fixtures stay frozen", async () => {
  const initialize = rpcFixtureSchema.parse(await fixture("initialize.json"));
  const originalToolsList = rpcFixtureSchema.parse(await fixture("tools-list.json"));
  const toolsList = rpcFixtureSchema.parse(await fixture("tools-list-sdk-v2.json"));
  const toolsCall = rpcFixtureSchema.parse(await fixture("tools-call.json"));
  const originalError = rpcFixtureSchema.parse(await fixture("error.json"));
  const error = rpcFixtureSchema.parse(await fixture("error-sdk-v2.json"));
  const auth = authFixtureSchema.parse(await fixture("auth-challenge.json"));
  const originalSchema = schemaFixtureSchema.parse(await fixture("schema.json"));
  const schema = schemaFixtureSchema.parse(await fixture("schema-sdk-v2.json"));
  const transport = transportFixtureSchema.parse(await fixture("transport.json"));

  const app = createContainerApp({
    authToken: TOKEN,
    registryFactory: () => createMcpRegistry([{
      name: "legacy-fixture",
      register(server): void {
        server.registerTool(
          "fixture_echo",
          {
            description: "Echo a bounded fixture value.",
            inputSchema: z.object({ value: z.string().max(32) }),
            outputSchema: z.object({ value: z.string() }),
          },
          ({ value }) => structuredToolResult({ value }),
        );
      },
    }]),
  });
  const server = createServer(app);
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;

  async function send(request: Record<string, unknown>, authenticated = true): Promise<Response> {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        ...transport.requestHeaders,
        ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(request),
    });
  }

  try {
    const cases = [initialize, toolsList, toolsCall, error];
    for (const testCase of cases) {
      const response = await send(testCase.request);
      assert.equal(response.status, 200);
      for (const [name, expectedValue] of Object.entries(transport.expectedResponseHeaders)) {
        assert.equal(response.headers.get(name), expectedValue);
      }
      for (const [name, requiredTokens] of Object.entries(transport.requiredResponseHeaderTokens)) {
        const actual = response.headers.get(name) ?? "";
        for (const token of requiredTokens) assert.ok(actual.split(",").map((part) => part.trim()).includes(token));
      }
      for (const name of transport.forbiddenResponseHeaders) {
        assert.equal(response.headers.has(name), false);
      }
      assert.deepEqual(parseSseMessage(await response.text()), testCase.expected);
    }

    const listedTool = z.object({
      result: z.object({ tools: z.array(z.object({
        name: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()),
      }).passthrough()) }),
    }).passthrough().parse(toolsList.expected).result.tools.find((tool) => tool.name === schema.tool);
    assert.ok(listedTool !== undefined);
    assert.deepEqual(listedTool.inputSchema, schema.inputSchema);
    assert.deepEqual(listedTool.outputSchema, schema.outputSchema);
    assert.notDeepEqual(toolsList.expected, originalToolsList.expected);
    assert.notDeepEqual(error.expected, originalError.expected);
    assert.equal(originalSchema.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.equal(schema.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");

    const authResponse = await send(auth.request, false);
    assert.equal(authResponse.status, auth.expectedStatus);
    assert.equal(authResponse.headers.get("www-authenticate"), auth.expectedWwwAuthenticate);
    const authBody = z.object({
      error: z.record(z.string(), z.unknown()),
      requestId: z.string().uuid(),
    }).strict().parse(await authResponse.json());
    assert.deepEqual({ ...authBody, requestId: "<request-id>" }, auth.expected);
  } finally {
    await close(server);
  }
});

void test("legacy clients tolerate arbitrary JSON results and resource-not-found codes", async () => {
  const app = createContainerApp({
    authToken: TOKEN,
    registryFactory: () => createMcpRegistry([{
      name: "legacy-json-contract",
      register(server): void {
        server.registerTool(
          "scalar_result",
          { inputSchema: z.object({}), outputSchema: z.string() },
          () => structuredToolResult("legacy-scalar"),
        );
        server.registerResource(
          "missing-contract",
          "groundlane://legacy-missing",
          { mimeType: "text/plain" },
          (uri) => {
            throw new ResourceNotFoundError(uri.href);
          },
        );
      },
    }]),
  });
  const server = createServer(app);
  const port = await listen(server);
  async function send(body: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return z.object({
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.object({ code: z.number(), data: z.unknown().optional() }).passthrough().optional(),
    }).passthrough().parse(parseSseMessage(await response.text()));
  }
  try {
    const scalar = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scalar_result", arguments: {} },
    });
    assert.deepEqual(scalar.result?.structuredContent, { result: "legacy-scalar" });
    const missingUri = "groundlane://legacy-missing";
    const missing = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: missingUri },
    });
    assert.equal(missing.error?.code, -32602);
    assert.deepEqual(missing.error?.data, { uri: missingUri });

    const historical = ProtocolError.fromError(
      -32002,
      "Resource not found",
      { uri: missingUri },
    );
    assert.ok(historical instanceof ResourceNotFoundError);
    assert.equal(historical.uri, missingUri);
  } finally {
    await close(server);
  }
});
