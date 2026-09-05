import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import { MCP_TASKS_EXTENSION } from "../../src/core/mcp-tasks.js";
import type { AuthenticatedPrincipal } from "../../src/worker/auth.js";
import type { D1DatabaseLike, D1StatementLike } from "../../src/worker/d1-managed-store.js";
import { maybeHandleEdgeTasks } from "../../src/worker/tasks-runtime.js";

class FakeDurableD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Record<string, unknown>>();
  failAll = false;

  prepare(query: string): D1StatementLike {
    return new FakeDurableStatement(this, query);
  }

  batch(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  withSession(): D1DatabaseLike {
    return this;
  }

  rowKey(namespace: unknown, key: unknown): string {
    return `${String(namespace)}\0${String(key)}`;
  }
}

class FakeDurableStatement implements D1StatementLike {
  private bound: readonly unknown[] = [];

  constructor(private readonly db: FakeDurableD1, private readonly query: string) {}

  bind(...values: unknown[]): D1StatementLike {
    this.bound = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    if (this.db.failAll) throw new Error("D1 unavailable");
    const row = this.db.rows.get(this.db.rowKey(this.bound[0], this.bound[1]));
    return Promise.resolve((row === undefined ? null : { ...row }) as T | null);
  }

  all<T>(): Promise<{ results: readonly T[] }> {
    return Promise.resolve({ results: [] });
  }

  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    if (this.db.failAll) throw new Error("D1 unavailable");
    if (this.query.startsWith("INSERT INTO durable_records")) {
      const [namespace, key, value, createdAt, updatedAt, expiresAt] = this.bound;
      const id = this.db.rowKey(namespace, key);
      if (this.db.rows.has(id)) return Promise.resolve({ success: true, meta: { changes: 0 } });
      this.db.rows.set(id, {
        namespace, key, value, revision: 1,
        created_at: createdAt, updated_at: updatedAt, expires_at: expiresAt,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith("UPDATE durable_records")) {
      const [value, updatedAt, expiresAt, namespace, key, expectedRevision] = this.bound;
      const id = this.db.rowKey(namespace, key);
      const row = this.db.rows.get(id);
      if (row === undefined || row.revision !== expectedRevision) {
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.rows.set(id, {
        ...row,
        value,
        revision: Number(row.revision) + 1,
        updated_at: updatedAt,
        expires_at: expiresAt,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    throw new Error(`unexpected query: ${this.query}`);
  }
}

const principal: AuthenticatedPrincipal = {
  principalId: "owner",
  authMethod: "static_bearer",
  scopes: ["mcp"],
};

function body(id: number, method: string, params: Record<string, unknown>, tasks = true) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        [CLIENT_INFO_META_KEY]: { name: "worker-contract", version: "1" },
        [CLIENT_CAPABILITIES_META_KEY]: tasks
          ? { extensions: { [MCP_TASKS_EXTENSION]: {} } }
          : {},
      },
    },
  };
}

function request(value: object): Request {
  return new Request("https://groundlane.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function providerFetch(input: string, init: RequestInit): Promise<Response> {
  if (init.method === "POST") return Promise.resolve(Response.json({ id: "private-linkup-id" }));
  assert.match(input, /private-linkup-id$/u);
  return Promise.resolve(Response.json({
    status: "completed",
    output: { answer: "durable result", sources: [] },
  }));
}

void test("Worker D1 handles task start and reconnect without exposing provider IDs", async () => {
  const db = new FakeDurableD1();
  const env = { MANAGED_TOKEN_D1: db, LINKUP_API_KEY: "secret-linkup-key" };
  const created = await maybeHandleEdgeTasks(
    request(body(1, "tools/call", {
      name: "web_research_start",
      arguments: { query: "D1 reconnect", idempotencyKey: "same" },
    })),
    env,
    principal,
    "static:legacy",
    "request-1",
    { fetch: providerFetch },
  );
  assert.ok(created !== undefined);
  const createdText = await created.text();
  assert.match(createdText, /"resultType":"task"/u);
  assert.doesNotMatch(createdText, /"content":/u);
  assert.doesNotMatch(createdText, /private-linkup-id|secret-linkup-key/u);
  const match = createdText.match(/"taskId":"([^"]+)"/u);
  assert.ok(match !== null && match[1] !== undefined);
  const taskId = match[1];

  const resumed = await maybeHandleEdgeTasks(
    request(body(2, "tasks/get", { taskId })),
    env,
    principal,
    "static:legacy",
    "request-2",
    { fetch: providerFetch },
  );
  assert.ok(resumed !== undefined);
  const resumedText = await resumed.text();
  assert.match(resumedText, /"status":"completed"/u);
  assert.match(resumedText, /durable result/u);
  assert.doesNotMatch(resumedText, /private-linkup-id|secret-linkup-key/u);
});

void test("Worker task capability, credential isolation, outage, and fallback are fail-closed", async () => {
  const db = new FakeDurableD1();
  const env = { MANAGED_TOKEN_D1: db, LINKUP_API_KEY: "secret-linkup-key" };
  const fallback = await maybeHandleEdgeTasks(
    request(body(1, "tools/call", {
      name: "web_research_start",
      arguments: { query: "fallback", idempotencyKey: "fallback" },
    }, false)),
    env,
    principal,
    "managed:one",
    "request-1",
    { fetch: providerFetch },
  );
  assert.ok(fallback !== undefined);
  const fallbackText = await fallback.text();
  assert.match(fallbackText, /structuredContent/u);
  assert.doesNotMatch(fallbackText, /"resultType":"task"/u);
  const taskMatch = fallbackText.match(/"taskId":"([^"]+)"/u);
  assert.ok(taskMatch !== null && taskMatch[1] !== undefined);
  const taskId = taskMatch[1];

  const missingCapability = await maybeHandleEdgeTasks(
    request(body(2, "tasks/get", { taskId }, false)),
    env,
    principal,
    "managed:one",
    "request-2",
    { fetch: providerFetch },
  );
  assert.ok(missingCapability !== undefined);
  assert.match(await missingCapability.text(), /-32021/u);

  const wrongCredential = await maybeHandleEdgeTasks(
    request(body(3, "tasks/get", { taskId })),
    env,
    principal,
    "managed:two",
    "request-3",
    { fetch: providerFetch },
  );
  assert.ok(wrongCredential !== undefined);
  assert.match(await wrongCredential.text(), /Unknown or unavailable task/u);

  db.failAll = true;
  const outage = await maybeHandleEdgeTasks(
    request(body(4, "tasks/get", { taskId })),
    env,
    principal,
    "managed:one",
    "request-4",
    { fetch: providerFetch },
  );
  assert.ok(outage !== undefined);
  assert.equal(outage.status, 500);
  assert.doesNotMatch(await outage.text(), /D1 unavailable|secret-linkup-key/u);

  assert.equal(await maybeHandleEdgeTasks(
    request(body(5, "tasks/get", { taskId })),
    { MANAGED_TOKEN_D1: db },
    principal,
    "managed:one",
    "request-5",
  ), undefined);
});
