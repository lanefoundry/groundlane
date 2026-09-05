import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";
import { z } from "zod";

import { createContainerApp } from "../../src/container/app.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry, type McpRequestContext } from "../../src/mcp/registry.js";
import { structuredToolResult } from "../../src/mcp/results.js";
import { MCP_MODERN_PROTOCOL_VERSION } from "../../src/mcp/server.js";
import { createDocumentPolicyModule } from "../../src/tools/document-policy.js";
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

void test("modern catalogs are rebuilt and privately scoped for each signed caller context", async () => {
  const clock = new FakeClock(2_000_000);
  const app = createContainerApp({
    authMode: "worker_internal_context",
    internalSigningSecret: signingSecret,
    expectedAudience: "groundlane-mcp-v2",
    clock,
    mcpProtocolMode: "dual",
    registryFactory(context) {
      const toolName = `caller_${context?.principal.authMethod ?? "missing"}`;
      return createMcpRegistry([{
        name: toolName,
        register(server): void {
          server.registerTool(
            toolName,
            {
              inputSchema: z.object({}),
              outputSchema: z.object({ toolName: z.string() }),
            },
            () => structuredToolResult({ toolName }),
          );
        },
      }]);
    },
  });
  const server = createServer(app);
  const port = await listen(server);

  async function listFor(
    authMethod: "static_bearer" | "managed_token" | "oauth",
    credentialBinding: string,
  ): Promise<{ tools: string[]; ttlMs?: unknown; cacheScope?: unknown }> {
    const requestId = `req-${authMethod}`;
    const token = await mintInternalContext(
      {
        signingSecret,
        audience: "groundlane-mcp-v2",
        method: "POST",
        path: "/mcp",
        requestId,
        principal: {
          principalId: "owner",
          authMethod,
          scopes: ["mcp"],
          ...(authMethod === "managed_token" ? { credentialId: "cred-test" } : {}),
          ...(authMethod === "oauth" ? { clientId: "client-test" } : {}),
        },
        credentialBinding,
      },
      subtle,
      clock,
    );
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
        "x-request-id": requestId,
        "x-groundlane-internal-context": token,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: authMethod, version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const payload: unknown = await response.json();
    const parsed = z.object({
      result: z.object({
        tools: z.array(z.object({ name: z.string() }).passthrough()),
        ttlMs: z.unknown().optional(),
        cacheScope: z.unknown().optional(),
      }).passthrough(),
    }).passthrough().parse(payload);
    return {
      tools: parsed.result.tools.map((tool) => tool.name),
      ttlMs: parsed.result.ttlMs,
      cacheScope: parsed.result.cacheScope,
    };
  }

  try {
    const staticCatalog = await listFor("static_bearer", "static:legacy");
    const managedCatalog = await listFor("managed_token", "managed:cred-test");
    const oauthCatalog = await listFor("oauth", "oauth:client-test");
    assert.deepEqual(staticCatalog.tools, ["caller_static_bearer"]);
    assert.deepEqual(managedCatalog.tools, ["caller_managed_token"]);
    assert.deepEqual(oauthCatalog.tools, ["caller_oauth"]);
    for (const catalog of [staticCatalog, managedCatalog, oauthCatalog]) {
      assert.equal(catalog.ttlMs, 0);
      assert.equal(catalog.cacheScope, "private");
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});

void test("modern request state is bound to the signed internal credential", async () => {
  const clock = new FakeClock(3_000_000);
  const app = createContainerApp({
    authMode: "worker_internal_context",
    internalSigningSecret: signingSecret,
    expectedAudience: "groundlane-mcp-v2",
    clock,
    mcpProtocolMode: "dual",
    mcpRequestStateSecret: "request-state-secret-that-is-long-enough-012345",
    registryFactory(context) {
      return createMcpRegistry([
        createDocumentPolicyModule({
          limiter: new ConcurrencyLimiter(2, 2),
          requestTimeoutMs: 5_000,
          requestState: context?.requestState,
          now: () => clock.now(),
        }),
      ]);
    },
  });
  const server = createServer(app);
  const port = await listen(server);

  async function call(
    authMethod: "managed_token" | "oauth",
    credentialBinding: string,
    id: number,
    extraParams: Record<string, unknown> = {},
  ) {
    const requestId = `request-state-${authMethod}-${String(id)}`;
    const token = await mintInternalContext(
      {
        signingSecret,
        audience: "groundlane-mcp-v2",
        method: "POST",
        path: "/mcp",
        requestId,
        principal: {
          principalId: "owner",
          authMethod,
          scopes: ["mcp"],
          ...(authMethod === "managed_token" ? { credentialId: "cred-test" } : {}),
          ...(authMethod === "oauth" ? { clientId: "client-test" } : {}),
        },
        credentialBinding,
      },
      subtle,
      clock,
    );
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "document_policy",
        "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
        "x-request-id": requestId,
        "x-groundlane-internal-context": token,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "document_policy",
          arguments: { interactiveTtlFor: "artifact" },
          ...extraParams,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: authMethod, version: "1" },
            "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
          },
        },
      }),
    });
    return z.object({
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.object({ code: z.number() }).passthrough().optional(),
    }).passthrough().parse(await response.json());
  }

  try {
    const first = await call("managed_token", "managed:cred-test", 1);
    const requestState = z.string().parse(first.result?.requestState);
    const rejected = await call("oauth", "oauth:client-test", 2, {
      requestState,
      inputResponses: {
        ttl: { action: "accept", content: { relativeTtlSeconds: 600 } },
      },
    });
    assert.equal(rejected.error?.code, -32602);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
