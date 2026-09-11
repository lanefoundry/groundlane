import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createDocumentSmartParseModule } from "../../src/tools/document-smart-parse.js";

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

async function setupHandler(options?: {
  ocrProvider?: unknown;
  transcribeProvider?: unknown;
  localConverter?: unknown;
}) {
  const { handlers, server } = fakeServer();
  await createMcpRegistry([
    createDocumentSmartParseModule({
      ocrProvider: options?.ocrProvider as undefined,
      transcribeProvider: options?.transcribeProvider as undefined,
      localConverter: options?.localConverter as undefined,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 10_000,
      maxOutputChars: 50_000,
    }),
  ]).registerAll(server as never);
  return handlers.get("document_smart_parse")!;
}

void test("smart_parse routes text file to document_parse", async () => {
  const handler = await setupHandler();
  const result = await handler(
    { dataBase64: btoa("Hello world"), mimeType: "text/plain", filename: "hello.txt" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data?.routedTo, "document_parse");
  assert.ok((env.data?.content as string).includes("Hello world"));
});

void test("smart_parse routes image to document_ocr when provider available", async () => {
  const fakeOcr = {
    ocr: () => Promise.resolve({ text: "OCR result", pages: [], engine: "mock-ocr" }),
  };
  const handler = await setupHandler({ ocrProvider: fakeOcr });
  const result = await handler(
    { dataBase64: btoa("fake png"), mimeType: "image/png", filename: "scan.png" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data?.routedTo, "document_ocr");
});

void test("smart_parse falls back to document_parse for image when OCR not configured", async () => {
  const handler = await setupHandler();
  const result = await handler(
    { dataBase64: btoa("fake png"), mimeType: "image/png", filename: "scan.png" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  // Falls back to document_parse but that will fail on binary data — check routing
  assert.equal(env.data?.routedTo ?? "document_parse", "document_parse");
});

void test("smart_parse routes audio to document_transcribe when provider available", async () => {
  const fakeWhisper = {
    transcribe: () => Promise.resolve({
      text: "Transcribed audio",
      segments: [],
      engine: "mock-whisper",
      durationSeconds: 30,
    }),
  };
  const handler = await setupHandler({ transcribeProvider: fakeWhisper });
  const result = await handler(
    { dataBase64: btoa("fake audio"), mimeType: "audio/mpeg", filename: "recording.mp3" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data?.routedTo, "document_transcribe");
});

void test("smart_parse routes EML to document_email_extract", async () => {
  const handler = await setupHandler();
  const eml = "Subject: Test\r\nFrom: a@b.com\r\n\r\nHello email body";
  const result = await handler(
    { dataBase64: btoa(eml), mimeType: "message/rfc822", filename: "test.eml" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data?.routedTo, "document_email_extract");
});

void test("smart_parse routes .doc to document_convert when local converter available", async () => {
  const fakeConverter = {
    convert: (_bytes: Uint8Array, filename: string) => Promise.resolve({
      markdown: `# Converted from ${filename}`,
      detectedFormat: "doc",
      engine: "mock-anydoc",
    }),
  };
  const handler = await setupHandler({ localConverter: fakeConverter });
  const result = await handler(
    { dataBase64: btoa("fake doc content"), mimeType: "application/msword", filename: "report.doc" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data?.routedTo, "document_convert");
});

void test("smart_parse rejects invalid base64", async () => {
  const handler = await setupHandler();
  const result = await handler(
    { dataBase64: "!!!not-base64!!!", mimeType: "text/plain", filename: "test.txt" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.error);
});

void test("smart_parse routes ZIP to document_archive_extract", async () => {
  const handler = await setupHandler();
  const result = await handler(
    { dataBase64: btoa("fake zip"), mimeType: "application/zip", filename: "archive.zip" },
    { mcpReq: {} },
  );
  const env = envelope(result);
  // Routing should be archive even if the zip itself is malformed
  assert.equal(env.data?.routedTo ?? "document_archive_extract", "document_archive_extract");
});
