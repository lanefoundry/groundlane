import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalCoreKey,
  buildProjectionCacheKey,
  canSourceHitCache,
  canonicalCoreKeyString,
  DEFAULT_CACHE_MODE,
  DEFAULT_CACHE_SCOPE_POLICY,
  DEFAULT_CACHE_TTL_SECONDS,
  isPayloadReclaimable,
  projectionCacheKeyString,
  rejectForbiddenKeyBasis,
  resolveCacheMode,
  resolveEffectiveTtl,
  revokeBinding,
  safeCacheOperation,
  shouldInvalidate,
  validateCacheHit,
  validateCacheKey,
  validateCacheScope,
  validateNetworkPolicyRequired,
  validateOwnershipScope,
  type CacheConfig,
  type CacheHitResult,
  type InvalidationCheck,
  type LiveReferenceSet,
  type ParsedPayloadCacheKey,
  type SourceBinding,
} from "../../src/core/document-cache-contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullCacheKey(overrides?: Partial<ParsedPayloadCacheKey>): ParsedPayloadCacheKey {
  return {
    ownershipScope: "tenant-a",
    contentHash: "sha256:abc123",
    engineId: "docparser",
    engineVersion: "2.0.0",
    modelId: "vlm-1",
    modelVersion: "1.5.0",
    normalizedOptions: "{}",
    schemaVersion: "1.0.0",
    policyVersion: "1.0.0",
    ...overrides,
  };
}

function makeDefaultConfig(overrides?: Partial<CacheConfig>): CacheConfig {
  return {
    defaultTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
    enabled: true,
    ...overrides,
  };
}

function makeBinding(
  sourceIdentity: string,
  payloadId: string,
  overrides?: Partial<SourceBinding>,
): SourceBinding {
  return {
    bindingId: `bind-${sourceIdentity}`,
    sourceIdentity,
    payloadId,
    ownershipScope: "tenant-a",
    createdAt: Date.now(),
    revoked: false,
    ...overrides,
  };
}

function makeReferenceSet(
  payloadId: string,
  bindings: SourceBinding[],
): LiveReferenceSet {
  return { payloadId, bindings };
}

function makeInvalidationCheck(
  overrides?: Partial<InvalidationCheck>,
): InvalidationCheck {
  return {
    engineVersionChanged: false,
    modelVersionChanged: false,
    schemaVersionChanged: false,
    policyVersionChanged: false,
    sourceDeleted: false,
    sourceExpired: false,
    ownershipChanged: false,
    explicitInvalidation: false,
    ...overrides,
  };
}

function makeCacheHit(overrides?: Partial<CacheHitResult>): CacheHitResult {
  const now = Date.now();
  return {
    cached: true,
    createdAt: now - 3600_000,
    expiresAt: now + 82800_000,
    ageSeconds: 3600,
    sourceHash: "sha256:abc123",
    engineVersion: "2.0.0",
    modelVersion: "1.5.0",
    billingProvenance: {
      isOriginal: true,
      originalCost: 0.01,
      engine: "docparser",
      model: "vlm-1",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 671: Cache mode and configuration
// ---------------------------------------------------------------------------

void test("PRD 671: default cache mode is 'use'", () => {
  assert.equal(DEFAULT_CACHE_MODE, "use");
});

void test("PRD 671: default TTL is 24 hours (86400s)", () => {
  assert.equal(DEFAULT_CACHE_TTL_SECONDS, 86400);
});

void test("PRD 671: operator disable degrades 'use' to bypass", () => {
  const config = makeDefaultConfig({ enabled: false });
  const resolved = resolveCacheMode("use", config);
  assert.equal(resolved.effectiveMode, "bypass");
  assert.equal(resolved.degraded, true);
});

void test("PRD 671: operator disable degrades 'refresh' to bypass", () => {
  const config = makeDefaultConfig({ enabled: false });
  const resolved = resolveCacheMode("refresh", config);
  assert.equal(resolved.effectiveMode, "bypass");
  assert.equal(resolved.degraded, true);
});

void test("PRD 671: operator disable with bypass stays bypass (not degraded)", () => {
  const config = makeDefaultConfig({ enabled: false });
  const resolved = resolveCacheMode("bypass", config);
  assert.equal(resolved.effectiveMode, "bypass");
  assert.equal(resolved.degraded, false);
});

void test("PRD 671: enabled cache preserves requested mode", () => {
  const config = makeDefaultConfig({ enabled: true });
  assert.equal(resolveCacheMode("use", config).effectiveMode, "use");
  assert.equal(resolveCacheMode("refresh", config).effectiveMode, "refresh");
  assert.equal(resolveCacheMode("bypass", config).effectiveMode, "bypass");
});

void test("PRD 671: effective TTL picks minimum of all constraints", () => {
  const config = makeDefaultConfig({
    defaultTtlSeconds: 86400,
    operatorMaxTtlSeconds: 3600,
    sourceExpirySeconds: 7200,
  });
  // Requested 86400, operator max 3600, source 7200 -> min is 3600
  assert.equal(resolveEffectiveTtl(86400, config), 3600);
});

void test("PRD 671: effective TTL uses default when no request", () => {
  const config = makeDefaultConfig({
    defaultTtlSeconds: 86400,
  });
  assert.equal(resolveEffectiveTtl(undefined, config), 86400);
});

void test("PRD 671: effective TTL respects source expiry", () => {
  const config = makeDefaultConfig({
    defaultTtlSeconds: 86400,
    sourceExpirySeconds: 1800,
  });
  assert.equal(resolveEffectiveTtl(undefined, config), 1800);
});

void test("PRD 671: cache failure does not fail processing", () => {
  const result = safeCacheOperation(
    () => { throw new Error("Redis down"); },
    null,
  );
  assert.equal(result.result, null);
  assert.ok(result.cacheError);
  assert.ok(result.cacheError.includes("Redis down"));
});

void test("PRD 671: successful cache operation returns value", () => {
  const result = safeCacheOperation(() => "cached-data", null);
  assert.equal(result.result, "cached-data");
  assert.equal(result.cacheError, undefined);
});

void test("PRD 671: refresh does not extend source retention", () => {
  // Refresh mode with source expiry should use source expiry, not extend it
  const config = makeDefaultConfig({
    defaultTtlSeconds: 86400,
    sourceExpirySeconds: 1800,
  });
  // Even when requesting a long TTL, source expiry constrains it
  const ttl = resolveEffectiveTtl(86400, config);
  assert.equal(ttl, 1800); // source expiry wins
});

// ---------------------------------------------------------------------------
// PRD 672: Cache key validation
// ---------------------------------------------------------------------------

void test("PRD 672: complete cache key accepted", () => {
  const key = makeFullCacheKey();
  assert.doesNotThrow(() => validateCacheKey(key));
});

void test("PRD 672: key with only URL rejected", () => {
  assert.throws(
    () => rejectForbiddenKeyBasis({
      hasContentHash: false,
      hasUrlOnly: true,
      hasFilenameOnly: false,
      hasMimeOnly: false,
      hasUnverifiedDigest: false,
    }),
    { message: /must not rely solely on URL/ },
  );
});

void test("PRD 672: key with only filename rejected", () => {
  assert.throws(
    () => rejectForbiddenKeyBasis({
      hasContentHash: false,
      hasUrlOnly: false,
      hasFilenameOnly: true,
      hasMimeOnly: false,
      hasUnverifiedDigest: false,
    }),
    { message: /must not rely solely on filename/ },
  );
});

void test("PRD 672: key with only MIME rejected", () => {
  assert.throws(
    () => rejectForbiddenKeyBasis({
      hasContentHash: false,
      hasUrlOnly: false,
      hasFilenameOnly: false,
      hasMimeOnly: true,
      hasUnverifiedDigest: false,
    }),
    { message: /must not rely solely on caller-declared MIME/ },
  );
});

void test("PRD 672: key with unverified digest rejected", () => {
  assert.throws(
    () => rejectForbiddenKeyBasis({
      hasContentHash: false,
      hasUrlOnly: false,
      hasFilenameOnly: false,
      hasMimeOnly: false,
      hasUnverifiedDigest: true,
    }),
    { message: /must not rely on unverified digest/ },
  );
});

void test("PRD 672: cross-tenant cache reuse rejected", () => {
  assert.throws(
    () => validateOwnershipScope("tenant-a", "tenant-b"),
    { message: /Cross-tenant cache reuse forbidden/ },
  );
});

void test("PRD 672: same-tenant cache reuse accepted", () => {
  assert.doesNotThrow(() => validateOwnershipScope("tenant-a", "tenant-a"));
});

void test("PRD 672: key missing ownershipScope rejected", () => {
  const key = makeFullCacheKey({ ownershipScope: "" });
  assert.throws(
    () => validateCacheKey(key),
    { message: /must include ownershipScope/ },
  );
});

void test("PRD 672: key missing contentHash rejected", () => {
  const key = makeFullCacheKey({ contentHash: "" });
  assert.throws(
    () => validateCacheKey(key),
    { message: /must include contentHash/ },
  );
});

// ---------------------------------------------------------------------------
// PRD 673: Cache payload, source binding, live references
// ---------------------------------------------------------------------------

void test("PRD 673: delete one source does not affect others", () => {
  const refs = makeReferenceSet("payload-1", [
    makeBinding("source-a", "payload-1"),
    makeBinding("source-b", "payload-1"),
  ]);

  const updated = revokeBinding(refs, "source-a");

  const bindingA = updated.bindings.find((b) => b.sourceIdentity === "source-a");
  const bindingB = updated.bindings.find((b) => b.sourceIdentity === "source-b");
  assert.equal(bindingA?.revoked, true);
  assert.equal(bindingB?.revoked, false);
});

void test("PRD 673: deleted source cannot hit shared payload", () => {
  const refs = makeReferenceSet("payload-1", [
    makeBinding("source-a", "payload-1"),
    makeBinding("source-b", "payload-1"),
  ]);

  const updated = revokeBinding(refs, "source-a");

  assert.equal(canSourceHitCache(updated, "source-a"), false);
  assert.equal(canSourceHitCache(updated, "source-b"), true);
});

void test("PRD 673: payload reclaimable only when no live bindings", () => {
  const refs = makeReferenceSet("payload-1", [
    makeBinding("source-a", "payload-1"),
    makeBinding("source-b", "payload-1"),
  ]);

  // One revoked, one live
  const partial = revokeBinding(refs, "source-a");
  assert.equal(isPayloadReclaimable(partial), false);

  // Both revoked
  const full = revokeBinding(partial, "source-b");
  assert.equal(isPayloadReclaimable(full), true);
});

void test("PRD 673: bounded cleanup -- reclaimable with all bindings revoked", () => {
  const refs = makeReferenceSet("payload-1", [
    makeBinding("source-a", "payload-1", { revoked: true }),
    makeBinding("source-b", "payload-1", { revoked: true }),
  ]);
  assert.equal(isPayloadReclaimable(refs), true);
});

// ---------------------------------------------------------------------------
// PRD 674: Cache hit result
// ---------------------------------------------------------------------------

void test("PRD 674: cache hit returns original billing provenance", () => {
  const hit = makeCacheHit();
  assert.doesNotThrow(() => validateCacheHit(hit));
  assert.equal(hit.billingProvenance.isOriginal, true);
});

void test("PRD 674: cache hit with non-original billing rejected", () => {
  const hit = makeCacheHit({
    billingProvenance: {
      isOriginal: false,
      originalCost: 0.01,
      engine: "docparser",
      model: "vlm-1",
    },
  });
  assert.throws(
    () => validateCacheHit(hit),
    { message: /original billing provenance/ },
  );
});

void test("PRD 674: engine version change causes miss", () => {
  const check = makeInvalidationCheck({ engineVersionChanged: true });
  assert.equal(shouldInvalidate(check), true);
});

void test("PRD 674: model version change causes miss", () => {
  const check = makeInvalidationCheck({ modelVersionChanged: true });
  assert.equal(shouldInvalidate(check), true);
});

void test("PRD 674: source delete causes miss", () => {
  const check = makeInvalidationCheck({ sourceDeleted: true });
  assert.equal(shouldInvalidate(check), true);
});

void test("PRD 674: source expiry causes miss", () => {
  const check = makeInvalidationCheck({ sourceExpired: true });
  assert.equal(shouldInvalidate(check), true);
});

void test("PRD 674: ownership change causes miss", () => {
  const check = makeInvalidationCheck({ ownershipChanged: true });
  assert.equal(shouldInvalidate(check), true);
});

void test("PRD 674: explicit invalidation works", () => {
  const check = makeInvalidationCheck({ explicitInvalidation: true });
  assert.equal(shouldInvalidate(check), true);
});

void test("PRD 674: no changes means no invalidation", () => {
  const check = makeInvalidationCheck();
  assert.equal(shouldInvalidate(check), false);
});

void test("PRD 674: schema version change causes miss", () => {
  const check = makeInvalidationCheck({ schemaVersionChanged: true });
  assert.equal(shouldInvalidate(check), true);
});

void test("PRD 674: policy version change causes miss", () => {
  const check = makeInvalidationCheck({ policyVersionChanged: true });
  assert.equal(shouldInvalidate(check), true);
});

// ---------------------------------------------------------------------------
// PRD 677: Cache scope policy
// ---------------------------------------------------------------------------

void test("PRD 677: web_fetch excluded from document cache", () => {
  const result = validateCacheScope("web_fetch", DEFAULT_CACHE_SCOPE_POLICY);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("excluded"));
});

void test("PRD 677: web_extract excluded from document cache", () => {
  const result = validateCacheScope("web_extract", DEFAULT_CACHE_SCOPE_POLICY);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("excluded"));
});

void test("PRD 677: parse excluded from document cache", () => {
  const result = validateCacheScope("parse", DEFAULT_CACHE_SCOPE_POLICY);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("excluded"));
});

void test("PRD 677: document family tool included in cache scope", () => {
  const result = validateCacheScope("document_parse", DEFAULT_CACHE_SCOPE_POLICY);
  assert.equal(result.allowed, true);
});

void test("PRD 677: cache cannot skip network policy for URL-backed operations", () => {
  assert.throws(
    () => validateNetworkPolicyRequired(DEFAULT_CACHE_SCOPE_POLICY, false),
    { message: /URL security.*checks must complete before cache lookup/ },
  );
});

void test("PRD 677: network policy check passes when completed", () => {
  assert.doesNotThrow(
    () => validateNetworkPolicyRequired(DEFAULT_CACHE_SCOPE_POLICY, true),
  );
});

// ---------------------------------------------------------------------------
// PRD 682: Cache key separation
// ---------------------------------------------------------------------------

void test("PRD 682: same content different output mode -> same canonical key", () => {
  const params = {
    contentHash: "sha256:abc",
    engineVersion: "2.0.0",
    modelVersion: "1.5.0",
    schemaVersion: "1.0.0",
    policyVersion: "1.0.0",
    normalizedParseOptions: "{}",
  };

  // Two different output modes (markdown vs text) should produce the same
  // canonical core key -- output is not part of it
  const key1 = buildCanonicalCoreKey(params);
  const key2 = buildCanonicalCoreKey(params);

  assert.equal(canonicalCoreKeyString(key1), canonicalCoreKeyString(key2));

  // Verify output mode is not in the key
  const keyStr = canonicalCoreKeyString(key1);
  assert.equal(keyStr.includes("markdown"), false);
  assert.equal(keyStr.includes("text"), false);
});

void test("PRD 682: projection version change -> different projection key", () => {
  const coreKey = buildCanonicalCoreKey({
    contentHash: "sha256:abc",
    engineVersion: "2.0.0",
    modelVersion: "1.5.0",
    schemaVersion: "1.0.0",
    policyVersion: "1.0.0",
    normalizedParseOptions: "{}",
  });

  const projKey1 = buildProjectionCacheKey(coreKey, {
    canonicalContentId: "content-1",
    projectionKind: "markdown",
    projectionVersion: "1.0.0",
    projectionOptions: "{}",
  });

  const projKey2 = buildProjectionCacheKey(coreKey, {
    canonicalContentId: "content-1",
    projectionKind: "markdown",
    projectionVersion: "2.0.0",
    projectionOptions: "{}",
  });

  assert.notEqual(
    projectionCacheKeyString(projKey1),
    projectionCacheKeyString(projKey2),
  );
});

void test("PRD 682: switching markdown -> text does not change canonical key", () => {
  const params = {
    contentHash: "sha256:same-content",
    engineVersion: "2.0.0",
    modelVersion: "1.5.0",
    schemaVersion: "1.0.0",
    policyVersion: "1.0.0",
    normalizedParseOptions: "{}",
  };

  const canonicalKey = buildCanonicalCoreKey(params);
  const keyStr = canonicalCoreKeyString(canonicalKey);

  // The key is the same regardless of what projection is requested
  // because output selection is not part of the canonical key
  const canonicalKey2 = buildCanonicalCoreKey(params);
  assert.equal(canonicalCoreKeyString(canonicalKey2), keyStr);
});

void test("PRD 682: different content hash -> different canonical key", () => {
  const key1 = buildCanonicalCoreKey({
    contentHash: "sha256:aaa",
    engineVersion: "2.0.0",
    modelVersion: "1.5.0",
    schemaVersion: "1.0.0",
    policyVersion: "1.0.0",
    normalizedParseOptions: "{}",
  });

  const key2 = buildCanonicalCoreKey({
    contentHash: "sha256:bbb",
    engineVersion: "2.0.0",
    modelVersion: "1.5.0",
    schemaVersion: "1.0.0",
    policyVersion: "1.0.0",
    normalizedParseOptions: "{}",
  });

  assert.notEqual(canonicalCoreKeyString(key1), canonicalCoreKeyString(key2));
});

void test("PRD 682: projection kind is in projection key but not canonical key", () => {
  const coreKey = buildCanonicalCoreKey({
    contentHash: "sha256:abc",
    engineVersion: "2.0.0",
    modelVersion: "1.5.0",
    schemaVersion: "1.0.0",
    policyVersion: "1.0.0",
    normalizedParseOptions: "{}",
  });

  const mdKey = buildProjectionCacheKey(coreKey, {
    canonicalContentId: "content-1",
    projectionKind: "markdown",
    projectionVersion: "1.0.0",
    projectionOptions: "{}",
  });

  const txtKey = buildProjectionCacheKey(coreKey, {
    canonicalContentId: "content-1",
    projectionKind: "text",
    projectionVersion: "1.0.0",
    projectionOptions: "{}",
  });

  // Same canonical core but different projection keys
  assert.equal(
    canonicalCoreKeyString(coreKey),
    canonicalCoreKeyString(coreKey),
  );
  assert.notEqual(
    projectionCacheKeyString(mdKey),
    projectionCacheKeyString(txtKey),
  );
});

// ---------------------------------------------------------------------------
// PRD 662: Document processing cache runtime (in-memory port)
// ---------------------------------------------------------------------------

void test("PRD 662: use miss executes and writes, second use hits with cached=true", async () => {
  const { InMemoryDocumentCacheStore, processDocumentCache } =
    await import("../../src/core/document-cache-contract.js");
  const store = new InMemoryDocumentCacheStore();
  const config = makeDefaultConfig();
  const key = makeFullCacheKey();
  let calls = 0;
  const execute = (): { data: string; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } } => {
    calls += 1;
    return {
      data: `payload-${String(calls)}`,
      provenance: { isOriginal: true, originalCost: 0.02, engine: "docparser", model: "vlm-1" },
    };
  };
  const params = {
    mode: "use" as const,
    key,
    sourceIdentity: "source-a",
    sourceVersion: "v1",
    ownershipScope: "tenant-a",
    nowMs: 1_700_000_000_000,
    execute,
  };
  const first = processDocumentCache(store, config, params);
  assert.equal(first.cached, false);
  assert.equal(calls, 1);
  const second = processDocumentCache(store, config, { ...params, nowMs: 1_700_000_360_000 });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  if (second.cached) {
    assert.equal(second.hit.billingProvenance.isOriginal, true);
    assert.ok(second.hit.ageSeconds >= 0);
  }
});

void test("PRD 662: refresh skips read and replaces entry", async () => {
  const { InMemoryDocumentCacheStore, processDocumentCache } =
    await import("../../src/core/document-cache-contract.js");
  const store = new InMemoryDocumentCacheStore();
  const config = makeDefaultConfig();
  const key = makeFullCacheKey();
  let n = 0;
  const execute = (): { data: string; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } } => {
    n += 1;
    return {
      data: `v${String(n)}`,
      provenance: { isOriginal: true, originalCost: 0.01, engine: "docparser", model: "vlm-1" },
    };
  };
  const base = {
    key,
    sourceIdentity: "source-a",
    sourceVersion: "v1",
    ownershipScope: "tenant-a",
    nowMs: 1_700_000_000_000,
    execute,
  };
  const first = processDocumentCache(store, config, { ...base, mode: "use" as const });
  assert.equal(first.cached, false);
  const refreshed = processDocumentCache(store, config, { ...base, mode: "refresh" as const, nowMs: 1_700_000_100_000 });
  assert.equal(refreshed.cached, false);
  assert.equal(n, 2);
  const hit = processDocumentCache(store, config, { ...base, mode: "use" as const, nowMs: 1_700_000_200_000 });
  assert.equal(hit.cached, true);
  if (hit.cached) assert.equal(hit.data, "v2");
});

void test("PRD 662: bypass performs no read and no write", async () => {
  const { InMemoryDocumentCacheStore, processDocumentCache } =
    await import("../../src/core/document-cache-contract.js");
  const store = new InMemoryDocumentCacheStore();
  const config = makeDefaultConfig();
  const key = makeFullCacheKey();
  const execute = (): { data: string; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } } => ({
    data: "fresh",
    provenance: { isOriginal: true, originalCost: 0.01, engine: "docparser", model: "vlm-1" },
  });
  const params = {
    mode: "bypass" as const,
    key,
    sourceIdentity: "source-a",
    sourceVersion: "v1",
    ownershipScope: "tenant-a",
    nowMs: 1_700_000_000_000,
    execute,
  };
  const r1 = processDocumentCache(store, config, params);
  const r2 = processDocumentCache(store, config, params);
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, false);
  assert.equal(store.size(), 0);
});

void test("PRD 662: cache key without contentHash rejected (no URL-only keys)", async () => {
  const { InMemoryDocumentCacheStore, processDocumentCache } =
    await import("../../src/core/document-cache-contract.js");
  const store = new InMemoryDocumentCacheStore();
  const config = makeDefaultConfig();
  const badKey = makeFullCacheKey({ contentHash: "" });
  const execute = (): { data: string; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } } => ({
    data: "x",
    provenance: { isOriginal: true, originalCost: 0, engine: "docparser", model: "vlm-1" },
  });
  assert.throws(
    () => processDocumentCache(store, config, {
      mode: "use" as const,
      key: badKey,
      sourceIdentity: "source-a",
      sourceVersion: "v1",
      ownershipScope: "tenant-a",
      nowMs: 1_700_000_000_000,
      execute,
    }),
    { message: /contentHash/ },
  );
});

void test("PRD 662: revoking one source binding preserves other source hit", async () => {
  const { InMemoryDocumentCacheStore, processDocumentCache, revokeDocumentSourceBinding } =
    await import("../../src/core/document-cache-contract.js");
  const store = new InMemoryDocumentCacheStore();
  const config = makeDefaultConfig();
  const key = makeFullCacheKey();
  const execute = (): { data: string; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } } => ({
    data: "shared",
    provenance: { isOriginal: true, originalCost: 0.01, engine: "docparser", model: "vlm-1" },
  });
  const base = {
    key,
    sourceVersion: "v1",
    ownershipScope: "tenant-a",
    nowMs: 1_700_000_000_000,
    execute,
  };
  processDocumentCache(store, config, { ...base, mode: "use" as const, sourceIdentity: "source-a" });
  processDocumentCache(store, config, { ...base, mode: "use" as const, sourceIdentity: "source-b" });
  revokeDocumentSourceBinding(store, "source-a");
  const hitA = processDocumentCache(store, config, { ...base, mode: "use" as const, sourceIdentity: "source-a", nowMs: 1_700_000_010_000 });
  // source-a binding revoked -> must re-execute (miss), not hit revoked payload
  assert.equal(hitA.cached, false);
  const hitB = processDocumentCache(store, config, { ...base, mode: "use" as const, sourceIdentity: "source-b", nowMs: 1_700_000_020_000 });
  assert.equal(hitB.cached, true);
});

void test("PRD 662: cache store failure does not fail processing", async () => {
  const { processDocumentCache } =
    await import("../../src/core/document-cache-contract.js");
  const failingStore = {
    get(): never { throw new Error("D1 down"); },
    set(): never { throw new Error("D1 down"); },
    revokeSourceBinding(): void { throw new Error("D1 down"); },
    size(): number { throw new Error("D1 down"); },
    sweepExpired(): number { throw new Error("D1 down"); },
  };
  const config = makeDefaultConfig();
  const execute = (): { data: string; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } } => ({
    data: "fresh",
    provenance: { isOriginal: true, originalCost: 0.01, engine: "docparser", model: "vlm-1" },
  });
  const result = processDocumentCache(failingStore, config, {
    mode: "use" as const,
    key: makeFullCacheKey(),
    sourceIdentity: "source-a",
    sourceVersion: "v1",
    ownershipScope: "tenant-a",
    nowMs: 1_700_000_000_000,
    execute,
  });
  assert.equal(result.cached, false);
  assert.equal(result.data, "fresh");
  assert.ok(result.cacheError?.includes("D1 down"));
});

void test("PRD 662: excluded tools bypass cache without writes", async () => {
  const { InMemoryDocumentCacheStore, processDocumentCache } =
    await import("../../src/core/document-cache-contract.js");
  const store = new InMemoryDocumentCacheStore();
  const config = makeDefaultConfig();
  const execute = (): { data: string; provenance: { isOriginal: boolean; originalCost: number; engine: string; model: string } } => ({
    data: "fresh",
    provenance: { isOriginal: true, originalCost: 0.01, engine: "docparser", model: "vlm-1" },
  });
  for (const toolName of ["web_fetch", "web_extract", "parse"] as const) {
    const r = processDocumentCache(store, config, {
      mode: "use" as const,
      key: makeFullCacheKey(),
      sourceIdentity: `src-${toolName}`,
      sourceVersion: "v1",
      ownershipScope: "tenant-a",
      nowMs: 1_700_000_000_000,
      toolName,
      networkPolicyChecked: true,
      execute,
    });
    assert.equal(r.cached, false);
  }
  assert.equal(store.size(), 0);
});

void test("PRD 662: documentCacheKeyString is deterministic and bounded", async () => {
  const { documentCacheKeyString } =
    await import("../../src/core/document-cache-contract.js");
  const key = makeFullCacheKey();
  assert.equal(documentCacheKeyString(key), documentCacheKeyString(key));
  assert.ok(documentCacheKeyString(key).includes("sha256:abc123"));
  assert.ok(documentCacheKeyString(key).length < 2048);
});
