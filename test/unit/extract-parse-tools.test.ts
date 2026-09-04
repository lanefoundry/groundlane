import assert from "node:assert/strict";
import test from "node:test";

import { DisabledBrowserBackend } from "../../src/adapters/browser/disabled.js";
import type { HttpFetcher, RawDocument } from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { FetchPipeline } from "../../src/core/fetch-pipeline.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createWebExtractModule } from "../../src/tools/web-extract.js";
import { createParseModule } from "../../src/tools/parse.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RegisteredHandler = (input: Record<string, any>, extra: { signal?: AbortSignal }) => unknown;

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

function failingHttpFetcher(error: Error): HttpFetcher {
  return {
    fetch(): Promise<RawDocument> {
      return Promise.reject(error);
    },
  };
}

const html = `<!doctype html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>`;

function successHttpFetcher(): HttpFetcher {
  return {
    fetch(request): Promise<RawDocument> {
      return Promise.resolve({
        requestedUrl: request.url,
        finalUrl: request.url,
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(html),
        engine: "http",
        backend: "direct",
      });
    },
  };
}

// --- web_extract upstream failure ---

void test("web_extract returns error envelope when upstream fetch throws GroundlaneError", async () => {
  const { handlers, server } = fakeServer();
  const upstreamError = new GroundlaneError("UPSTREAM_ERROR", "connect", "Connection refused", true);
  const pipeline = new FetchPipeline(failingHttpFetcher(upstreamError), new DisabledBrowserBackend());
  await createMcpRegistry([
    createWebExtractModule({
      pipeline,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("web_extract");
  assert.ok(handler);
  const result = await handler(
    {
      url: "https://example.com",
      render: "never",
      fields: [{ engine: "selector", name: "heading", selector: "h1", value: "text", many: false }],
    },
    {},
  );
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    error?: { code?: string; stage?: string; retryable?: boolean };
  };

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "UPSTREAM_ERROR");
  assert.equal(envelope.error?.retryable, true);
});

void test("web_extract returns error envelope when upstream throws generic error", async () => {
  const { handlers, server } = fakeServer();
  const pipeline = new FetchPipeline(
    failingHttpFetcher(new Error("network timeout")),
    new DisabledBrowserBackend(),
  );
  await createMcpRegistry([
    createWebExtractModule({
      pipeline,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("web_extract");
  assert.ok(handler);
  const result = await handler(
    {
      url: "https://example.com",
      render: "never",
      fields: [{ engine: "selector", name: "heading", selector: "h1", value: "text", many: false }],
    },
    {},
  );
  const envelope = (result as { structuredContent?: unknown; isError?: boolean }).structuredContent as {
    ok?: boolean;
    error?: { code?: string };
  };

  assert.equal(envelope.ok, false);
  assert.ok(envelope.error?.code);
});

// --- parse upstream failure ---

void test("parse returns error envelope when upstream fetch throws GroundlaneError", async () => {
  const { handlers, server } = fakeServer();
  const upstreamError = new GroundlaneError("UPSTREAM_ERROR", "connect", "Server unreachable", true);
  const pipeline = new FetchPipeline(failingHttpFetcher(upstreamError), new DisabledBrowserBackend());
  await createMcpRegistry([
    createParseModule({
      pipeline,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("parse");
  assert.ok(handler);
  const result = await handler(
    {
      url: "https://example.com",
      render: "never",
      purpose: "all",
    },
    {},
  );
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    error?: { code?: string; stage?: string; retryable?: boolean };
  };

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "UPSTREAM_ERROR");
  assert.equal(envelope.error?.retryable, true);
});

void test("parse returns error envelope when upstream throws generic error", async () => {
  const { handlers, server } = fakeServer();
  const pipeline = new FetchPipeline(
    failingHttpFetcher(new Error("DNS resolution failed")),
    new DisabledBrowserBackend(),
  );
  await createMcpRegistry([
    createParseModule({
      pipeline,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("parse");
  assert.ok(handler);
  const result = await handler(
    {
      url: "https://example.com",
      render: "never",
      purpose: "all",
    },
    {},
  );
  const envelope = (result as { structuredContent?: unknown; isError?: boolean }).structuredContent as {
    ok?: boolean;
    error?: { code?: string };
  };

  assert.equal(envelope.ok, false);
  assert.ok(envelope.error?.code);
});

// --- parse with raw HTML (no upstream, success control case) ---

void test("parse succeeds with raw html input (no upstream fetch needed)", async () => {
  const { handlers, server } = fakeServer();
  const pipeline = new FetchPipeline(successHttpFetcher(), new DisabledBrowserBackend());
  await createMcpRegistry([
    createParseModule({
      pipeline,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("parse");
  assert.ok(handler);
  const result = await handler(
    {
      html: "<html><head><title>Inline</title></head><body><p>Content here</p></body></html>",
      baseUrl: "https://example.com",
      purpose: "document",
    },
    {},
  );
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: { title?: string; truncated?: boolean };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.title, "Inline");
  assert.equal(envelope.data?.truncated, false);
});
