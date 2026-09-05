import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import { createContainerApp } from "../../src/container/app.js";
import { createMcpRegistry, type McpRequestContext } from "../../src/mcp/registry.js";
import { mintInternalContext } from "../../src/worker/internal-context.js";
import { FakeClock } from "../../src/worker/managed-tokens.js";

const signingSecret = "internal-signing-secret-that-is-long-enough";

const subtle = {
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
    return crypto.subtle.digest(algorithm, data);
  },
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean {
    const leftBytes = left instanceof ArrayBuffer
      ? new Uint8Array(left)
      : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = right instanceof ArrayBuffer
      ? new Uint8Array(right)
      : new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return timingSafeEqual(leftBytes, rightBytes);
  },
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  return address.port;
}

void test("container listener accepts Worker signed context without a raw bearer", async () => {
  const clock = new FakeClock(1_000_000);
  const requestId = "req-container-internal-auth";
  const token = await mintInternalContext(
    {
      signingSecret,
      audience: "groundlane-mcp-v2",
      method: "POST",
      path: "/mcp",
      requestId,
      principal: { principalId: "owner", authMethod: "static_bearer", scopes: ["mcp"] },
      credentialBinding: "static:legacy",
    },
    subtle,
    clock,
  );
  let observedContext: McpRequestContext | undefined;
  const app = createContainerApp({
    authToken: "stale-container-static-token-that-must-not-be-used",
    authMode: "worker_internal_context",
    internalSigningSecret: signingSecret,
    expectedAudience: "groundlane-mcp-v2",
    clock,
    registryFactory(context) {
      observedContext = context;
      return createMcpRegistry();
    },
  });
  const server = createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-groundlane-internal-context": token,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "internal-auth-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(observedContext?.principal.authMethod, "static_bearer");
    assert.equal(observedContext?.credentialBinding, "static:legacy");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
