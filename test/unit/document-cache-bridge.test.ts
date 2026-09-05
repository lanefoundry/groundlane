import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import {
  buildDocumentCacheBridgeRequest,
  documentCacheBridgeRequestSchema,
  documentCacheCommitBridgeResponseSchema,
  DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES,
  documentCacheLookupBridgeResponseSchema,
  verifyDocumentCacheBridgeRequest,
} from "../../src/mcp/document-cache-bridge.js";
import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import { FakeClock } from "../../src/worker/managed-tokens.js";

const subtle: TimingSafeSubtleCrypto = {
  digest: (algorithm, data) => crypto.subtle.digest(algorithm, data),
  timingSafeEqual: (left, right) => timingSafeEqual(
    Buffer.from(left instanceof ArrayBuffer ? left : left.buffer, left instanceof ArrayBuffer ? 0 : left.byteOffset, left instanceof ArrayBuffer ? left.byteLength : left.byteLength),
    Buffer.from(right instanceof ArrayBuffer ? right : right.buffer, right instanceof ArrayBuffer ? 0 : right.byteOffset, right instanceof ArrayBuffer ? right.byteLength : right.byteLength),
  ),
};

const secret = "cache-bridge-signing-secret-0123456789";
const principal = { principalId: "owner", authMethod: "managed_token", scopes: ["mcp"] } as const;

void test("document cache bridge binds issuer, route, request, principal, credential, and body", async () => {
  const clock = new FakeClock(1_800_000_000_000);
  const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: "1", operation: "lookup" }));
  const request = await buildDocumentCacheBridgeRequest({
    path: "/v1/lookup",
    body,
    signingSecret: secret,
    requestId: "cache-request-1",
    principal,
    credentialBinding: "managed:credential-a",
    subtle,
    clock,
  });
  const verified = await verifyDocumentCacheBridgeRequest(request.clone(), secret, subtle, clock);
  assert.equal(verified.ok, true);
  if (!verified.ok) assert.fail("bridge request unexpectedly rejected");
  assert.equal(verified.context.iss, "groundlane-container");
  assert.equal(verified.context.principal.principalId, "owner");
  assert.equal(verified.context.credentialBinding, "managed:credential-a");

  const tampered = new Request(request, { body: JSON.stringify({ schemaVersion: "1", operation: "commit" }) });
  assert.deepEqual(
    await verifyDocumentCacheBridgeRequest(tampered, secret, subtle, clock),
    { ok: false, status: 401, code: "invalid_context" },
  );
});

void test("document cache bridge rejects public hosts, wrong routes, expiry, and oversized bodies", async () => {
  const clock = new FakeClock(1_800_000_000_000);
  const body = new TextEncoder().encode("{}");
  const request = await buildDocumentCacheBridgeRequest({
    path: "/v1/commit",
    body,
    signingSecret: secret,
    requestId: "cache-request-2",
    principal,
    credentialBinding: "managed:credential-a",
    subtle,
    clock,
  });
  const publicHost = new Request("http://example.com/v1/commit", request);
  assert.deepEqual(
    await verifyDocumentCacheBridgeRequest(publicHost, secret, subtle, clock),
    { ok: false, status: 400, code: "invalid_request" },
  );
  clock.advance(61_000);
  assert.deepEqual(
    await verifyDocumentCacheBridgeRequest(request.clone(), secret, subtle, clock),
    { ok: false, status: 401, code: "invalid_context" },
  );
  await assert.rejects(
    buildDocumentCacheBridgeRequest({
      path: "/v1/lookup",
      body: new Uint8Array(DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES + 1),
      signingSecret: secret,
      requestId: "cache-request-3",
      principal,
      credentialBinding: "managed:credential-a",
      subtle,
      clock,
    }),
    /outside the supported bounds/u,
  );
});

void test("document cache bridge codecs are versioned, strict, bounded, and exclude operator config", () => {
  const identity = {
    mode: "use",
    key: {
      ownershipScope: "owner",
      contentHash: "sha256-content",
      engineId: "bounded-document",
      engineVersion: "2",
      modelId: "none",
      modelVersion: "none",
      normalizedOptions: "{}",
      schemaVersion: "1",
      policyVersion: "1",
    },
    sourceIdentity: "artifact:abc",
    sourceVersion: "sha256-content",
    ownershipScope: "owner",
    nowMs: 1_800_000_000_000,
    toolName: "document_parse",
    networkPolicyChecked: true,
  } as const;
  const lookup = documentCacheBridgeRequestSchema.parse({
    version: 1,
    operation: "lookup",
    deadlineAt: 1_800_000_030_000,
    identity,
  });
  assert.equal(lookup.operation, "lookup");
  assert.throws(() => documentCacheBridgeRequestSchema.parse({
    ...lookup,
    operatorMaxTtlSeconds: 1,
  }));
  assert.throws(() => documentCacheBridgeRequestSchema.parse({
    ...lookup,
    version: 2,
  }));
  assert.throws(() => documentCacheBridgeRequestSchema.parse({
    ...lookup,
    deadlineAt: Number.MAX_SAFE_INTEGER + 1,
  }));

  const miss = { cached: false, disposition: "ordinary", commitFence: { bindingRevision: null } } as const;
  assert.equal(documentCacheLookupBridgeResponseSchema.parse({
    version: 1,
    ok: true,
    result: miss,
  }).ok, true);
  assert.equal(documentCacheCommitBridgeResponseSchema.parse({
    version: 1,
    ok: false,
    error: { code: "DOCUMENT_CACHE_UNAVAILABLE", retryable: true },
  }).ok, false);
});
