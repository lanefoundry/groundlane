import assert from "node:assert/strict";
import test from "node:test";

import type {
  BillingProvenance,
  CacheConfig,
  ParsedPayloadCacheKey,
} from "../../src/core/document-cache-contract.js";
import type { D1DatabaseLike, D1StatementLike } from "../../src/worker/d1-managed-store.js";
import {
  D1R2DocumentCacheRuntime,
  type D1R2DocumentCacheBindings,
} from "../../src/worker/d1-r2-document-cache.js";
import type {
  R2BucketLike,
  R2ObjectBodyLike,
  R2ObjectLike,
} from "../../src/worker/r2-immutable-blob.js";

const NOW = 1_700_000_000_000;

const config: CacheConfig = {
  enabled: true,
  defaultTtlSeconds: 86_400,
  operatorMaxTtlSeconds: 86_400,
};

const provenance: BillingProvenance = {
  isOriginal: true,
  originalCost: 0,
  engine: "groundlane",
  model: "none",
};

function cacheKey(overrides: Partial<ParsedPayloadCacheKey> = {}): ParsedPayloadCacheKey {
  return {
    ownershipScope: "tenant-one",
    contentHash: `sha256-${"a".repeat(64)}`,
    engineId: "groundlane",
    engineVersion: "1",
    modelId: "none",
    modelVersion: "none",
    normalizedOptions: "{}",
    schemaVersion: "1.0.0",
    policyVersion: "1",
    ...overrides,
  };
}

function processParams<T>(
  execute: () => { readonly data: T; readonly provenance: BillingProvenance },
  overrides: Partial<{
    mode: "use" | "refresh" | "bypass";
    key: ParsedPayloadCacheKey;
    sourceIdentity: string;
    sourceVersion: string;
    ownershipScope: string;
    nowMs: number;
    requestedTtlSeconds: number;
  }> = {},
) {
  const key = overrides.key ?? cacheKey();
  return {
    mode: overrides.mode ?? "use",
    key,
    sourceIdentity: overrides.sourceIdentity ?? "artifact:source-a",
    sourceVersion: overrides.sourceVersion ?? key.contentHash,
    ownershipScope: overrides.ownershipScope ?? key.ownershipScope,
    nowMs: overrides.nowMs ?? NOW,
    ...(overrides.requestedTtlSeconds === undefined
      ? {}
      : { requestedTtlSeconds: overrides.requestedTtlSeconds }),
    toolName: "document_parse",
    networkPolicyChecked: true,
    execute,
  };
}

class FakeDocumentCacheD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly sessionConstraints: string[] = [];
  reads = 0;
  writes = 0;
  failAll = false;

  prepare(query: string): D1StatementLike {
    return new FakeDocumentCacheStatement(this, query);
  }

  batch(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  withSession(constraint: string): D1DatabaseLike {
    this.sessionConstraints.push(constraint);
    return this;
  }

  rowKey(namespace: unknown, key: unknown): string {
    return `${String(namespace)}\u0000${String(key)}`;
  }

  assertAvailable(): void {
    if (this.failAll) throw new Error("D1 unavailable");
  }
}

class FakeDocumentCacheStatement implements D1StatementLike {
  private bound: readonly unknown[] = [];

  constructor(
    private readonly db: FakeDocumentCacheD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    this.bound = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    this.db.assertAvailable();
    this.db.reads += 1;
    const row = this.db.rows.get(this.db.rowKey(this.bound[0], this.bound[1]));
    if (row === undefined) return Promise.resolve(null);
    const { namespace: ignored, ...selected } = row;
    void ignored;
    return Promise.resolve({ ...selected } as T);
  }

  all<T>(): Promise<{ results: readonly T[] }> {
    this.db.assertAvailable();
    this.db.reads += 1;
    const [namespace, nowMs, cursor, limit] = this.bound as [string, number, string, number];
    const results = [...this.db.rows.values()]
      .filter((row) => row.namespace === namespace && typeof row.expires_at === "number" &&
        row.expires_at <= nowMs && String(row.key) > cursor)
      .sort((left, right) => String(left.key).localeCompare(String(right.key)))
      .slice(0, limit)
      .map(({ namespace: ignored, ...row }) => {
        void ignored;
        return { ...row } as T;
      });
    return Promise.resolve({ results });
  }

  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    this.db.assertAvailable();
    this.db.writes += 1;
    if (this.query.startsWith("INSERT INTO durable_records")) {
      const [namespace, key, value, createdAt, updatedAt, expiresAt] = this.bound;
      const id = this.db.rowKey(namespace, key);
      if (this.db.rows.has(id)) return Promise.resolve({ success: true, meta: { changes: 0 } });
      this.db.rows.set(id, {
        namespace,
        key,
        value,
        revision: 1,
        created_at: createdAt,
        updated_at: updatedAt,
        expires_at: expiresAt,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith("UPDATE durable_records")) {
      const [value, updatedAt, expiresAt, namespace, key, expectedRevision] = this.bound;
      const id = this.db.rowKey(namespace, key);
      const row = this.db.rows.get(id);
      if (row === undefined || row.revision !== expectedRevision) {
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.rows.set(id, {
        ...row,
        value,
        revision: Number(row.revision) + 1,
        updated_at: updatedAt,
        expires_at: expiresAt,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith("DELETE FROM durable_records")) {
      const [namespace, key, expectedRevision] = this.bound;
      const id = this.db.rowKey(namespace, key);
      const row = this.db.rows.get(id);
      if (row === undefined || row.revision !== expectedRevision) {
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.rows.delete(id);
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    throw new Error(`unexpected D1 query: ${this.query}`);
  }
}

class FakeDocumentCacheR2 implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  reads = 0;
  writes = 0;
  deletes = 0;
  failWrites = false;

  head(key: string): Promise<R2ObjectLike | null> {
    this.reads += 1;
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined
      ? null
      : { size: object.bytes.byteLength, customMetadata: { ...object.metadata } });
  }

  get(key: string): Promise<R2ObjectBodyLike | null> {
    this.reads += 1;
    const object = this.objects.get(key);
    if (object === undefined) return Promise.resolve(null);
    return Promise.resolve({
      size: object.bytes.byteLength,
      customMetadata: { ...object.metadata },
      bytes: () => Promise.resolve(object.bytes.slice()),
    });
  }

  put(
    key: string,
    value: Uint8Array,
    options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string> },
  ): Promise<R2ObjectLike | null> {
    this.writes += 1;
    if (this.failWrites) throw new Error("R2 unavailable");
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.objects.has(key)) return Promise.resolve(null);
    this.objects.set(key, { bytes: value.slice(), metadata: { ...options.customMetadata } });
    const stored = this.objects.get(key);
    assert.ok(stored);
    return Promise.resolve({
      size: stored.bytes.byteLength,
      customMetadata: { ...stored.metadata },
    });
  }

  delete(key: string): Promise<void> {
    this.deletes += 1;
    this.objects.delete(key);
    return Promise.resolve();
  }
}

function fixture(): {
  readonly db: FakeDocumentCacheD1;
  readonly bucket: FakeDocumentCacheR2;
  readonly runtime: D1R2DocumentCacheRuntime;
} {
  const db = new FakeDocumentCacheD1();
  const bucket = new FakeDocumentCacheR2();
  const bindings: D1R2DocumentCacheBindings = { db, bucket };
  return { db, bucket, runtime: new D1R2DocumentCacheRuntime(bindings) };
}

void test("Cloudflare cache use persists D1 metadata and immutable R2 payload, then returns provenance-preserving hit", async () => {
  const { db, bucket, runtime } = fixture();
  let executions = 0;
  const execute = () => {
    executions += 1;
    return { data: { blocks: ["persisted"] }, provenance };
  };

  const miss = await runtime.process(config, processParams(execute));
  assert.equal(miss.cached, false);
  if (miss.cached) assert.fail("initial request unexpectedly hit");
  assert.equal(miss.stored, true);
  assert.equal(bucket.objects.size, 1);
  assert.equal([...db.rows.values()].filter((row) => String(row.key).includes("document-cache.core.")).length, 1);
  assert.equal([...db.rows.values()].filter((row) => String(row.key).includes("document-cache.binding.")).length, 1);

  const hit = await runtime.process(config, processParams(
    () => { throw new Error("cache hit must not execute"); },
    { nowMs: NOW + 10_000 },
  ));
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.data, { blocks: ["persisted"] });
  assert.equal(executions, 1);
  if (!hit.cached) assert.fail("second request unexpectedly missed");
  assert.equal(hit.hit.ageSeconds, 10);
  assert.deepEqual(hit.hit.billingProvenance, provenance);
  assert.ok(db.sessionConstraints.every((constraint) => constraint === "first-primary"));
});

void test("Cloudflare cache bypass performs no D1 or R2 operation and refresh replaces payload", async () => {
  const { db, bucket, runtime } = fixture();
  const bypass = await runtime.process(config, processParams(
    () => ({ data: "bypass", provenance }),
    { mode: "bypass" },
  ));
  assert.equal(bypass.cached, false);
  assert.equal(db.reads + db.writes, 0);
  assert.equal(bucket.reads + bucket.writes, 0);

  await runtime.process(config, processParams(() => ({ data: "old", provenance })));
  const originalBlobKey = [...bucket.objects.keys()][0];
  const readsBeforeRefresh = db.reads;
  const d1OperationsBeforeRefresh = db.reads + db.writes;
  const r2OperationsBeforeRefresh = bucket.reads + bucket.writes;
  const refreshed = await runtime.process(config, processParams(
    () => {
      assert.equal(db.reads + db.writes, d1OperationsBeforeRefresh);
      assert.equal(bucket.reads + bucket.writes, r2OperationsBeforeRefresh);
      return { data: "new", provenance };
    },
    { mode: "refresh", nowMs: NOW + 1_000 },
  ));
  assert.equal(refreshed.cached, false);
  assert.equal(db.reads > readsBeforeRefresh, true);
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.objects.has(originalBlobKey ?? ""), false);

  const hit = await runtime.process(config, processParams(
    () => { throw new Error("refreshed payload must hit"); },
    { nowMs: NOW + 2_000 },
  ));
  assert.equal(hit.cached, true);
  assert.equal(hit.data, "new");
});

void test("revoking one tenant-bound source does not invalidate another source with the same content hash", async () => {
  const { runtime } = fixture();
  const execute = () => ({ data: { canonicalContentId: "same" }, provenance });
  await runtime.process(config, processParams(execute, { sourceIdentity: "artifact:source-a" }));
  const rebound = await runtime.process(config, processParams(
    () => { throw new Error("same content must bind without executing again"); },
    { sourceIdentity: "url:source-b", nowMs: NOW + 1_000 },
  ));
  assert.equal(rebound.cached, true);

  assert.equal(await runtime.revokeSourceBinding({
    key: cacheKey(),
    sourceIdentity: "artifact:source-a",
    ownershipScope: "tenant-one",
    nowMs: NOW + 2_000,
  }), "revoked");

  let revokedExecutions = 0;
  const revoked = await runtime.process(config, processParams(() => {
    revokedExecutions += 1;
    return execute();
  }, { sourceIdentity: "artifact:source-a", nowMs: NOW + 3_000 }));
  assert.equal(revoked.cached, false);
  assert.equal(revokedExecutions, 1);

  const unaffected = await runtime.process(config, processParams(
    () => { throw new Error("other source binding must remain live"); },
    { sourceIdentity: "url:source-b", nowMs: NOW + 3_000 },
  ));
  assert.equal(unaffected.cached, true);
});

void test("content, engine, model, schema, and tenant dimensions isolate D1 records and R2 objects", async () => {
  const { db, bucket, runtime } = fixture();
  const tenantTwoKey = cacheKey({ ownershipScope: "tenant-two" });
  const variants: ParsedPayloadCacheKey[] = [
    cacheKey(),
    cacheKey({ contentHash: `sha256-${"b".repeat(64)}` }),
    cacheKey({ engineVersion: "2" }),
    cacheKey({ modelId: "layout-model", modelVersion: "2026-09" }),
    cacheKey({ schemaVersion: "2.0.0" }),
    tenantTwoKey,
  ];
  for (const [index, key] of variants.entries()) {
    const result = await runtime.process(config, processParams(
      () => ({ data: { index }, provenance }),
      {
        key,
        ownershipScope: key.ownershipScope,
        sourceIdentity: `artifact:source-${String(index)}`,
        nowMs: NOW + index,
      },
    ));
    assert.equal(result.cached, false);
  }
  assert.equal(bucket.objects.size, variants.length);
  assert.equal([...db.rows.values()].filter((row) => String(row.key).includes("document-cache.core.")).length, variants.length);
  await assert.rejects(runtime.process(config, processParams(
    () => ({ data: "forbidden", provenance }),
    { key: tenantTwoKey, ownershipScope: "tenant-one" },
  )), /Cross-tenant cache reuse forbidden/u);
});

void test("TTL expiry sweep deletes D1 metadata and the matching R2 bytes", async () => {
  const { db, bucket, runtime } = fixture();
  const miss = await runtime.process(config, processParams(
    () => ({ data: "short-lived", provenance }),
    { requestedTtlSeconds: 5 },
  ));
  assert.equal(miss.cached, false);
  assert.equal(bucket.objects.size, 1);
  assert.equal(await runtime.sweepExpired(NOW + 5_001, 10), 3);
  assert.equal(bucket.objects.size, 0);
  assert.equal(db.rows.size, 0);
});

void test("D1 and R2 cache failures fail open while preserving fresh processing output", async () => {
  const d1Failure = fixture();
  d1Failure.db.failAll = true;
  const d1Result = await d1Failure.runtime.process(config, processParams(
    () => ({ data: "fresh-from-d1-outage", provenance }),
  ));
  assert.equal(d1Result.cached, false);
  assert.equal(d1Result.data, "fresh-from-d1-outage");
  if (d1Result.cached) assert.fail("D1 outage unexpectedly hit");
  assert.equal(d1Result.stored, false);
  assert.equal(d1Result.cacheError, "Document cache unavailable");

  const r2Failure = fixture();
  r2Failure.bucket.failWrites = true;
  const r2Result = await r2Failure.runtime.process(config, processParams(
    () => ({ data: "fresh-from-r2-outage", provenance }),
  ));
  assert.equal(r2Result.cached, false);
  assert.equal(r2Result.data, "fresh-from-r2-outage");
  if (r2Result.cached) assert.fail("R2 outage unexpectedly hit");
  assert.equal(r2Result.stored, false);
  assert.equal(r2Result.cacheError, "Document cache unavailable");
});

void test("R2 payload bytes are bounded and oversized results remain usable but unstored", async () => {
  const { bucket, runtime } = fixture();
  const oversized = { text: "x".repeat(32 * 1024 * 1024) };
  const result = await runtime.process(config, processParams(
    () => ({ data: oversized, provenance }),
  ));
  assert.equal(result.cached, false);
  assert.equal(result.data, oversized);
  if (result.cached) assert.fail("oversized result unexpectedly hit");
  assert.equal(result.stored, false);
  assert.equal(result.cacheError, "Document cache unavailable");
  assert.equal(bucket.objects.size, 0);
});
