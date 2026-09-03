import assert from "node:assert/strict";
import test from "node:test";

import type { ErrorLogSink, PersistedErrorEvent } from "../../src/core/error-log.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createErrorLogModule, errorLogInputSchema } from "../../src/tools/error-log.js";

type RegisteredHandler = (
  input: {
    tool?: string;
    code?: string;
    hintCode?: string;
    since?: string;
    limit?: number;
  },
  extra: { signal?: AbortSignal },
) => unknown;

function fakeServer() {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    handlers,
    server: {
      registerTool(name: string, _definition: unknown, handler: RegisteredHandler): void {
        handlers.set(name, handler);
      },
    },
  };
}

const sampleEvents: PersistedErrorEvent[] = [
  {
    id: "evt-001",
    timestamp: "2026-09-01T10:00:00.000Z",
    tool: "web_search",
    code: "UPSTREAM_ERROR",
    stage: "search",
    hintCode: undefined,
    message: "Provider returned 502",
    retryable: true,
    latencyMs: 1200,
  },
  {
    id: "evt-002",
    timestamp: "2026-09-01T11:00:00.000Z",
    tool: "web_fetch",
    code: "DEADLINE_EXCEEDED",
    stage: "fetch",
    hintCode: "web_fetch.timeout",
    message: "Fetch timed out",
    retryable: true,
    latencyMs: 5000,
  },
];

function queryableSink(events: PersistedErrorEvent[]): ErrorLogSink {
  return {
    record(): void {
      // intentionally empty
    },
    query(filter): Promise<readonly PersistedErrorEvent[]> {
      let filtered = [...events];
      if (filter.tool !== undefined) {
        filtered = filtered.filter((e) => e.tool === filter.tool);
      }
      if (filter.code !== undefined) {
        filtered = filtered.filter((e) => e.code === filter.code);
      }
      if (filter.since !== undefined) {
        filtered = filtered.filter((e) => new Date(e.timestamp) >= filter.since!);
      }
      if (filter.limit !== undefined) {
        filtered = filtered.slice(0, filter.limit);
      }
      return Promise.resolve(filtered);
    },
  };
}

void test("error_log returns all entries when no filter is applied", async () => {
  const { handlers, server } = fakeServer();
  await createMcpRegistry([
    createErrorLogModule({
      sink: queryableSink(sampleEvents),
      cloudflareQuery: undefined,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("error_log");
  assert.ok(handler);
  const result = await handler({}, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: {
      entries?: Array<{
        id?: string;
        tool?: string;
        code?: string;
        message?: string;
        retryable?: boolean;
        latencyMs?: number;
        hintCode?: string;
      }>;
      count?: number;
      queryable?: boolean;
    };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.queryable, true);
  assert.equal(envelope.data?.count, 2);
  assert.equal(envelope.data?.entries?.length, 2);
  assert.equal(envelope.data?.entries?.[0]?.id, "evt-001");
  assert.equal(envelope.data?.entries?.[0]?.tool, "web_search");
  assert.equal(envelope.data?.entries?.[0]?.code, "UPSTREAM_ERROR");
  assert.equal(envelope.data?.entries?.[0]?.retryable, true);
  assert.equal(envelope.data?.entries?.[0]?.latencyMs, 1200);
  assert.equal(envelope.data?.entries?.[1]?.id, "evt-002");
  assert.equal(envelope.data?.entries?.[1]?.hintCode, "web_fetch.timeout");
});

void test("error_log filters by tool name", async () => {
  const { handlers, server } = fakeServer();
  await createMcpRegistry([
    createErrorLogModule({
      sink: queryableSink(sampleEvents),
      cloudflareQuery: undefined,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("error_log");
  assert.ok(handler);
  const result = await handler({ tool: "web_fetch" }, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: {
      entries?: Array<{ tool?: string }>;
      count?: number;
    };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.count, 1);
  assert.equal(envelope.data?.entries?.[0]?.tool, "web_fetch");
});

void test("error_log returns empty entries when sink has no query method", async () => {
  const { handlers, server } = fakeServer();
  const noQuerySink: ErrorLogSink = {
    record(): void {
      // intentionally empty
    },
    // no query method
  };
  await createMcpRegistry([
    createErrorLogModule({
      sink: noQuerySink,
      cloudflareQuery: undefined,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("error_log");
  assert.ok(handler);
  const result = await handler({}, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: {
      entries?: unknown[];
      count?: number;
      queryable?: boolean;
    };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.queryable, false);
  assert.equal(envelope.data?.count, 0);
  assert.deepEqual(envelope.data?.entries, []);
});

void test("error_log input schema rejects limit below 1", () => {
  assert.throws(
    () => errorLogInputSchema.parse({ limit: 0 }),
    (error: unknown) => error instanceof Error && /too_small/i.test(error.message),
  );
});

void test("error_log input schema rejects limit above 200", () => {
  assert.throws(
    () => errorLogInputSchema.parse({ limit: 201 }),
    (error: unknown) => error instanceof Error && /too_big/i.test(error.message),
  );
});

void test("error_log input schema rejects invalid datetime for since", () => {
  assert.throws(
    () => errorLogInputSchema.parse({ since: "not-a-date" }),
  );
});

void test("error_log input schema rejects empty tool string", () => {
  assert.throws(
    () => errorLogInputSchema.parse({ tool: "" }),
  );
});

void test("error_log input schema accepts valid filter parameters", () => {
  const parsed = errorLogInputSchema.parse({
    tool: "web_search",
    code: "UPSTREAM_ERROR",
    since: "2026-09-01T00:00:00Z",
    limit: 10,
  });
  assert.equal(parsed.tool, "web_search");
  assert.equal(parsed.code, "UPSTREAM_ERROR");
  assert.equal(parsed.since, "2026-09-01T00:00:00Z");
  assert.equal(parsed.limit, 10);
});

void test("error_log input schema applies default limit of 50", () => {
  const parsed = errorLogInputSchema.parse({});
  assert.equal(parsed.limit, 50);
});
