import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { SqliteImmutableBlobStore } from "../../src/adapters/state/sqlite-immutable-blob.js";
import {
  DurableDocumentCacheRepository,
  durableDocumentCacheRecordKeys,
} from "../../src/core/durable-document-cache.js";
import type {
  BillingProvenance,
  CacheConfig,
  DocumentCacheIdentity,
  DocumentCacheExecution,
  ParsedPayloadCacheKey,
} from "../../src/core/document-cache-contract.js";
import type {
  DurableCasResult,
  DurableCreateResult,
  DurableDeleteResult,
  DurableExpiredPage,
  DurableRecord,
  DurableRecordStorePort,
  DurableRecordUpdate,
  NewDurableRecord,
} from "../../src/core/durable-store.js";
import type {
  ImmutableBlobPort,
  ImmutableBlobPutResult,
  ImmutableBlobStat,
} from "../../src/core/immutable-blob.js";

const config: CacheConfig = {
  enabled: true,
  defaultTtlSeconds: 86_400,
  operatorMaxTtlSeconds: 86_400,
};

const key: ParsedPayloadCacheKey = {
  ownershipScope: "tenant-one",
  contentHash: "sha256-content-one",
  engineId: "groundlane",
  engineVersion: "1",
  modelId: "none",
  modelVersion: "none",
  normalizedOptions: "{}",
  schemaVersion: "1.0.0",
  policyVersion: "1",
};

const provenance: BillingProvenance = {
  isOriginal: true,
  originalCost: 0,
  engine: "groundlane",
  model: "none",
};

async function databaseFixture(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "cache.sqlite");
}

function params<T>(overrides: Partial<{
  mode: "use" | "refresh" | "bypass";
  sourceIdentity: string;
  sourceVersion: string;
  nowMs: number;
  sourceExpiresAt: number;
  requestedTtlSeconds: number;
  execute: () => Promise<DocumentCacheExecution<T>> | DocumentCacheExecution<T>;
}> & { execute: () => Promise<DocumentCacheExecution<T>> | DocumentCacheExecution<T> }) {
  return {
    mode: overrides.mode ?? "use",
    key,
    sourceIdentity: overrides.sourceIdentity ?? "artifact:source-a",
    sourceVersion: overrides.sourceVersion ?? "v1",
    ownershipScope: "tenant-one",
    nowMs: overrides.nowMs ?? 1_700_000_000_000,
    ...(overrides.sourceExpiresAt === undefined
      ? {}
      : { sourceExpiresAt: overrides.sourceExpiresAt }),
    ...(overrides.requestedTtlSeconds === undefined
      ? {}
      : { requestedTtlSeconds: overrides.requestedTtlSeconds }),
    toolName: "document_parse",
    networkPolicyChecked: true,
    execute: overrides.execute,
  };
}

function identity(
  overrides: Partial<Omit<DocumentCacheIdentity, "key" | "ownershipScope">> = {},
): DocumentCacheIdentity {
  return {
    mode: overrides.mode ?? "use",
    key,
    sourceIdentity: overrides.sourceIdentity ?? "artifact:source-a",
    sourceVersion: overrides.sourceVersion ?? "v1",
    ownershipScope: "tenant-one",
    nowMs: overrides.nowMs ?? 1_700_000_000_000,
    ...(overrides.sourceExpiresAt === undefined
      ? {}
      : { sourceExpiresAt: overrides.sourceExpiresAt }),
    ...(overrides.requestedTtlSeconds === undefined
      ? {}
      : { requestedTtlSeconds: overrides.requestedTtlSeconds }),
    toolName: overrides.toolName ?? "document_parse",
    networkPolicyChecked: overrides.networkPolicyChecked ?? true,
  };
}

void test("two-phase lookup and commit are callback-free, serializable, and persist a later hit", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  const request = identity();

  const lookup = await repository.lookup<{ blocks: string[] }>(config, request);
  assert.equal(lookup.cached, false);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ config, request, lookup })));
  if (lookup.cached) assert.fail("empty cache unexpectedly hit");
  assert.equal(lookup.disposition, "ordinary");

  const committed = await repository.commit(
    config,
    request,
    { data: { blocks: ["persisted"] }, provenance },
    lookup,
  );
  assert.equal(committed.cached, false);
  assert.equal(committed.stored, true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(committed)));

  const hit = await repository.lookup<{ blocks: string[] }>(config, {
    ...request,
    nowMs: request.nowMs + 1_000,
  });
  assert.equal(hit.cached, true);
  if (!hit.cached) assert.fail("committed cache entry did not hit");
  assert.deepEqual(hit.data, { blocks: ["persisted"] });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(hit)));
});

void test("lookup reports refresh, bypass, and operator-disabled dispositions without cache I/O", async () => {
  const store = new FailingStore();
  const repository = new DurableDocumentCacheRepository(store);

  const refresh = await repository.lookup(config, identity({ mode: "refresh" }));
  assert.deepEqual(refresh, { cached: false, disposition: "refresh" });
  const bypass = await repository.lookup(config, identity({ mode: "bypass" }));
  assert.deepEqual(bypass, { cached: false, disposition: "bypass" });
  const excluded = await repository.lookup(config, identity({ toolName: "web_fetch" }));
  assert.deepEqual(excluded, { cached: false, disposition: "bypass" });
  const disabled = await repository.lookup(
    { ...config, enabled: false },
    identity(),
  );
  assert.deepEqual(disabled, { cached: false, disposition: "disabled", degraded: true });
  assert.equal(store.calls, 0);
});

void test("an artifact-derived cache binding cannot outlive its absolute source expiry", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  const request = identity({ sourceExpiresAt: 1_700_000_090_999 });
  const miss = await repository.lookup(config, request);
  assert.equal(miss.cached, false);
  if (miss.cached) assert.fail("empty cache unexpectedly hit");
  const committed = await repository.commit(
    config,
    request,
    { data: "source-bounded", provenance },
    miss,
  );
  assert.equal(committed.expiresAt, 1_700_000_090_000);

  const expiredRequest = identity({ nowMs: 1_700_000_100_000, sourceExpiresAt: 1_700_000_090_999 });
  const expiredMiss = await repository.lookup(config, expiredRequest);
  assert.equal(expiredMiss.cached, false);
  if (expiredMiss.cached) assert.fail("expired source unexpectedly hit");
  const notStored = await repository.commit(
    config,
    expiredRequest,
    { data: "fresh", provenance },
    expiredMiss,
  );
  assert.equal(notStored.stored, false);
});

void test("two-phase read faults stay sanitized and commit performs no second cache operation", async () => {
  const store = new FailingStore();
  const repository = new DurableDocumentCacheRepository(store);
  const request = identity();
  const lookup = await repository.lookup(config, request);
  assert.equal(lookup.cached, false);
  if (lookup.cached) assert.fail("failing cache unexpectedly hit");
  assert.equal(lookup.disposition, "ordinary");
  assert.equal(lookup.cacheError, "Document cache unavailable");
  const callsAfterLookup = store.calls;

  const committed = await repository.commit(
    config,
    request,
    { data: "fresh despite outage", provenance },
    lookup,
  );
  assert.deepEqual(committed, {
    cached: false,
    data: "fresh despite outage",
    provenance,
    stored: false,
    cacheError: "Document cache unavailable",
  });
  assert.equal(store.calls, callsAfterLookup);
});

void test("a stale ordinary commit cannot restore a binding revoked between lookup and commit", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  const request = identity();
  const staleDecision = await repository.lookup(config, request);
  assert.equal(staleDecision.cached, false);
  if (staleDecision.cached) assert.fail("empty cache unexpectedly hit");

  await repository.process(config, params({
    execute: () => ({ data: "concurrent winner", provenance }),
  }));
  assert.equal(await repository.revokeSourceBinding({
    key,
    sourceIdentity: request.sourceIdentity,
    ownershipScope: request.ownershipScope,
    nowMs: request.nowMs + 1_000,
  }), "revoked");

  const committed = await repository.commit(
    config,
    { ...request, nowMs: request.nowMs + 2_000 },
    { data: "stale execution", provenance },
    staleDecision,
  );
  assert.equal(committed.stored, false);
  const after = await repository.lookup(config, {
    ...request,
    nowMs: request.nowMs + 3_000,
  });
  assert.equal(after.cached, false);
  if (after.cached) assert.fail("stale commit silently restored a revoked binding");
  assert.equal(after.disposition, "revoked");
});

void test("use persists content core and source binding across SQLite reopen", async (t) => {
  const path = await databaseFixture(t);
  let executions = 0;
  const firstStore = new SqliteDurableRecordStore(path, "document-cache");
  const first = new DurableDocumentCacheRepository(firstStore);
  const miss = await first.process(config, params({
    execute: () => Promise.resolve({ data: { blocks: ["persisted"] }, provenance }),
  }));
  executions += 1;
  assert.equal(miss.cached, false);
  assert.equal(miss.stored, true);

  const recordKeys = durableDocumentCacheRecordKeys(key, "tenant-one", "artifact:source-a");
  const core = await firstStore.get(recordKeys.core);
  const binding = await firstStore.get(recordKeys.binding);
  assert.match(core?.value ?? "", /document-cache-core/u);
  assert.match(core?.value ?? "", /persisted/u);
  assert.doesNotMatch(binding?.value ?? "", /persisted/u);
  assert.match(binding?.value ?? "", /document-cache-source-binding/u);
  firstStore.close();

  const reopenedStore = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => reopenedStore.close());
  const reopened = new DurableDocumentCacheRepository(reopenedStore);
  const hit = await reopened.process(config, params({
    nowMs: 1_700_000_010_000,
    execute: () => {
      executions += 1;
      return { data: { blocks: ["unexpected"] }, provenance };
    },
  }));
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.data, { blocks: ["persisted"] });
  assert.equal(executions, 1);
  if (hit.cached) assert.equal(hit.hit.ageSeconds, 10);
});

void test("bypass does not read or write durable records", async () => {
  const store = new FailingStore();
  const repository = new DurableDocumentCacheRepository(store);
  const result = await repository.process(config, params({
    mode: "bypass",
    execute: () => ({ data: "fresh", provenance }),
  }));
  assert.equal(result.cached, false);
  assert.equal(result.data, "fresh");
  if (!result.cached) assert.equal(result.stored, false);
  assert.equal(store.calls, 0);
});

void test("refresh replaces the core through CAS and resets expiry", async (t) => {
  const path = await databaseFixture(t);
  const store = new CountingStore(new SqliteDurableRecordStore(path, "document-cache"));
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  await repository.process(config, params({
    requestedTtlSeconds: 10,
    execute: () => ({ data: "old", provenance }),
  }));
  const refreshed = await repository.process(config, params({
    mode: "refresh",
    nowMs: 1_700_000_005_000,
    requestedTtlSeconds: 20,
    execute: () => ({ data: "new", provenance }),
  }));
  assert.equal(refreshed.cached, false);
  assert.equal(store.casCalls > 0, true);

  const hit = await repository.process(config, params({
    nowMs: 1_700_000_020_000,
    execute: () => ({ data: "unexpected", provenance }),
  }));
  assert.equal(hit.cached, true);
  assert.equal(hit.data, "new");
  if (hit.cached) assert.equal(hit.hit.expiresAt, 1_700_000_025_000);
});

void test("expired core executes again and is replaced", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  await repository.process(config, params({
    requestedTtlSeconds: 1,
    execute: () => ({ data: "old", provenance }),
  }));
  const afterExpiry = await repository.process(config, params({
    nowMs: 1_700_000_002_000,
    execute: () => ({ data: "new", provenance }),
  }));
  assert.equal(afterExpiry.cached, false);
  assert.equal(afterExpiry.data, "new");
  const hit = await repository.process(config, params({
    nowMs: 1_700_000_003_000,
    execute: () => ({ data: "unexpected", provenance }),
  }));
  assert.equal(hit.cached, true);
  assert.equal(hit.data, "new");
});

void test("revoking one source binding preserves another binding to the same core", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  const execute = () => ({ data: { canonicalContentId: "same-content" }, provenance });
  await repository.process(config, params({ sourceIdentity: "artifact:source-a", execute }));
  await repository.process(config, params({ sourceIdentity: "url:source-b", execute }));

  assert.equal(await repository.revokeSourceBinding({
    key,
    sourceIdentity: "artifact:source-a",
    ownershipScope: "tenant-one",
    nowMs: 1_700_000_010_000,
  }), "revoked");

  let deletedSourceExecutions = 0;
  const deletedSource = await repository.process(config, params({
    sourceIdentity: "artifact:source-a",
    nowMs: 1_700_000_020_000,
    execute: () => {
      deletedSourceExecutions += 1;
      return execute();
    },
  }));
  assert.equal(deletedSource.cached, false);
  assert.equal(deletedSourceExecutions, 1);

  const otherSource = await repository.process(config, params({
    sourceIdentity: "url:source-b",
    nowMs: 1_700_000_020_000,
    execute: () => {
      throw new Error("other binding should still hit");
    },
  }));
  assert.equal(otherSource.cached, true);
  assert.deepEqual(otherSource.data, { canonicalContentId: "same-content" });
});

void test("revoking one source invalidates every parser-option binding but preserves another source", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  const alternateKey: ParsedPayloadCacheKey = {
    ...key,
    normalizedOptions: JSON.stringify({ projection: "markdown" }),
  };
  let executions = 0;
  const execute = (label: string) => {
    executions += 1;
    return { data: { label }, provenance };
  };

  await repository.process(config, params({ execute: () => execute("default") }));
  await repository.process(config, {
    ...params({ execute: () => execute("alternate") }),
    key: alternateKey,
  });
  const otherSource = await repository.process(config, params({
    sourceIdentity: "url:source-b",
    nowMs: 1_700_000_001_000,
    execute: () => { throw new Error("same core should bind without executing"); },
  }));
  assert.equal(otherSource.cached, true);

  assert.equal(await repository.revokeAllSourceBindings({
    sourceIdentity: "artifact:source-a",
    ownershipScope: "tenant-one",
    nowMs: 1_700_000_002_000,
  }), "revoked");

  const revokedDefault = await repository.process(config, params({
    nowMs: 1_700_000_003_000,
    execute: () => execute("revoked-default"),
  }));
  const revokedAlternate = await repository.process(config, {
    ...params({
      nowMs: 1_700_000_003_000,
      execute: () => execute("revoked-alternate"),
    }),
    key: alternateKey,
  });
  assert.equal(revokedDefault.cached, false);
  assert.equal(revokedAlternate.cached, false);
  assert.equal(revokedDefault.stored, false);
  assert.equal(revokedAlternate.stored, false);

  const unaffected = await repository.process(config, params({
    sourceIdentity: "url:source-b",
    nowMs: 1_700_000_004_000,
    execute: () => { throw new Error("other source binding must remain live"); },
  }));
  assert.equal(unaffected.cached, true);
  assert.equal(executions, 4);
});

void test("same content reuses its core while binding a new source", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => store.close());
  const repository = new DurableDocumentCacheRepository(store);
  let executions = 0;
  const execute = () => {
    executions += 1;
    return { data: { canonicalContentId: "same-content" }, provenance };
  };

  const first = await repository.process(config, params({
    sourceIdentity: "artifact:source-a",
    execute,
  }));
  const rebound = await repository.process(config, params({
    sourceIdentity: "url:source-b",
    nowMs: 1_700_000_010_000,
    execute,
  }));

  assert.equal(first.cached, false);
  assert.equal(rebound.cached, true);
  assert.equal(executions, 1);
  const reboundKeys = durableDocumentCacheRecordKeys(key, "tenant-one", "url:source-b");
  assert.match((await store.get(reboundKeys.binding))?.value ?? "", /url:source-b/u);
});

void test("cache store failure returns fresh processing result", async () => {
  const store = new FailingStore();
  const repository = new DurableDocumentCacheRepository(store);
  const result = await repository.process(config, params({
    execute: () => ({ data: "fresh despite outage", provenance }),
  }));
  assert.equal(result.cached, false);
  assert.equal(result.data, "fresh despite outage");
  if (!result.cached) {
    assert.equal(result.stored, false);
    assert.equal(result.cacheError, "Document cache unavailable");
  }
});

void test("large payloads use immutable blob storage and expiry sweep removes bytes", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  const payloads = new SqliteImmutableBlobStore(path, "document-cache-payloads");
  t.after(() => { store.close(); payloads.close(); });
  const repository = new DurableDocumentCacheRepository(store, { payloads });
  const large = { text: "x".repeat(80_000) };
  const miss = await repository.process(config, params({ execute: () => ({ data: large, provenance }) }));
  assert.equal(miss.cached, false);
  if (miss.cached) assert.fail("large payload unexpectedly reported a hit");
  assert.equal(miss.stored, true);

  const keys = durableDocumentCacheRecordKeys(key, "tenant-one", "artifact:source-a");
  const core = await store.get(keys.core);
  assert.doesNotMatch(core?.value ?? "", /xxxxxxxxxxxxxxxx/u);
  const blobKey = /"blobKey":"([^"]+)"/u.exec(core?.value ?? "")?.[1];
  assert.equal(typeof blobKey, "string");
  if (blobKey === undefined) assert.fail("payload blob key is missing");
  assert.notEqual(await payloads.stat(blobKey), null);

  const hit = await repository.process(config, params({
    nowMs: 1_700_000_001_000,
    execute: () => { throw new Error("large payload should hit"); },
  }));
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.data, large);

  assert.equal(await repository.sweepExpired(1_700_086_400_001), 3);
  assert.equal(await payloads.stat(blobKey), null);
});

void test("expiry cleanup does not delete core metadata before immutable byte deletion succeeds", async (t) => {
  const path = await databaseFixture(t);
  const store = new SqliteDurableRecordStore(path, "document-cache");
  const innerPayloads = new SqliteImmutableBlobStore(path, "document-cache-payloads");
  const payloads = new DeleteFailingBlobStore(innerPayloads);
  t.after(() => { store.close(); innerPayloads.close(); });
  const repository = new DurableDocumentCacheRepository(store, { payloads });
  const result = await repository.process(config, params({
    execute: () => ({ data: { text: "x".repeat(80_000) }, provenance }),
  }));
  assert.equal(result.cached, false);
  const keys = durableDocumentCacheRecordKeys(key, "tenant-one", "artifact:source-a");
  const core = await store.get(keys.core);
  const blobKey = /"blobKey":"([^"]+)"/u.exec(core?.value ?? "")?.[1];
  if (blobKey === undefined) assert.fail("payload blob key is missing");

  payloads.failDelete = true;
  await assert.rejects(repository.sweepExpired(1_700_086_400_001), /simulated blob delete failure/u);
  assert.notEqual(await store.get(keys.core), null);
  assert.notEqual(await innerPayloads.stat(blobKey), null);
});

void test("cleanup marker removes a blob when metadata creation fails", async (t) => {
  const path = await databaseFixture(t);
  const inner = new SqliteDurableRecordStore(path, "document-cache");
  const store = new FailCoreCreateStore(inner);
  const payloads = new SqliteImmutableBlobStore(path, "document-cache-payloads");
  t.after(() => { inner.close(); payloads.close(); });
  const repository = new DurableDocumentCacheRepository(store, { payloads });

  const result = await repository.process(config, params({
    execute: () => ({ data: { text: "x".repeat(80_000) }, provenance }),
  }));
  assert.equal(result.cached, false);
  if (result.cached) assert.fail("metadata failure unexpectedly reported a cache hit");
  assert.equal(result.stored, false);
  assert.equal(result.cacheError, "Document cache unavailable");
  assert.equal(payloads.count(), 1);

  assert.equal(await repository.sweepExpired(1_700_003_600_001), 1);
  assert.equal(payloads.count(), 0);
});

void test("concurrent refreshes use CAS and leave a readable durable winner", async (t) => {
  const path = await databaseFixture(t);
  const leftStore = new CountingStore(new SqliteDurableRecordStore(path, "document-cache"));
  const rightStore = new CountingStore(new SqliteDurableRecordStore(path, "document-cache"));
  t.after(() => { leftStore.close(); rightStore.close(); });
  const left = new DurableDocumentCacheRepository(leftStore);
  const right = new DurableDocumentCacheRepository(rightStore);
  await left.process(config, params({ execute: () => ({ data: "initial", provenance }) }));

  const results = await Promise.all([
    left.process(config, params({
      mode: "refresh",
      nowMs: 1_700_000_010_000,
      execute: () => ({ data: "left", provenance }),
    })),
    right.process(config, params({
      mode: "refresh",
      nowMs: 1_700_000_010_001,
      execute: () => ({ data: "right", provenance }),
    })),
  ]);
  assert.equal(results.every((result) => !result.cached && result.stored), true);
  assert.equal(leftStore.casCalls + rightStore.casCalls >= 4, true);
  assert.equal(leftStore.casConflicts + rightStore.casConflicts >= 1, true);

  const reopenedStore = new SqliteDurableRecordStore(path, "document-cache");
  t.after(() => reopenedStore.close());
  const hit = await new DurableDocumentCacheRepository(reopenedStore).process(config, params({
    nowMs: 1_700_000_020_000,
    execute: () => ({ data: "unexpected", provenance }),
  }));
  assert.equal(hit.cached, true);
  assert.equal(["left", "right"].includes(String(hit.data)), true);
});

class FailingStore implements DurableRecordStorePort {
  calls = 0;

  private fail(): never {
    this.calls += 1;
    throw new Error("durable cache unavailable");
  }

  get(): Promise<DurableRecord | null> {
    return this.fail();
  }

  createIfAbsent(): Promise<DurableCreateResult> {
    return this.fail();
  }

  compareAndSwap(): Promise<DurableCasResult> {
    return this.fail();
  }

  deleteIfRevision(): Promise<DurableDeleteResult> {
    return this.fail();
  }

  scanExpired(): Promise<DurableExpiredPage> {
    return this.fail();
  }
}

class DeleteFailingBlobStore implements ImmutableBlobPort {
  failDelete = false;

  constructor(private readonly inner: ImmutableBlobPort) {}

  putIfAbsent(input: { blobKey: string; ownerId: string; digest: string; bytes: Uint8Array }): Promise<ImmutableBlobPutResult> {
    return this.inner.putIfAbsent(input);
  }

  stat(blobKey: string): Promise<ImmutableBlobStat | null> {
    return this.inner.stat(blobKey);
  }

  get(input: { blobKey: string; ownerId: string; digest: string; maxBytes: number }): Promise<Uint8Array | null> {
    return this.inner.get(input);
  }

  deleteIfOwner(blobKey: string, ownerId: string): Promise<"deleted" | "missing" | "owner_mismatch"> {
    if (this.failDelete) return Promise.reject(new Error("simulated blob delete failure"));
    return this.inner.deleteIfOwner(blobKey, ownerId);
  }
}

class CountingStore implements DurableRecordStorePort {
  casCalls = 0;
  casConflicts = 0;

  constructor(private readonly inner: SqliteDurableRecordStore) {}

  close(): void {
    this.inner.close();
  }

  get(keyValue: string): Promise<DurableRecord | null> {
    return this.inner.get(keyValue);
  }

  createIfAbsent(record: NewDurableRecord): Promise<DurableCreateResult> {
    return this.inner.createIfAbsent(record);
  }

  async compareAndSwap(keyValue: string, expectedRevision: number, update: DurableRecordUpdate): Promise<DurableCasResult> {
    this.casCalls += 1;
    const result = await this.inner.compareAndSwap(keyValue, expectedRevision, update);
    if (result.status === "conflict") this.casConflicts += 1;
    return result;
  }

  deleteIfRevision(keyValue: string, expectedRevision: number): Promise<DurableDeleteResult> {
    return this.inner.deleteIfRevision(keyValue, expectedRevision);
  }

  scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage> {
    return this.inner.scanExpired(nowMs, cursor, limit);
  }
}

class FailCoreCreateStore implements DurableRecordStorePort {
  constructor(private readonly inner: SqliteDurableRecordStore) {}

  get(keyValue: string): Promise<DurableRecord | null> {
    return this.inner.get(keyValue);
  }

  createIfAbsent(record: NewDurableRecord): Promise<DurableCreateResult> {
    if (record.key.startsWith("document-cache.core.")) {
      return Promise.reject(new Error("simulated core metadata outage"));
    }
    return this.inner.createIfAbsent(record);
  }

  compareAndSwap(keyValue: string, expectedRevision: number, update: DurableRecordUpdate): Promise<DurableCasResult> {
    return this.inner.compareAndSwap(keyValue, expectedRevision, update);
  }

  deleteIfRevision(keyValue: string, expectedRevision: number): Promise<DurableDeleteResult> {
    return this.inner.deleteIfRevision(keyValue, expectedRevision);
  }

  scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage> {
    return this.inner.scanExpired(nowMs, cursor, limit);
  }
}
