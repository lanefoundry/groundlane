import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import { createContainerApp } from "../../src/container/app.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { MCP_MODERN_PROTOCOL_VERSION } from "../../src/mcp/server.js";
import {
  createDocumentUploadModule,
  type DocumentUploadRuntimePort,
} from "../../src/tools/document-upload.js";

const TOKEN = "upload-parity-token-that-is-long-enough";

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

function parseLegacy(body: string): Record<string, unknown> {
  const line = body.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (line === undefined) throw new Error("legacy response has no SSE data line");
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

void test("PRD 608: legacy and modern MCP calls share the protocol-neutral upload runtime", async () => {
  const observed: Array<Record<string, unknown>> = [];
  const runtime: DocumentUploadRuntimePort = {
    create(input, caller) {
      observed.push({ operation: "create", input, caller });
      return Promise.resolve({
        uploadIntentId: "upl_shared_intent",
        upload: {
          method: "PUT",
          url: "https://example.invalid/upload",
          headers: { "content-type": input.declaredMime },
        },
        expiresAt: 2_000_000_000_000,
        maxBytes: input.declaredSize,
        multipart: false,
      });
    },
    complete(input, caller) {
      observed.push({ operation: "complete", input, caller });
      if (input.uploadIntentId === "upl_error") {
        return Promise.reject(new GroundlaneError(
          "INVALID_INPUT",
          "document_upload",
          "Unknown or unavailable upload intent",
        ));
      }
      return Promise.resolve({
        refId: "art_shared_ref",
        artifactKind: "source",
        contentHash: `sha256-${"a".repeat(64)}`,
        byteSize: 14,
        createdAt: 1_999_999_900_000,
        expiresAt: 2_000_000_000_000,
        verified: true,
      });
    },
    delete(input, caller) {
      observed.push({ operation: "delete", input, caller });
      return Promise.resolve({ refId: input.refId, deleted: true as const });
    },
  };
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "dual",
    registryFactory: (context) => createMcpRegistry([createDocumentUploadModule({
      caller: {
        ownerId: context?.principal.principalId ?? "missing",
        credentialBinding: context?.credentialBinding ?? "missing",
      },
      runtime,
    })]),
  });
  const server = createServer(app);
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;
  const argumentsValue = {
    declaredMime: "text/plain",
    declaredSize: 14,
    filename: "shared.txt",
    idempotencyKey: "same-semantic-request",
  };
  const request = (id: number, name = "document_upload_create", args: Record<string, unknown> = argumentsValue): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  async function sendLegacy(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return parseLegacy(await response.text());
  }

  async function sendModern(body: Record<string, unknown>, name: string): Promise<Record<string, unknown>> {
    const params = body.params as Record<string, unknown>;
    params._meta = {
      [PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
      [CLIENT_INFO_META_KEY]: { name: "upload-parity", version: "1.0.0" },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const value: unknown = await response.json();
    assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
  }

  function structured(response: Record<string, unknown>): unknown {
    const result = response.result as Record<string, unknown>;
    return result.structuredContent;
  }

  try {
    const legacyCreate = await sendLegacy(request(1));
    const modernCreate = await sendModern(request(2), "document_upload_create");
    assert.deepEqual(structured(modernCreate), structured(legacyCreate));

    const completeArgs = { uploadIntentId: "upl_shared_intent" };
    const legacyComplete = await sendLegacy(request(3, "document_upload_complete", completeArgs));
    const modernComplete = await sendModern(request(4, "document_upload_complete", completeArgs), "document_upload_complete");
    assert.deepEqual(structured(modernComplete), structured(legacyComplete));

    const deleteArgs = { refId: "art_shared_ref" };
    const legacyDelete = await sendLegacy(request(5, "document_artifact_delete", deleteArgs));
    const modernDelete = await sendModern(request(6, "document_artifact_delete", deleteArgs), "document_artifact_delete");
    assert.deepEqual(structured(modernDelete), structured(legacyDelete));

    const errorArgs = { uploadIntentId: "upl_error" };
    const legacyError = await sendLegacy(request(7, "document_upload_complete", errorArgs));
    const modernError = await sendModern(request(8, "document_upload_complete", errorArgs), "document_upload_complete");
    assert.deepEqual(structured(modernError), structured(legacyError));
    assert.match(JSON.stringify(structured(modernError)), /Unknown or unavailable upload intent/u);

    assert.equal(observed.length, 8);
    assert.deepEqual(observed[0], observed[1]);
    assert.deepEqual(observed[2], observed[3]);
    assert.deepEqual(observed[4], observed[5]);
    assert.deepEqual(observed[6], observed[7]);
    assert.deepEqual(observed[0]?.caller, {
      ownerId: "owner",
      credentialBinding: "static:legacy",
    });
  } finally {
    await close(server);
  }
});
