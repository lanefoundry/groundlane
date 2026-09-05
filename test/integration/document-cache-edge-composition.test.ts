import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { createGroundlaneServices } from "../../src/composition.js";
import { parseConfig } from "../../src/config.js";
import { documentCacheBridgeRequestSchema } from "../../src/mcp/document-cache-bridge.js";

const outputSchema = z.object({
  cached: z.boolean(),
  cache: z.object({ stored: z.boolean() }).passthrough(),
}).passthrough();

void test("edge cache configuration composes the Container remote two-phase runtime", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let stored: {
    data: unknown;
    provenance: {
      isOriginal: boolean;
      originalCost: number;
      engine: string;
      model: string;
    };
  } | undefined;
  const operations: string[] = [];
  const sourceExpiries: Array<number | undefined> = [];
  globalThis.fetch = async (requestInfo) => {
    if (!(requestInfo instanceof Request)) assert.fail("expected a bridge Request");
    const decoded = documentCacheBridgeRequestSchema.parse(
      JSON.parse(await requestInfo.clone().text()) as unknown,
    );
    operations.push(decoded.operation);
    assert.notEqual(decoded.operation, "revoke");
    if (decoded.operation === "revoke") throw new Error("unexpected revoke");
    sourceExpiries.push(decoded.identity.sourceExpiresAt);
    if (decoded.operation === "commit") {
      stored = decoded.execution;
      return Response.json({
        version: 1,
        ok: true,
        result: {
          cached: false,
          data: decoded.execution.data,
          provenance: decoded.execution.provenance,
          stored: true,
          createdAt: decoded.identity.nowMs,
          expiresAt: decoded.identity.nowMs + 60_000,
        },
      });
    }
    if (stored === undefined) {
      return Response.json({
        version: 1,
        ok: true,
        result: { cached: false, disposition: "ordinary", commitFence: { bindingRevision: null } },
      });
    }
    return Response.json({
      version: 1,
      ok: true,
      result: {
        cached: true,
        data: stored.data,
        hit: {
          cached: true,
          createdAt: decoded.identity.nowMs,
          expiresAt: decoded.identity.nowMs + 60_000,
          ageSeconds: 0,
          sourceHash: decoded.identity.key.contentHash,
          engineVersion: decoded.identity.key.engineVersion,
          modelVersion: decoded.identity.key.modelVersion,
          billingProvenance: stored.provenance,
        },
      },
    });
  };

  const services = createGroundlaneServices(parseConfig({
    GROUNDLANE_AUTH_TOKEN: "x".repeat(32),
    DOCUMENT_CACHE_EDGE_ENABLED: "true",
    GROUNDLANE_INTERNAL_SIGNING_SECRET: "edge-cache-signing-secret-0123456789",
    REQUEST_TIMEOUT_MS: "5000",
  }));
  t.after(() => services.close());
  const bytes = new TextEncoder().encode("edge cache composition");
  const sourceExpiresAt = Date.now() + 120_000;
  const input = {
    source: { kind: "inline", dataBase64: Buffer.from(bytes).toString("base64"), mimeType: "text/plain", filename: "edge.txt" },
    output: "text",
    maxPages: 100,
    cacheMode: "use",
  } as const;
  const resolved = {
    bytes,
    mimeType: "text/plain",
    filename: "edge.txt",
    sourceIdentity: { contentHash: "sha256-cd8a310ba649e3def2d9678f78a93998316280b3f208e4e6b881bdeef247497a", filename: "edge.txt" },
    cacheBindingIdentity: { kind: "inline", contentHash: "sha256-cd8a310ba649e3def2d9678f78a93998316280b3f208e4e6b881bdeef247497a" },
    sourceExpiresAt,
  } as const;
  const context = {
    principal: { principalId: "owner", authMethod: "managed_token", scopes: ["mcp"] },
    credentialBinding: "managed:credential-a",
  } as const;
  const first = outputSchema.parse(await services.parseResolvedDocument(input, resolved, context, new AbortController().signal));
  const second = outputSchema.parse(await services.parseResolvedDocument(input, resolved, context, new AbortController().signal));
  assert.equal(first.cached, false);
  assert.equal(first.cache.stored, true);
  assert.equal(second.cached, true);
  assert.deepEqual(operations, ["lookup", "commit", "lookup"]);
  assert.deepEqual(sourceExpiries, [sourceExpiresAt, sourceExpiresAt, sourceExpiresAt]);
});
