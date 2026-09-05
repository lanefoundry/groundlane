import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import { createContainerApp } from "../../src/container/app.js";
import { DurableMcpTaskRuntime } from "../../src/core/durable-mcp-tasks.js";
import { InMemoryDurableRecordStore } from "../../src/core/durable-store.js";
import {
  MCP_TASKS_EXTENSION,
  type AsyncTaskProviderPort,
} from "../../src/core/mcp-tasks.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { MCP_MODERN_PROTOCOL_VERSION } from "../../src/mcp/server.js";
import { structuredToolResult } from "../../src/mcp/results.js";
import {
  asyncResearchInputSchema,
  createAsyncResearchModule,
  type AsyncResearchInput,
} from "../../src/tools/async-research.js";

const TOKEN = "modern-task-contract-token-long-enough";

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

function requestBody(
  id: number,
  method: string,
  params: Record<string, unknown>,
  tasks = true,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: { name: "tasks-contract", version: "1" },
        [CLIENT_CAPABILITIES_META_KEY]: tasks
          ? { extensions: { [MCP_TASKS_EXTENSION]: {} } }
          : {},
      },
    },
  };
}

void test("official 2026 Tasks extension negotiates, polls, updates, cancels, and omits retired methods", async () => {
  let status: "working" | "input_required" | "completed" = "working";
  const updates: Record<string, unknown>[] = [];
  const provider: AsyncTaskProviderPort<AsyncResearchInput> = {
    id: "contract-provider",
    parseInput: (value) => asyncResearchInputSchema.parse(value),
    create: () => Promise.resolve("private-provider-task"),
    poll: (_providerTaskId, input) => {
      if (status === "input_required") {
        return Promise.resolve({
          status,
          inputRequests: {
            approve: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Approve research?",
                requestedSchema: { type: "object", properties: {} },
              },
            },
          },
        });
      }
      if (status === "completed") {
        return Promise.resolve({
          status,
          result: structuredToolResult({ ok: true, data: { query: input.query } }),
        });
      }
      return Promise.resolve({ status });
    },
    update: (_providerTaskId, inputResponses) => {
      updates.push(inputResponses);
      status = "completed";
      return Promise.resolve();
    },
    cancel: () => Promise.resolve(null),
  };
  const runtime = new DurableMcpTaskRuntime(
    new InMemoryDurableRecordStore(),
    provider,
    5_000,
  );
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "modern-only",
    registryFactory: () => createMcpRegistry([
      createAsyncResearchModule({
        runtime,
        caller: { ownerId: "owner", credentialBinding: "static:legacy" },
      }),
    ]),
  });
  const server = createServer(app);
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;

  async function send(
    id: number,
    method: string,
    params: Record<string, unknown>,
    options: { tasks?: boolean; name?: string } = {},
  ): Promise<{ status: number; body: object }> {
    const inferredName = typeof params.taskId === "string" ? params.taskId : undefined;
    const requestName = options.name ?? inferredName;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
        "mcp-method": method,
        ...(requestName === undefined ? {} : { "mcp-name": requestName }),
      },
      body: JSON.stringify(requestBody(id, method, params, options.tasks ?? true)),
    });
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("invalid JSON-RPC response");
    }
    return { status: response.status, body };
  }

  try {
    const discover = await send(1, "server/discover", {});
    assert.match(JSON.stringify(discover.body), new RegExp(MCP_TASKS_EXTENSION, "u"));

    const created = await send(
      2,
      "tools/call",
      { name: "web_research_start", arguments: { query: "durable tasks" } },
      { name: "web_research_start" },
    );
    const createdText = JSON.stringify(created.body);
    assert.match(createdText, /"resultType":"task"/u);
    assert.doesNotMatch(createdText, /"content":/u);
    assert.doesNotMatch(createdText, /private-provider-task/u);
    const taskIdMatch = createdText.match(/"taskId":"([^"]+)"/u);
    assert.ok(taskIdMatch !== null);
    const taskId = taskIdMatch[1];
    assert.ok(taskId !== undefined);

    status = "input_required";
    const waiting = await send(3, "tasks/get", { taskId });
    assert.match(JSON.stringify(waiting.body), /"status":"input_required"/u);
    const updated = await send(4, "tasks/update", {
      taskId,
      inputResponses: { approve: { action: "accept", content: { approved: true } } },
    });
    assert.match(JSON.stringify(updated.body), /"resultType":"complete"/u);
    assert.equal(updates.length, 1);

    const completed = await send(5, "tasks/get", { taskId });
    assert.match(JSON.stringify(completed.body), /"status":"completed"/u);
    assert.match(JSON.stringify(completed.body), /"query":"durable tasks"/u);

    const fallback = await send(
      6,
      "tools/call",
      { name: "web_research_start", arguments: { query: "compatibility" } },
      { tasks: false, name: "web_research_start" },
    );
    assert.match(JSON.stringify(fallback.body), /"resultType":"complete"/u);
    assert.match(JSON.stringify(fallback.body), /structuredContent/u);

    const missingCapability = await send(7, "tasks/get", { taskId }, { tasks: false });
    assert.match(JSON.stringify(missingCapability.body), /-32021/u);

    for (const [id, method] of [[8, "tasks/list"], [9, "tasks/result"]] as const) {
      const retired = await send(id, method, { taskId });
      assert.match(JSON.stringify(retired.body), /-32601/u, method);
    }

    status = "working";
    const cancellable = await send(
      10,
      "tools/call",
      { name: "web_research_start", arguments: { query: "cancel me" } },
      { name: "web_research_start" },
    );
    const cancelMatch = JSON.stringify(cancellable.body).match(/"taskId":"([^"]+)"/u);
    assert.ok(cancelMatch !== null);
    const cancelTaskId = cancelMatch[1];
    assert.ok(cancelTaskId !== undefined);
    const cancelled = await send(11, "tasks/cancel", { taskId: cancelTaskId });
    assert.match(JSON.stringify(cancelled.body), /"resultType":"complete"/u);
    const cancelledState = await send(12, "tasks/get", { taskId: cancelTaskId });
    assert.match(JSON.stringify(cancelledState.body), /"status":"cancelled"/u);
  } finally {
    await close(server);
  }
});
