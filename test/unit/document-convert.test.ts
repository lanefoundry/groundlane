import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createDocumentConvertModule } from "../../src/tools/document-convert.js";
import type { AnydocLocalConverter } from "../../src/adapters/document/anydoc-local.js";

type RegisteredHandler = (input: Record<string, unknown>, ctx: { mcpReq: { signal?: AbortSignal } }) => unknown;

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

function envelope(result: unknown): { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } {
  return (result as { structuredContent: unknown }).structuredContent as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

function fakeLocalConverter(): AnydocLocalConverter {
  return {
    providerId: "anydoc-local",
    convert: (_bytes: Uint8Array, filename: string) =>
      Promise.resolve({
        markdown: `# Converted from ${filename}`,
        detectedFormat: "doc",
        engine: "anydoc-wasm",
      }),
  };
}

async function setupHandler(options?: { localConverter?: AnydocLocalConverter }) {
  const { handlers, server } = fakeServer();
  await createMcpRegistry([
    createDocumentConvertModule({
      localConverter: options?.localConverter,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
  ]).registerAll(server as never);
  return handlers.get("document_convert")!;
}

void test("document_convert uses local anydoc converter for markdown output", async () => {
  const handler = await setupHandler({ localConverter: fakeLocalConverter() });
  const result = await handler(
    {
      dataBase64: btoa("fake doc content"),
      mimeType: "application/msword",
      filename: "test.doc",
      outputFormat: "markdown",
    },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.ok(env.data);
  assert.equal(env.data.outputFormat, "markdown");
  assert.equal(env.data.engine, "anydoc-wasm");
  assert.ok((env.data.content as string).includes("Converted from test.doc"));
});

void test("document_convert returns error when local converter unavailable for markdown", async () => {
  const handler = await setupHandler();
  const result = await handler(
    {
      dataBase64: btoa("fake doc content"),
      mimeType: "application/msword",
      filename: "test.doc",
      outputFormat: "markdown",
    },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});

void test("document_convert returns error for modern-office without CloudConvert", async () => {
  const handler = await setupHandler({ localConverter: fakeLocalConverter() });
  const result = await handler(
    {
      dataBase64: btoa("fake doc content"),
      mimeType: "application/msword",
      filename: "test.doc",
      outputFormat: "modern-office",
    },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});

void test("document_convert rejects invalid base64", async () => {
  const handler = await setupHandler({ localConverter: fakeLocalConverter() });
  const result = await handler(
    {
      dataBase64: "!!!not-base64!!!",
      mimeType: "application/msword",
      filename: "test.doc",
      outputFormat: "markdown",
    },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});

void test("document_convert rejects oversized files", async () => {
  const handler = await setupHandler({ localConverter: fakeLocalConverter() });
  const bigData = btoa("x".repeat(10 * 1024 * 1024 + 1));
  const result = await handler(
    {
      dataBase64: bigData,
      mimeType: "application/msword",
      filename: "big.doc",
      outputFormat: "markdown",
    },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});
