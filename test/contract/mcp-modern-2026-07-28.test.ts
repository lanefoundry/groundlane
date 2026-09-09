import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  fromJsonSchema,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { createContainerApp } from "../../src/container/app.js";
import { ConcurrencyLimiter, Deadline, withinDeadline } from "../../src/core/limits.js";
import {
  createMcpRegistry,
  type McpRequestContext,
} from "../../src/mcp/registry.js";
import {
  MCP_MODERN_PROTOCOL_VERSION,
  parseMcpProtocolMode,
} from "../../src/mcp/server.js";
import { structuredToolResult } from "../../src/mcp/results.js";
import { createDocumentPolicyModule } from "../../src/tools/document-policy.js";
import { toolError, withConcurrency } from "../../src/tools/common.js";

const TOKEN = "modern-test-token-that-is-long-enough";
const MODERN_FIXTURE_ROOT = new URL("../fixtures/mcp/2026-07-28/", import.meta.url);

const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
}).strict();

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

function modernRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  clientName = "groundlane-modern-contract",
  clientCapabilities: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: { name: clientName, version: "1.0.0" },
        [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities,
      },
    },
  };
}

void test("MCP 2026-07-28 serves discover and request-scoped tools without initialize or session state", async () => {
  const clientNames: string[] = [];
  const clientCapabilities: unknown[] = [];
  const principalContexts: Array<McpRequestContext | undefined> = [];
  let factoryCalls = 0;
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "dual",
    registryFactory(context) {
      factoryCalls += 1;
      principalContexts.push(context);
      return createMcpRegistry([{
        name: "modern-contract",
        register(server): void {
          server.registerTool(
            "modern_echo",
            {
              description: "Echo a value while observing request-scoped client metadata.",
              inputSchema: z.object({ value: z.string().max(32) }),
              outputSchema: z.object({ value: z.string() }),
            },
            ({ value }) => {
              clientNames.push(server.server.getClientVersion()?.name ?? "missing");
              clientCapabilities.push(server.server.getClientCapabilities());
              return structuredToolResult({ value });
            },
          );
          server.registerTool(
            "rich_json",
            {
              inputSchema: fromJsonSchema<Record<string, unknown>>({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                $defs: { value: { type: "string", minLength: 1 } },
                properties: {
                  kind: { enum: ["text", "count"] },
                  value: { $ref: "#/$defs/value" },
                  count: { type: "integer", minimum: 0 },
                },
                required: ["kind"],
                allOf: [{
                  if: { properties: { kind: { const: "text" } } },
                  then: { required: ["value"] },
                  else: { required: ["count"] },
                }],
                additionalProperties: false,
              }),
              outputSchema: fromJsonSchema<unknown[]>({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "array",
                prefixItems: [{ const: "accepted" }],
                minItems: 1,
                maxItems: 1,
              }),
            },
            () => structuredToolResult(["accepted"]),
          );
          server.registerTool(
            "invalid_output",
            { inputSchema: z.object({}), outputSchema: z.number() },
            () => structuredToolResult("not-a-number"),
          );
          server.registerResource(
            "missing-contract",
            "groundlane://missing",
            { mimeType: "text/plain" },
            (uri) => {
              throw new ResourceNotFoundError(uri.href);
            },
          );
        },
      }]);
    },
  });
  const server = createServer(app);
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;

  async function send(
    body: Record<string, unknown>,
    method: string,
    name?: string,
    headerOverrides: Record<string, string> = {},
  ): Promise<{ response: Response; body: z.infer<typeof rpcResponseSchema> }> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
        "mcp-method": method,
        ...(name === undefined ? {} : { "mcp-name": name }),
        ...headerOverrides,
      },
      body: JSON.stringify(body),
    });
    return { response, body: rpcResponseSchema.parse(await response.json()) };
  }

  try {
    const discover = await send(
      modernRequest(1, "server/discover"),
      "server/discover",
    );
    assert.equal(discover.response.status, 200);
    assert.equal(discover.response.headers.has("mcp-session-id"), false);
    assert.deepEqual(discover.body.result?.supportedVersions, [MCP_MODERN_PROTOCOL_VERSION]);
    assert.equal(discover.body.result?.resultType, "complete");
    assert.equal(discover.body.result?.ttlMs, 0);
    assert.equal(discover.body.result?.cacheScope, "private");

    const listed = await send(modernRequest(2, "tools/list"), "tools/list");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.response.headers.has("mcp-session-id"), false);
    assert.equal(listed.body.result?.ttlMs, 0);
    assert.equal(listed.body.result?.cacheScope, "private");
    const tools = z.array(z.object({ name: z.string() }).passthrough())
      .parse(listed.body.result?.tools);
    assert.deepEqual(tools.map((tool) => tool.name), [
      "modern_echo",
      "rich_json",
      "invalid_output",
    ]);

    const called = await send(
      modernRequest(
        3,
        "tools/call",
        { name: "modern_echo", arguments: { value: "modern" } },
        "client-per-request",
        { extensions: { "io.groundlane/contract-test": {} } },
      ),
      "tools/call",
      "modern_echo",
    );
    assert.equal(called.response.status, 200);
    assert.deepEqual(called.body.result?.structuredContent, { value: "modern" });
    assert.deepEqual(clientNames, ["client-per-request"]);
    assert.deepEqual(clientCapabilities, [{
      extensions: { "io.groundlane/contract-test": {} },
    }]);
    const richList = await send(modernRequest(4, "tools/list"), "tools/list");
    const richTool = z.object({
      name: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
    }).passthrough().parse(
      z.array(z.unknown()).parse(richList.body.result?.tools)
        .find((candidate) =>
          typeof candidate === "object" && candidate !== null &&
          "name" in candidate && candidate.name === "rich_json"
        ),
    );
    assert.equal(richTool.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok("$defs" in richTool.inputSchema);
    assert.ok("allOf" in richTool.inputSchema);
    assert.equal(richTool.outputSchema.type, "array");
    const richSchemaFixture = z.object({
      name: z.literal("rich_json"),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
    }).parse(JSON.parse(
      await readFile(new URL("rich-schema.json", MODERN_FIXTURE_ROOT), "utf8"),
    ) as unknown);
    assert.deepEqual(richTool, richSchemaFixture);

    const richCall = await send(
      modernRequest(5, "tools/call", {
        name: "rich_json",
        arguments: { kind: "text", value: "yes" },
      }),
      "tools/call",
      "rich_json",
    );
    assert.deepEqual(richCall.body.result?.structuredContent, ["accepted"]);
    const invalidInput = await send(
      modernRequest(6, "tools/call", {
        name: "rich_json",
        arguments: { kind: "text" },
      }),
      "tools/call",
      "rich_json",
    );
    assert.equal(invalidInput.body.result?.isError, true);
    const invalidOutput = await send(
      modernRequest(7, "tools/call", { name: "invalid_output", arguments: {} }),
      "tools/call",
      "invalid_output",
    );
    assert.equal(invalidOutput.body.result?.isError, true);

    const missingUri = "groundlane://missing";
    const missingResource = await send(
      modernRequest(8, "resources/read", { uri: missingUri }),
      "resources/read",
      `=?base64?${Buffer.from(missingUri).toString("base64")}?=`,
    );
    assert.equal(missingResource.body.error?.code, -32602);
    assert.deepEqual(missingResource.body.error?.data, { uri: missingUri });

    assert.equal(factoryCalls, 8);
    assert.equal(principalContexts.length, 8);
    for (const context of principalContexts) {
      assert.equal(context?.principal.principalId, "owner");
      assert.equal(context?.credentialBinding, "static:legacy");
    }
  } finally {
    await close(server);
  }
});

void test("MCP 2026-07-28 validates standard routing headers against the body", async () => {
  let factoryCalls = 0;
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "dual",
    registryFactory: () => {
      factoryCalls += 1;
      return createMcpRegistry();
    },
  });
  const server = createServer(app);
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;
  const body = modernRequest(7, "tools/list");

  async function send(
    headers: Record<string, string>,
    includeProtocolVersion = true,
    requestBody: Record<string, unknown> = body,
  ): Promise<z.infer<typeof rpcResponseSchema>> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...(includeProtocolVersion
          ? { "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION }
          : {}),
        ...headers,
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 400);
    return rpcResponseSchema.parse(await response.json());
  }

  try {
    const missingVersion = await send({ "mcp-method": "tools/list" }, false);
    assert.equal(missingVersion.error?.code, -32020);
    assert.match(missingVersion.error?.message ?? "", /MCP-Protocol-Version header is absent/u);

    const missing = await send({});
    assert.equal(missing.error?.code, -32020);
    assert.match(missing.error?.message ?? "", /Mcp-Method header is absent/u);

    const mismatch = await send({ "mcp-method": "resources/list" });
    assert.equal(mismatch.error?.code, -32020);
    assert.match(mismatch.error?.message ?? "", /headers and body disagree/u);

    const versionMismatch = await send({
      "mcp-protocol-version": "2025-11-25",
      "mcp-method": "tools/list",
    });
    assert.equal(versionMismatch.error?.code, -32020);

    const noModernEnvelope = await send(
      { "mcp-method": "tools/list" },
      true,
      { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} },
    );
    // SEP-2575 carve-out: coherent headers with _meta absent is Invalid
    // params, not header/body routing drift.
    assert.equal(noModernEnvelope.error?.code, -32602);
    assert.match(noModernEnvelope.error?.message ?? "", /missing required MCP fields/u);

    const legacyInitialize = await send(
      { "mcp-method": "initialize" },
      true,
      {
        jsonrpc: "2.0",
        id: 9,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-with-modern-header", version: "1" },
        },
      },
    );
    assert.equal(legacyInitialize.error?.code, -32020);

    const unsupportedVersion = "2099-01-01";
    const unsupported = await send(
      {
        "mcp-protocol-version": unsupportedVersion,
        "mcp-method": "tools/list",
      },
      true,
      {
        jsonrpc: "2.0",
        id: 91,
        method: "tools/list",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: unsupportedVersion,
            [CLIENT_INFO_META_KEY]: { name: "unsupported-version", version: "1" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      },
    );
    assert.equal(unsupported.error?.code, ProtocolErrorCode.UnsupportedProtocolVersion);

    const namedBody = modernRequest(10, "tools/call", {
      name: "private-tool-name",
      arguments: {},
    });
    for (const headers of [
      { "mcp-method": "tools/call" },
      { "mcp-method": "tools/call", "mcp-name": "different" },
      { "mcp-method": "tools/call", "mcp-name": "=?base64?invalid!?=" },
    ]) {
      const named = await send(headers, true, namedBody);
      assert.equal(named.error?.code, -32020);
      assert.doesNotMatch(JSON.stringify(named), /private-tool-name/u);
    }
    assert.equal(factoryCalls, 0);
  } finally {
    await close(server);
  }
});

void test("MCP 2026-07-28 closes the request stream into the tool cancellation signal", async () => {
  let markStarted: (() => void) | undefined;
  let markAborted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const limiter = new ConcurrencyLimiter(1, 1);
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "dual",
    registryFactory: () => createMcpRegistry([{
      name: "modern-cancel",
      register(server): void {
        server.registerTool(
          "wait_for_disconnect",
          {
            inputSchema: z.object({}),
            outputSchema: z.object({ cancelled: z.literal(true) }),
          },
          async (_input, context) => {
            return withConcurrency(
              limiter,
              new Deadline(5_000),
              context.mcpReq.signal,
              async () => {
                markStarted?.();
                await new Promise<void>((resolve) => {
                  if (context.mcpReq.signal.aborted) {
                    resolve();
                    return;
                  }
                  context.mcpReq.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                markAborted?.();
                return structuredToolResult({ cancelled: true as const });
              },
            );
          },
        );
      },
    }]),
  });
  const server = createServer(app);
  const port = await listen(server);
  const controller = new AbortController();
  const request = modernRequest(8, "tools/call", {
    name: "wait_for_disconnect",
    arguments: {},
  });
  const pending = fetch(`http://127.0.0.1:${String(port)}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": "wait_for_disconnect",
    },
    body: JSON.stringify(request),
    signal: controller.signal,
  });

  try {
    await started;
    controller.abort(new Error("contract client disconnected"));
    await assert.rejects(pending, /contract client disconnected|aborted/u);
    await aborted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(limiter.active, 0);
    assert.equal(limiter.queued, 0);
  } finally {
    await close(server);
  }
});

void test("modern HTTP requests share limiter capacity, cancel queued work, and preserve deadlines", async () => {
  const limiter = new ConcurrencyLimiter(1, 1);
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "dual",
    registryFactory: () => createMcpRegistry([{
      name: "modern-limit-contract",
      register(server): void {
        server.registerTool(
          "limited_work",
          {
            inputSchema: z.object({
              mode: z.enum(["hold", "fast"]),
              timeoutMs: z.number().int().positive(),
            }),
            outputSchema: z.object({ completed: z.boolean() }),
          },
          async ({ mode, timeoutMs }, context) => {
            const deadline = new Deadline(timeoutMs);
            try {
              return await withConcurrency(limiter, deadline, context.mcpReq.signal, () =>
                withinDeadline(
                  async (signal) => {
                    if (mode === "hold") {
                      await new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else signal.addEventListener("abort", () => resolve(), { once: true });
                      });
                    }
                    return structuredToolResult({ completed: true });
                  },
                  deadline,
                  context.mcpReq.signal,
                  "modern-limit-contract",
                )
              );
            } catch (error) {
              return toolError(error, { tool: "limited_work" });
            }
          },
        );
      },
    }]),
  });
  const server = createServer(app);
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;
  const send = (id: number, mode: "hold" | "fast", timeoutMs: number, signal?: AbortSignal) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "limited_work",
      },
      body: JSON.stringify(modernRequest(id, "tools/call", {
        name: "limited_work",
        arguments: { mode, timeoutMs },
      })),
      ...(signal === undefined ? {} : { signal }),
    });
  const waitFor = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (condition()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("limiter state did not converge");
  };
  const activeController = new AbortController();
  const queuedController = new AbortController();

  try {
    const active = send(20, "hold", 5_000, activeController.signal);
    await waitFor(() => limiter.active === 1);
    const queued = send(21, "hold", 5_000, queuedController.signal);
    await waitFor(() => limiter.queued === 1);

    const rejected = await send(22, "fast", 5_000);
    assert.equal(rejected.status, 200);
    assert.match(await rejected.text(), /CONCURRENCY_LIMIT/u);
    assert.equal(limiter.active, 1);
    assert.equal(limiter.queued, 1);

    queuedController.abort(new Error("queued client disconnected"));
    await assert.rejects(queued, /queued client disconnected|aborted/u);
    await waitFor(() => limiter.queued === 0);

    activeController.abort(new Error("active client disconnected"));
    await assert.rejects(active, /active client disconnected|aborted/u);
    await waitFor(() => limiter.active === 0);

    const deadline = await send(23, "hold", 10);
    assert.equal(deadline.status, 200);
    assert.match(await deadline.text(), /DEADLINE_EXCEEDED/u);
    await waitFor(() => limiter.active === 0 && limiter.queued === 0);

    const recovered = await send(24, "fast", 5_000);
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /"completed":true/u);
  } finally {
    activeController.abort();
    queuedController.abort();
    await close(server);
  }
});

void test("MCP 2026-07-28 resumes an integrity-protected multi-round trip on another instance", async () => {
  const stateSecret = "modern-mrtr-state-secret-0123456789abcdef";
  let policyNow = 1_000_000;
  const registryFactory = (context?: McpRequestContext) => createMcpRegistry([
    createDocumentPolicyModule({
      limiter: new ConcurrencyLimiter(2, 2),
      requestTimeoutMs: 5_000,
      requestState: context?.requestState,
      now: () => policyNow,
    }),
  ]);
  const createApp = (authToken = TOKEN, requestStateSecret = stateSecret) => createContainerApp({
    authToken,
    mcpProtocolMode: "dual",
    mcpRequestStateSecret: requestStateSecret,
    registryFactory,
  });
  const firstServer = createServer(createApp());
  const secondServer = createServer(createApp());
  const otherSecretServer = createServer(createApp(
    TOKEN,
    "other-modern-mrtr-secret-0123456789abcdef",
  ));
  const firstPort = await listen(firstServer);
  const secondPort = await listen(secondServer);
  const otherSecretPort = await listen(otherSecretServer);

  async function sendRaw(
    port: number,
    id: number,
    extraParams: Record<string, unknown> = {},
    options: {
      authToken?: string;
      arguments?: Record<string, unknown>;
      capabilities?: Record<string, unknown>;
    } = {},
  ): Promise<{ status: number; body: z.infer<typeof rpcResponseSchema> }> {
    const request = modernRequest(
      id,
      "tools/call",
      {
        name: "document_policy",
        arguments: options.arguments ?? { interactiveTtlFor: "artifact" },
        ...extraParams,
      },
      "mrtr-client",
      options.capabilities ?? { elicitation: { form: {} } },
    );
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.authToken ?? TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "document_policy",
      },
      body: JSON.stringify(request),
    });
    return {
      status: response.status,
      body: rpcResponseSchema.parse(await response.json()),
    };
  }

  async function send(
    port: number,
    id: number,
    extraParams: Record<string, unknown> = {},
    options: Parameters<typeof sendRaw>[3] = {},
  ): Promise<z.infer<typeof rpcResponseSchema>> {
    const result = await sendRaw(port, id, extraParams, options);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }

  try {
    const first = await send(firstPort, 10);
    assert.equal(first.result?.resultType, "input_required", JSON.stringify(first));
    const requestState = z.string().parse(first.result?.requestState);
    const readableState = Buffer.from(requestState.split(".")[1] ?? "", "base64url")
      .toString("utf8");
    assert.doesNotMatch(readableState, new RegExp(TOKEN, "u"));
    assert.doesNotMatch(readableState, new RegExp(stateSecret, "u"));
    assert.doesNotMatch(readableState, /static:legacy/u);
    const inputRequests = z.record(z.string(), z.unknown()).parse(first.result?.inputRequests);
    assert.ok("ttl" in inputRequests);

    const retryParams = {
      requestState,
      inputResponses: {
        ttl: { action: "accept", content: { relativeTtlSeconds: 600 } },
      },
    };
    const resumed = await send(secondPort, 11, retryParams);
    assert.equal(resumed.result?.resultType, "complete");
    assert.notEqual(resumed.result?.isError, true, JSON.stringify(resumed));
    const structured = z.object({
      ok: z.literal(true),
      data: z.object({
        artifact: z.object({ effectiveExpiresAtMs: z.number() }).passthrough(),
      }).passthrough(),
    }).passthrough().parse(resumed.result?.structuredContent);
    assert.equal(structured.data.artifact.effectiveExpiresAtMs, 1_600_000);

    const resent = await send(firstPort, 12, retryParams);
    assert.deepEqual(resent.result?.structuredContent, resumed.result?.structuredContent);

    const malformed = await send(firstPort, 13, {
      requestState,
      inputResponses: { ttl: { action: "accept", content: { relativeTtlSeconds: "bad" } } },
    });
    assert.equal(malformed.result?.resultType, "input_required");
    const secondRoundState = z.string().parse(malformed.result?.requestState);
    const thirdRound = await send(firstPort, 14, {
      requestState: secondRoundState,
      inputResponses: { ttl: { action: "accept", content: { relativeTtlSeconds: "bad" } } },
    });
    assert.equal(thirdRound.result?.resultType, "input_required");
    const thirdRoundState = z.string().parse(thirdRound.result?.requestState);
    const roundLimit = await send(firstPort, 15, {
      requestState: thirdRoundState,
      inputResponses: { ttl: { action: "accept", content: { relativeTtlSeconds: "bad" } } },
    });
    assert.equal(roundLimit.result?.isError, true);

    const declined = await send(firstPort, 16, {
      requestState,
      inputResponses: { ttl: { action: "decline" } },
    });
    assert.equal(declined.result?.isError, true);
    assert.equal(
      (declined.result?.structuredContent as { error?: { code?: unknown } } | undefined)
        ?.error?.code,
      "CANCELLED",
    );

    const changedArguments = await send(firstPort, 17, retryParams, {
      arguments: { interactiveTtlFor: "cache" },
    });
    assert.equal(changedArguments.result?.isError, true);
    assert.equal(
      (changedArguments.result?.structuredContent as { error?: { code?: unknown } } | undefined)
        ?.error?.code,
      "INVALID_INPUT",
    );

    // Changing the final base64 character can affect only unused padding bits,
    // producing identical decoded bytes. Change the leading character instead.
    const tamperedState = `${requestState.startsWith("A") ? "B" : "A"}${requestState.slice(1)}`;
    const tampered = await sendRaw(firstPort, 18, {
      ...retryParams,
      requestState: tamperedState,
    });
    assert.equal(tampered.body.error?.code, -32602);
    assert.deepEqual(tampered.body.error?.data, { reason: "invalid_request_state" });

    const wrongSecret = await sendRaw(otherSecretPort, 19, retryParams);
    assert.equal(wrongSecret.body.error?.code, -32602);

    const missingCapability = await sendRaw(firstPort, 20, {}, { capabilities: {} });
    assert.equal(missingCapability.body.error?.code, -32021);

    policyNow = 1_300_000;
    const expiredFlow = await send(firstPort, 21, retryParams);
    assert.equal(expiredFlow.result?.isError, true);
    assert.equal(
      (expiredFlow.result?.structuredContent as { error?: { code?: unknown } } | undefined)
        ?.error?.code,
      "INVALID_INPUT",
    );
  } finally {
    await Promise.all([
      close(firstServer),
      close(secondServer),
      close(otherSecretServer),
    ]);
  }
});

void test("MCP request-state secret fails closed when shorter than 32 bytes", () => {
  assert.throws(
    () => createContainerApp({ mcpRequestStateSecret: "too-short" }),
    /at least 32 bytes/u,
  );
});

void test("modern-only mode rejects the explicit legacy compatibility path", async () => {
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "modern-only",
    registryFactory: () => createMcpRegistry(),
  });
  const server = createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-probe", version: "1.0.0" },
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = rpcResponseSchema.parse(await response.json());
    assert.match(body.error?.message ?? "", /Unsupported protocol version/u);
  } finally {
    await close(server);
  }
});

void test("MCP protocol mode parser fails closed on unknown values", () => {
  assert.equal(parseMcpProtocolMode(undefined), "legacy-only");
  assert.equal(parseMcpProtocolMode(""), "legacy-only");
  assert.equal(parseMcpProtocolMode("legacy-only"), "legacy-only");
  assert.equal(parseMcpProtocolMode("dual"), "dual");
  assert.equal(parseMcpProtocolMode("modern-only"), "modern-only");
  assert.throws(
    () => parseMcpProtocolMode("legacy-ish"),
    /must be legacy-only, dual, or modern-only/u,
  );
});

void test("MCP 2026-07-28 maps missing _meta fields to -32602 Invalid params", async () => {
  const app = createContainerApp({
    authToken: TOKEN,
    mcpProtocolMode: "dual",
    registryFactory: () => createMcpRegistry(),
  });
  const server = createServer(app);
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;

  async function send(
    id: number,
    meta: Record<string, unknown> | undefined,
  ): Promise<{ status: number; body: z.infer<typeof rpcResponseSchema> }> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "server/discover",
        params: meta === undefined ? {} : { _meta: meta },
      }),
    });
    return { status: response.status, body: rpcResponseSchema.parse(await response.json()) };
  }

  const fullMeta = {
    [PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: { name: "meta-contract", version: "1.0.0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };

  try {
    const noCapabilities = {
      [PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
      [CLIENT_INFO_META_KEY]: { name: "meta-contract", version: "1.0.0" },
    };
    const missingCapabilities = await send(101, noCapabilities);
    assert.equal(missingCapabilities.status, 400);
    assert.equal(missingCapabilities.body.error?.code, -32602);

    const noVersion = {
      [CLIENT_INFO_META_KEY]: { name: "meta-contract", version: "1.0.0" },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    };
    const missingVersion = await send(102, noVersion);
    assert.equal(missingVersion.status, 400);
    assert.equal(missingVersion.body.error?.code, -32602);

    const control = await send(103, fullMeta);
    assert.equal(control.status, 200);
    assert.ok(control.body.result !== undefined);
  } finally {
    await close(server);
  }
});
