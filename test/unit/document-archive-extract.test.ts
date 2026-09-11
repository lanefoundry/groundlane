import assert from "node:assert/strict";
import test from "node:test";

import { zipSync } from "fflate";

import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createDocumentArchiveExtractModule } from "../../src/tools/document-archive-extract.js";

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

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

async function setupHandler() {
  const { handlers, server } = fakeServer();
  await createMcpRegistry([
    createDocumentArchiveExtractModule({
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
      maxOutputChars: 50_000,
    }),
  ]).registerAll(server as never);
  return handlers.get("document_archive_extract")!;
}

function uint8ToBase64(arr: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]!);
  return btoa(binary);
}

void test("document_archive_extract rejects invalid base64", async () => {
  const handler = await setupHandler();
  const result = await handler(
    { dataBase64: "!!!not-base64!!!", filename: "test.zip" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});

void test("document_archive_extract rejects malformed ZIP data", async () => {
  const handler = await setupHandler();
  const result = await handler(
    { dataBase64: btoa("this is not a zip file"), filename: "test.zip" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
});

void test("document_archive_extract successfully extracts a simple ZIP with text files", async () => {
  const handler = await setupHandler();
  const zip = zipSync({
    "hello.txt": bytes("Hello Groundlane"),
    "data.json": bytes('{"key": "value"}'),
    "nested/readme.md": bytes("# README"),
  });
  const result = await handler(
    { dataBase64: uint8ToBase64(zip), filename: "test.zip" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.ok(env.data);
  assert.equal(env.data.totalFiles, 3);
  assert.ok((env.data.parsedFiles as number) >= 1);
  assert.equal(env.data.engine, "groundlane-archive-extract-v1");
});

void test("document_archive_extract lists but skips unsupported file types", async () => {
  const handler = await setupHandler();
  const zip = zipSync({
    "hello.txt": bytes("Hello"),
    "image.bmp": bytes("fake bmp bytes"),
  });
  const result = await handler(
    { dataBase64: uint8ToBase64(zip), filename: "test.zip" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  const files = env.data?.files as Array<{ path: string; parsed: boolean }>;
  assert.ok(files);
  const txtFile = files.find((f) => f.path === "hello.txt");
  assert.ok(txtFile?.parsed);
});
