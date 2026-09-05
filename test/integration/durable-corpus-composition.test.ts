import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createGroundlaneServices } from "../../src/composition.js";
import { parseConfig } from "../../src/config.js";
import { createContainerApp } from "../../src/container/app.js";
import { documentCacheBridgeRequestSchema } from "../../src/mcp/document-cache-bridge.js";

const TOKEN_A = "durable-corpus-composition-token-a";

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

async function open(path: string, token: string, edge = false) {
  const services = createGroundlaneServices(parseConfig({
    GROUNDLANE_AUTH_TOKEN: token,
    CORPUS_STATE_PATH: path,
    DOCUMENT_CACHE_STATE_PATH: path,
    ...(edge ? { DOCUMENT_CACHE_EDGE_ENABLED: "true", GROUNDLANE_INTERNAL_SIGNING_SECRET: "corpus-cache-test-signing-secret-1234" } : {}),
    CORPUS_TENANT_ID: "self-hosted-test",
    CORPUS_MAX_SOURCE_BYTES: "100000",
    REQUEST_TIMEOUT_MS: "5000",
    MAX_OUTPUT_CHARS: "100000",
    MAX_CONCURRENCY: "2",
    MAX_QUEUE: "2",
  }));
  const server = createServer(createContainerApp({
    authToken: token,
    registryFactory: services.registryFactory,
  }));
  const port = await listen(server);
  const client = new Client({ name: "durable-corpus-composition", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(port)}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  ));
  return {
    client,
    close: async () => {
      await client.close();
      await closeServer(server);
      await services.close();
    },
  };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(typeof result.structuredContent === "object" && result.structuredContent !== null);
  return result.structuredContent as Record<string, unknown>;
}

for (const edge of [false, true]) {
void test(`configured composition persists corpus and invalidates ${edge ? "remote" : "local"} document cache`, async (t) => {
  const originalFetch = globalThis.fetch;
  const stored = new Map<string, { data: unknown; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } }>();
  const revoked: string[] = [];
  if (edge) {
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (request, init) => {
      if (!(request instanceof Request) || new URL(request.url).hostname !== "groundlane-cache.internal") return originalFetch(request, init);
      const body = documentCacheBridgeRequestSchema.parse(await request.json());
      if (body.operation === "revoke") {
        revoked.push(body.sourceIdentity);
        stored.delete(body.sourceIdentity);
        return Response.json({ version: 1, ok: true, result: "revoked" });
      }
      if (body.operation === "commit") {
        stored.set(body.identity.sourceIdentity, body.execution);
        return Response.json({ version: 1, ok: true, result: { cached: false, ...body.execution, stored: true } });
      }
      const cached = stored.get(body.identity.sourceIdentity);
      return Response.json({ version: 1, ok: true, result: cached === undefined ? { cached: false, disposition: "ordinary" } : {
        cached: true, data: cached.data, hit: { cached: true, createdAt: Date.now(), expiresAt: Date.now() + 60000,
          ageSeconds: 0, sourceHash: body.identity.key.contentHash, engineVersion: body.identity.key.engineVersion,
          modelVersion: body.identity.key.modelVersion, billingProvenance: cached.provenance },
      } });
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "groundlane-corpus-composition-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "corpus.sqlite");

  const first = await open(path, TOKEN_A, edge);
  let corpusId: string;
  try {
    const policy = structured(await first.client.callTool({ name: "document_policy", arguments: {} }));
    assert.equal(((policy.data as { runtime?: { durableCorporaAvailable?: boolean } }).runtime?.durableCorporaAvailable), true);
    const created = structured(await first.client.callTool({
      name: "corpus_create",
      arguments: { displayName: "Restart corpus" },
    }));
    const createdId = ((created.data as { corpus?: { corpusId?: string } }).corpus?.corpusId);
    assert.ok(createdId);
    corpusId = createdId;
    const enrolled = structured(await first.client.callTool({
      name: "corpus_enroll",
      arguments: {
        corpusId,
        content: "Durable corpus survives a production composition restart.",
        acl: ["mcp"],
        retentionPolicy: "persistent",
        deletionPolicy: "on_owner_delete",
        citationProvenance: "composition-test",
      },
    }));
    assert.equal(enrolled.ok, true);
    const sourceId = (enrolled.data as { enrollment: { sourceId: string } }).enrollment.sourceId;
    const parse = async () => structured(await first.client.callTool({
      name: "document_parse", arguments: { source: { kind: "corpus", corpusId, sourceId } },
    }));
    const initial = await parse();
    assert.equal(initial.ok, true);
    assert.equal((initial.data as { cached: boolean }).cached, false);
    assert.equal(((await parse()).data as { cached: boolean }).cached, true);
    const changed = structured(await first.client.callTool({ name: "corpus_update", arguments: {
      corpusId, sourceId, acl: ["private-role"],
    } }));
    assert.equal(changed.ok, true);
    assert.equal((await parse()).ok, false);
    await first.client.callTool({ name: "corpus_update", arguments: { corpusId, sourceId, acl: ["mcp"] } });
    assert.equal(((await parse()).data as { cached: boolean }).cached, false);
    if (edge) assert.equal(revoked.length, 2);
  } finally {
    await first.close();
  }

  const reopened = await open(path, TOKEN_A, edge);
  try {
    const status = structured(await reopened.client.callTool({
      name: "corpus_status",
      arguments: { corpusId },
    }));
    assert.equal(((status.data as { corpus?: { enrolledCount?: number } }).corpus?.enrolledCount), 1);
    const search = structured(await reopened.client.callTool({
      name: "corpus_search",
      arguments: { corpusId, query: "production restart", maxResults: 5 },
    }));
    assert.equal(((search.data as { results?: unknown[] }).results?.length), 1);
  } finally {
    await reopened.close();
  }
});
}
