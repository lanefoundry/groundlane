import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createDocumentOcrModule } from "../../src/tools/document-ocr.js";

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

function envelope(result: unknown): { ok: boolean; error?: { code: string; message: string } } {
  return (result as { structuredContent: unknown }).structuredContent as {
    ok: boolean;
    error?: { code: string; message: string };
  };
}

async function setupHandler(provider?: unknown) {
  const { handlers, server } = fakeServer();
  await createMcpRegistry([
    createDocumentOcrModule({
      provider: provider as undefined,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
  ]).registerAll(server as never);
  return handlers.get("document_ocr")!;
}

void test("document_ocr returns error envelope when no provider is set", async () => {
  const handler = await setupHandler(undefined);
  const result = await handler(
    { dataBase64: btoa("fake"), mimeType: "image/png", filename: "test.png" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
  assert.equal(typeof env.error.code, "string");
});

void test("document_ocr rejects unsupported MIME type with error envelope", async () => {
  // Pass a truthy non-undefined value so the "not configured" check is skipped
  const fakeProvider = { ocr: () => Promise.resolve({ text: "", pages: [], engine: "mock" }) };
  const handler = await setupHandler(fakeProvider);
  const result = await handler(
    { dataBase64: btoa("data"), mimeType: "video/mp4", filename: "test.mp4" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});

void test("document_ocr rejects invalid base64 with error envelope", async () => {
  const fakeProvider = { ocr: () => Promise.resolve({ text: "", pages: [], engine: "mock" }) };
  const handler = await setupHandler(fakeProvider);
  const result = await handler(
    { dataBase64: "!!!not-base64!!!", mimeType: "image/png", filename: "test.png" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});

void test("document_ocr rejects oversized files with error envelope", async () => {
  const fakeProvider = { ocr: () => Promise.resolve({ text: "", pages: [], engine: "mock" }) };
  const handler = await setupHandler(fakeProvider);
  const bigData = btoa("x".repeat(1_024_001));
  const result = await handler(
    { dataBase64: bigData, mimeType: "image/png", filename: "big.png" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});
