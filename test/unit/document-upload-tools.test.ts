import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/server";

import { GroundlaneError } from "../../src/core/errors.js";
import { createDocumentUploadModule, type DocumentUploadRuntimePort } from "../../src/tools/document-upload.js";

type Handler = (input: Record<string, unknown>, context: { mcpReq: { signal: AbortSignal } }) => Promise<{
  structuredContent?: unknown;
  isError?: boolean;
}>;

function fakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    server: {
      registerTool(name: string, _definition: unknown, handler: Handler): void {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    handlers,
  };
}

const caller = { ownerId: "owner-a", credentialBinding: "managed:credential-a" };
const signal = new AbortController().signal;

void test("shared upload tools pass the authenticated caller only to the protocol-neutral runtime", async () => {
  const calls: Array<{ operation: string; caller: typeof caller }> = [];
  const runtime: DocumentUploadRuntimePort = {
    create(input, actualCaller) {
      calls.push({ operation: `create:${input.filename}`, caller: actualCaller });
      return Promise.resolve({
        uploadIntentId: "upl_123",
        upload: {
          method: "PUT",
          url: "https://upload.example.test/single-use",
          headers: { "content-type": input.declaredMime },
        },
        expiresAt: 1_800_000,
        maxBytes: 1024,
        multipart: false,
      });
    },
    complete(input, actualCaller) {
      calls.push({ operation: `complete:${input.uploadIntentId}`, caller: actualCaller });
      return Promise.resolve({
        refId: "art_123",
        artifactKind: "source",
        contentHash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteSize: 12,
        createdAt: 1_000,
        expiresAt: 2_000,
        verified: true,
      });
    },
    delete(input, actualCaller) {
      calls.push({ operation: `delete:${input.refId}`, caller: actualCaller });
      return Promise.resolve({ refId: input.refId, deleted: true as const });
    },
  };
  const { server, handlers } = fakeServer();
  await createDocumentUploadModule({ runtime, caller }).register(server);

  const created = await handlers.get("document_upload_create")?.({
    declaredMime: "application/pdf",
    declaredSize: 12,
    filename: "source.pdf",
    idempotencyKey: "retry-one",
  }, { mcpReq: { signal } });
  assert.deepEqual(created?.structuredContent, {
    ok: true,
    data: {
      uploadIntentId: "upl_123",
      upload: {
        method: "PUT",
        url: "https://upload.example.test/single-use",
        headers: { "content-type": "application/pdf" },
      },
      expiresAt: 1_800_000,
      maxBytes: 1024,
      multipart: false,
    },
  });
  const completed = await handlers.get("document_upload_complete")?.({
    uploadIntentId: "upl_123",
  }, { mcpReq: { signal } });
  assert.equal((completed?.structuredContent as { ok?: boolean }).ok, true);
  const deleted = await handlers.get("document_artifact_delete")?.({
    refId: "art_123",
  }, { mcpReq: { signal } });
  assert.deepEqual(deleted?.structuredContent, {
    ok: true,
    data: { refId: "art_123", deleted: true },
  });
  assert.deepEqual(calls, [
    { operation: "create:source.pdf", caller },
    { operation: "complete:upl_123", caller },
    { operation: "delete:art_123", caller },
  ]);
});

void test("upload tools preserve stable sanitized runtime errors and fail closed when unavailable", async () => {
  const rejecting: DocumentUploadRuntimePort = {
    create() {
      throw new GroundlaneError("INVALID_INPUT", "document_upload", "Upload TTL is outside deployment bounds", false);
    },
    complete() {
      throw new Error("secret storage payload");
    },
    delete() {
      throw new Error("secret storage payload");
    },
  };
  const { server, handlers } = fakeServer();
  await createDocumentUploadModule({ runtime: rejecting, caller }).register(server);
  const invalid = await handlers.get("document_upload_create")?.({
    declaredMime: "application/pdf",
    declaredSize: 12,
    filename: "source.pdf",
    idempotencyKey: "retry-one",
  }, { mcpReq: { signal } });
  assert.deepEqual(invalid?.structuredContent, {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      stage: "document_upload",
      message: "Upload TTL is outside deployment bounds",
      retryable: false,
    },
  });
  const storage = await handlers.get("document_upload_complete")?.({
    uploadIntentId: "upl_123",
  }, { mcpReq: { signal } });
  assert.equal((storage?.structuredContent as { error?: { message?: string } }).error?.message, "The upstream operation failed");
  assert.doesNotMatch(JSON.stringify(storage?.structuredContent), /secret storage payload/u);

  const absent = fakeServer();
  await createDocumentUploadModule({ caller }).register(absent.server);
  const unavailable = await absent.handlers.get("document_upload_complete")?.({
    uploadIntentId: "upl_123",
  }, { mcpReq: { signal } });
  assert.deepEqual(unavailable?.structuredContent, {
    ok: false,
    error: {
      code: "PROVIDER_UNAVAILABLE",
      stage: "document_upload",
      message: "Document upload is not configured",
      retryable: false,
      hint: {
        code: "document.upload_unavailable",
        text: "Use inline or public URL input, or configure the deployment artifact backend.",
      },
    },
  });
});
