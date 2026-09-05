import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { createGroundlaneServices } from "../../src/composition.js";
import { parseConfig } from "../../src/config.js";
import { createContainerApp } from "../../src/container/app.js";

const authToken = "document-cache-integration-auth-token";
const textBytes = Buffer.from("Groundlane durable document cache", "utf8");

const resultSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    cached: z.boolean(),
    cache: z.object({
      requestedMode: z.enum(["use", "refresh", "bypass"]),
      enabled: z.boolean(),
      stored: z.boolean(),
      createdAt: z.number().int().optional(),
      expiresAt: z.number().int().optional(),
    }).passthrough(),
    envelope: z.object({
      sourceIdentity: z.object({ filename: z.string().optional() }).passthrough(),
    }).passthrough(),
  }).passthrough(),
});

const policySchema = z.object({
  ok: z.literal(true),
  data: z.object({
    cache: z.object({
      defaultTtlSeconds: z.number().int(),
      maxTtlSeconds: z.number().int(),
    }).passthrough(),
    runtime: z.object({
      cacheEnabled: z.literal(true),
      cacheDefaultMode: z.literal("use"),
      uploadAvailable: z.literal(false),
      artifactSourceAvailable: z.literal(false),
      durableAsyncJobsAvailable: z.literal(false),
      durableCorporaAvailable: z.literal(false),
    }).passthrough(),
  }).passthrough(),
});

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string() }).passthrough(),
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function startServer(cachePath: string): Promise<{
  readonly call: (
    filename: string,
    cacheMode?: "use" | "refresh" | "bypass",
    content?: Buffer,
  ) => Promise<z.infer<typeof resultSchema>>;
  readonly policy: () => Promise<z.infer<typeof policySchema>>;
  readonly invalidTtl: () => Promise<z.infer<typeof errorSchema>>;
  readonly close: () => Promise<void>;
}> {
  const config = parseConfig({
    GROUNDLANE_AUTH_TOKEN: authToken,
    DOCUMENT_CACHE_STATE_PATH: cachePath,
    REQUEST_TIMEOUT_MS: "5000",
    MAX_RESPONSE_BYTES: "200000",
    MAX_OUTPUT_CHARS: "200000",
    MAX_CONCURRENCY: "2",
    MAX_QUEUE: "2",
    DOCUMENT_CACHE_DEFAULT_TTL_SECONDS: "600",
    DOCUMENT_CACHE_MAX_TTL_SECONDS: "3600",
  });
  const services = createGroundlaneServices(config);
  const app = createContainerApp({
    authToken,
    registryFactory: services.registryFactory,
  });
  const server = createServer(app);
  const port = await listen(server);
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(port)}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${authToken}` } } },
  );
  const client = new Client({ name: "document-cache-integration", version: "1.0.0" });
  await client.connect(transport as Transport);

  return {
    call: async (
      filename,
      cacheMode: "use" | "refresh" | "bypass" = "use",
      content = textBytes,
    ) => {
      const result = await client.callTool({
        name: "document_parse",
        arguments: {
          source: {
            kind: "inline",
            dataBase64: content.toString("base64"),
            mimeType: "text/plain",
            filename,
          },
          output: "text",
          cacheMode,
        },
      });
      return resultSchema.parse(result.structuredContent);
    },
    policy: async () => {
      const result = await client.callTool({ name: "document_policy", arguments: {} });
      return policySchema.parse(result.structuredContent);
    },
    invalidTtl: async () => {
      const result = await client.callTool({
        name: "document_parse",
        arguments: {
          source: {
            kind: "inline",
            dataBase64: textBytes.toString("base64"),
            mimeType: "text/plain",
            filename: "invalid-ttl.txt",
          },
          cacheTtlSeconds: 3_601,
        },
      });
      return errorSchema.parse(result.structuredContent);
    },
    close: async () => {
      await client.close();
      await closeServer(server);
      await services.close();
    },
  };
}

void test("document_parse MCP cache survives restart and rebinds identical content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-parse-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, "cache.sqlite");

  const firstServer = await startServer(cachePath);
  const policy = await firstServer.policy();
  assert.equal(policy.data.runtime.cacheEnabled, true);
  assert.equal(policy.data.cache.defaultTtlSeconds, 600);
  assert.equal(policy.data.cache.maxTtlSeconds, 3_600);
  assert.equal((await firstServer.invalidTtl()).error.code, "INVALID_INPUT");
  const miss = await firstServer.call("first.txt");
  assert.equal(miss.data.cached, false);
  assert.equal(miss.data.cache.requestedMode, "use");
  assert.equal(miss.data.cache.enabled, true);
  assert.equal(miss.data.cache.stored, true);
  assert.equal(typeof miss.data.cache.createdAt, "number");
  assert.equal(typeof miss.data.cache.expiresAt, "number");
  assert.equal(
    (miss.data.cache.expiresAt ?? 0) - (miss.data.cache.createdAt ?? 0),
    600_000,
  );

  const rebound = await firstServer.call("second.txt");
  assert.equal(rebound.data.cached, true);
  assert.equal(rebound.data.envelope.sourceIdentity.filename, "second.txt");

  const refreshed = await firstServer.call("second.txt", "refresh");
  assert.equal(refreshed.data.cached, false);
  assert.equal(refreshed.data.cache.stored, true);
  const bypassed = await firstServer.call("second.txt", "bypass");
  assert.equal(bypassed.data.cached, false);
  assert.equal(bypassed.data.cache.stored, false);
  const largeContent = Buffer.from("x".repeat(80_000), "utf8");
  const largeMiss = await firstServer.call("large.txt", "use", largeContent);
  assert.equal(largeMiss.data.cached, false);
  assert.equal(largeMiss.data.cache.stored, true);
  await firstServer.close();

  const restartedServer = await startServer(cachePath);
  t.after(() => restartedServer.close());
  const afterRestart = await restartedServer.call("first.txt");
  assert.equal(afterRestart.data.cached, true);
  assert.equal(afterRestart.data.envelope.sourceIdentity.filename, "first.txt");

  const largeHit = await restartedServer.call("large.txt", "use", largeContent);
  assert.equal(largeHit.data.cached, true);
});
