import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import { RemoteDocumentCacheRuntime } from "../../src/container/remote-document-cache.js";
import type { DocumentCacheIdentity } from "../../src/core/document-cache-contract.js";
import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import { FakeClock } from "../../src/worker/managed-tokens.js";

const subtle: TimingSafeSubtleCrypto = {
  digest: (algorithm, data) => crypto.subtle.digest(algorithm, data),
  timingSafeEqual: (left, right) => timingSafeEqual(
    left instanceof ArrayBuffer
      ? Buffer.from(left)
      : Buffer.from(left.buffer, left.byteOffset, left.byteLength),
    right instanceof ArrayBuffer
      ? Buffer.from(right)
      : Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  ),
};
const identity: DocumentCacheIdentity = {
  mode: "use",
  key: {
    ownershipScope: "owner",
    contentHash: "sha256-content",
    engineId: "groundlane",
    engineVersion: "2",
    modelId: "none",
    modelVersion: "none",
    normalizedOptions: "{}",
    schemaVersion: "1",
    policyVersion: "1",
  },
  sourceIdentity: "source-a",
  sourceVersion: "sha256-content",
  ownershipScope: "owner",
  nowMs: 1_800_000_000_000,
};
const config = { enabled: true, defaultTtlSeconds: 86_400 };
const provenance = { isOriginal: true, originalCost: 0, engine: "groundlane", model: "none" } as const;

void test("remote cache revoke bounds ownership and fails closed on unavailable storage", async () => {
  const clock = new FakeClock(1_800_000_000_000);
  let calls = 0;
  const cache = runtime(clock, async (request) => {
    calls++;
    assert.equal(new URL(request.url).pathname, "/v1/revoke");
    const body: unknown = await request.json();
    assert.deepEqual(body, { version: 1, operation: "revoke", sourceIdentity: "source-a", deadlineAt: clock.now() + 30_000 });
    return Response.json({ version: 1, ok: true, result: "revoked" });
  });
  assert.equal(await cache.revokeAllSourceBindings({ sourceIdentity: "source-a", ownershipScope: "owner", nowMs: clock.now() }), "revoked");
  await assert.rejects(cache.revokeAllSourceBindings({ sourceIdentity: "source-a", ownershipScope: "other", nowMs: clock.now() }));
  assert.equal(calls, 1);
  const failing = runtime(clock, () => Promise.resolve(Response.json({ ok: false }, { status: 503 })));
  await assert.rejects(failing.revokeAllSourceBindings({ sourceIdentity: "source-a", ownershipScope: "owner", nowMs: clock.now() }));
});

function runtime(
  clock: FakeClock,
  fetchRequest: (request: Request) => Promise<Response>,
): RemoteDocumentCacheRuntime<{ blocks: unknown[] }> {
  return new RemoteDocumentCacheRuntime({
    signingSecret: "cache-bridge-secret-0123456789",
    principal: { principalId: "owner", authMethod: "managed_token", scopes: ["mcp"] },
    credentialBinding: "credential-a",
    subtle,
    clock,
    fetch: fetchRequest,
    requestId: () => "remote-cache-1",
    validateData: (value): value is { blocks: unknown[] } =>
      typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "blocks")),
  });
}

void test("remote document cache transports lookup and commit without execution callbacks", async () => {
  const clock = new FakeClock(1_800_000_000_000);
  const seen: unknown[] = [];
  const cache = runtime(clock, async (request) => {
    const body: unknown = JSON.parse(await request.text()) as unknown;
    seen.push(body);
    const operation = typeof body === "object" && body !== null && "operation" in body
      ? body.operation
      : undefined;
    return Response.json(operation === "lookup"
      ? { version: 1, ok: true, result: { cached: false, disposition: "ordinary", commitFence: { bindingRevision: null } } }
      : { version: 1, ok: true, result: { cached: false, data: { blocks: [] }, provenance, stored: true, createdAt: clock.now(), expiresAt: clock.now() + 60_000 } });
  });
  const context = { deadlineAt: clock.now() + 10_000 };
  const miss = await cache.lookup(config, identity, context);
  assert.equal(miss.cached, false);
  if (miss.cached) assert.fail("expected miss");
  const committed = await cache.commit(config, identity, { data: { blocks: [] }, provenance }, miss, context);
  assert.equal(committed.stored, true);
  assert.equal(seen.length, 2);
  assert.equal(Object.hasOwn(seen[0] as object, "execute"), false);
  assert.equal(Object.hasOwn(seen[0] as object, "operatorMaxTtlSeconds"), false);
});

void test("remote document cache fails open with sanitized errors and never returns malformed hits", async () => {
  const clock = new FakeClock(1_800_000_000_000);
  const cache = runtime(clock, () => Promise.resolve(Response.json({
    version: 1,
    ok: true,
    result: {
      cached: true,
      data: { secret: "provider payload" },
      hit: { cached: true, createdAt: 1, expiresAt: 2, ageSeconds: 0, sourceHash: "x", engineVersion: "2", modelVersion: "none", billingProvenance: provenance },
    },
  })));
  const miss = await cache.lookup(config, identity, { deadlineAt: clock.now() + 10_000 });
  assert.deepEqual(miss, { cached: false, disposition: "ordinary", cacheError: "Document cache unavailable" });
  if (miss.cached) assert.fail("expected miss");
  const fresh = { data: { blocks: [] }, provenance };
  assert.deepEqual(await cache.commit(config, identity, fresh, miss), {
    cached: false,
    data: fresh.data,
    provenance,
    stored: false,
    cacheError: "Document cache unavailable",
  });
});

void test("remote document cache preserves cancellation and the absolute deadline", async () => {
  const clock = new FakeClock(1_800_000_000_000);
  const controller = new AbortController();
  controller.abort(new Error("caller disconnected"));
  const cache = runtime(clock, () => Promise.resolve(assert.fail("fetch must not run")));
  await assert.rejects(cache.lookup(config, identity, {
    signal: controller.signal,
    deadlineAt: clock.now() + 10_000,
  }), /caller disconnected/u);
  await assert.rejects(cache.lookup(config, identity, {
    deadlineAt: clock.now(),
  }), /deadline was exceeded/u);
});
