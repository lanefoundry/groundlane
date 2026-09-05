import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteCorpusDerivedIndex } from "../../src/adapters/state/sqlite-corpus-index.js";
import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { SqliteImmutableBlobStore } from "../../src/adapters/state/sqlite-immutable-blob.js";
import {
  DurableCorpusRuntime,
  ImmutableBlobCorpusSourceArtifacts,
  type CorpusSourceArtifactPort,
  type CorpusCacheInvalidationPort,
  type DurableCorpusCaller,
} from "../../src/core/durable-corpus-runtime.js";
import { DurableCorpusRepository } from "../../src/core/durable-corpora.js";

const caller: DurableCorpusCaller = {
  tenantId: "deployment-a",
  ownerId: "owner",
  credentialBinding: "managed:credential-a",
  roles: ["role:reader", "role:writer"],
};

void test("canonical corpus artifact keys preserve reads and deletion of earlier role-bound local blobs", async (t) => {
  const opened = openRuntime(await statePath());
  t.after(() => { opened.records.close(); opened.blobs.close(); opened.index.close(); });
  const bytes = new TextEncoder().encode("legacy source");
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const input = { corpusId: "corpus-legacy", sourceId: "source-legacy", contentHash: `sha256-${hash(bytes)}`, binding: caller };
  const blobKey = `blobs/${hash(JSON.stringify(input))}`;
  const ownerId = `corpus-${hash(JSON.stringify(caller))}`;
  await opened.blobs.putIfAbsent({ blobKey, ownerId, digest: input.contentHash, bytes });
  assert.deepEqual(await opened.artifacts.read({ ...input, maxBytes: 100 }), bytes);
  assert.deepEqual(await opened.artifacts.read({ ...input, binding: { tenantId: caller.tenantId, ownerId: caller.ownerId, credentialBinding: caller.credentialBinding }, maxBytes: 100 }), bytes);
  assert.equal(await opened.artifacts.delete(input), true);
  assert.equal(await opened.blobs.get({ blobKey, ownerId, digest: input.contentHash, maxBytes: 100 }), null);
});

void test("corpus parse reader enforces credential, tenant, ACL, expiry, and current manifest", async (t) => {
  let now = new Date("2026-09-05T08:00:00.000Z");
  const opened = openRuntime(await statePath(), undefined, () => now);
  t.after(() => { opened.records.close(); opened.blobs.close(); opened.index.close(); });
  const corpus = await opened.runtime.createCorpus({ displayName: "Parse source", callerExpiresAt: null }, caller);
  const source = await opened.runtime.enrollSource(corpus.corpusId, {
    content: "Parse this source", acl: ["role:reader"], retentionPolicy: "operator-default",
    deletionPolicy: "on_owner_delete", citationProvenance: "test", callerExpiresAt: "2026-09-05T08:01:00.000Z",
  }, caller);
  const read = (binding = caller) => opened.runtime.readSource(corpus.corpusId, source.sourceId, binding);
  assert.equal(new TextDecoder().decode((await read()).bytes), "Parse this source");
  assert.equal(new TextDecoder().decode((await read({ ...caller, roles: ["role:reader"] })).bytes), "Parse this source");
  await assert.rejects(read({ ...caller, credentialBinding: "other" }));
  await assert.rejects(read({ ...caller, tenantId: "other" }));
  await assert.rejects(read({ ...caller, roles: [] }));
  now = new Date("2026-09-05T08:01:00.000Z");
  await assert.rejects(read());
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-corpus-runtime-"));
  return join(directory, "state.sqlite");
}

function openRuntime(
  path: string,
  artifactOverride?: CorpusSourceArtifactPort,
  now: () => Date = () => new Date("2026-09-05T08:00:00.000Z"),
  cache?: CorpusCacheInvalidationPort,
) {
  const records = new SqliteDurableRecordStore(path, "corpora-v1");
  const blobs = new SqliteImmutableBlobStore(path, "corpus-source-blobs-v1");
  const index = new SqliteCorpusDerivedIndex(path, "corpus-index-v1");
  const artifacts = artifactOverride ?? new ImmutableBlobCorpusSourceArtifacts(blobs);
  const runtime = new DurableCorpusRuntime({
    repository: new DurableCorpusRepository(records),
    artifacts,
    index,
    now,
    ...(cache === undefined ? {} : { cache }),
    idFactory: () => "11111111-2222-4333-8444-555555555555",
  });
  return { runtime, records, blobs, index, artifacts };
}

for (const scenario of [
  { name: "content change", update: { content: "replacement source payload" }, invalidates: true },
  { name: "ACL change", update: { acl: ["role:writer"] }, invalidates: true },
  { name: "provenance change", update: { citationProvenance: "updated provenance" }, invalidates: false },
  { name: "equivalent ACL", update: { acl: ["role:writer", "role:reader"] }, invalidates: false },
  { name: "unchanged content", update: { content: "original shared payload" }, invalidates: false },
]) {
  void test(`corpus update cache invalidation isolates source on ${scenario.name}`, async (t) => {
    const revoked: Parameters<CorpusCacheInvalidationPort["revoke"]>[0][] = [];
    const opened = openRuntime(await statePath(), undefined, undefined, {
      revoke: (input) => { revoked.push(input); return Promise.resolve(); },
    });
    t.after(() => { opened.records.close(); opened.blobs.close(); opened.index.close(); });
    const corpus = await opened.runtime.createCorpus({ displayName: "Cache binding", callerExpiresAt: null }, caller);
    const source = {
      content: "original shared payload", acl: ["role:reader", "role:writer"],
      retentionPolicy: "operator-default", deletionPolicy: "on_owner_delete",
      citationProvenance: "normalized-text-v1", callerExpiresAt: null,
    };
    const first = await opened.runtime.enrollSource(corpus.corpusId, { ...source, sourceId: "source-first" }, caller);
    const second = await opened.runtime.enrollSource(corpus.corpusId, { ...source, sourceId: "source-second" }, caller);
    await opened.runtime.updateSource(corpus.corpusId, first.sourceId, scenario.update, caller);
    assert.deepEqual(revoked, scenario.invalidates ? [{
      corpusId: corpus.corpusId, sourceId: first.sourceId, contentHash: first.contentHash, binding: caller,
    }] : []);
    const other = (await opened.runtime.corpusStatus(corpus.corpusId, caller)).manifest.sources.find(
      (entry) => entry.sourceId === second.sourceId,
    );
    assert.equal(other?.contentHash, first.contentHash);
    assert.deepEqual(other?.acl, source.acl);
  });
}

void test("cache invalidation failure preserves committed corpus update and durable degraded status", async (t) => {
  const path = await statePath();
  const opened = openRuntime(path, undefined, undefined, {
    revoke: () => Promise.reject(new Error("cache unavailable")),
  });
  t.after(() => { opened.records.close(); opened.blobs.close(); opened.index.close(); });
  const corpus = await opened.runtime.createCorpus({ displayName: "Failed cache revoke", callerExpiresAt: null }, caller);
  const source = await opened.runtime.enrollSource(corpus.corpusId, {
    content: "original payload", acl: ["role:reader"], retentionPolicy: "operator-default",
    deletionPolicy: "on_owner_delete", citationProvenance: "normalized-text-v1", callerExpiresAt: null,
  }, caller);
  const updated = await opened.runtime.updateSource(corpus.corpusId, source.sourceId, {
    content: "replacement payload", acl: ["role:writer"],
  }, caller);
  assert.equal(updated.state, "degraded");
  assert.notEqual(updated.contentHash, source.contentHash);
  const reopened = openRuntime(path);
  t.after(() => { reopened.records.close(); reopened.blobs.close(); reopened.index.close(); });
  const status = await reopened.runtime.corpusStatus(corpus.corpusId, caller);
  assert.equal(status.state, "degraded");
  assert.equal(status.manifest.sources[0]?.contentHash, updated.contentHash);
  assert.deepEqual(status.manifest.sources[0]?.acl, ["role:writer"]);
  assert.equal((await reopened.runtime.searchCorpus(corpus.corpusId, "replacement", caller)).results.length, 1);
});

void test("durable corpus content, manifest, artifact, and index survive restart", async () => {
  const path = await statePath();
  const first = openRuntime(path);
  const corpus = await first.runtime.createCorpus({ displayName: "Runbook", callerExpiresAt: null }, caller);
  const enrollment = await first.runtime.enrollSource(corpus.corpusId, {
    content: "Groundlane durable corpus restart evidence",
    acl: ["role:reader"],
    retentionPolicy: "operator-default",
    deletionPolicy: "on_owner_delete",
    citationProvenance: "normalized-text-v1",
    callerExpiresAt: null,
  }, caller);
  first.records.close();
  first.blobs.close();
  first.index.close();

  const reopened = openRuntime(path);
  const status = await reopened.runtime.corpusStatus(corpus.corpusId, caller);
  const search = await reopened.runtime.searchCorpus(corpus.corpusId, "restart evidence", caller);
  assert.equal(status.enrolledCount, 1);
  assert.equal(status.manifest.sources[0]?.sourceId, enrollment.sourceId);
  assert.equal(search.results[0]?.sourceId, enrollment.sourceId);
  assert.match(search.results[0]?.contentHash ?? "", /^sha256-[a-f0-9]{64}$/u);
  reopened.records.close();
  reopened.blobs.close();
  reopened.index.close();
});

void test("rebuild exactly replaces stale derived rows without changing manifest", async () => {
  const path = await statePath();
  const opened = openRuntime(path);
  const corpus = await opened.runtime.createCorpus({ displayName: "Exact rebuild", callerExpiresAt: null }, caller);
  const enrolled = await opened.runtime.enrollSource(corpus.corpusId, {
    content: "authoritative manifest document",
    sourceId: "gl-source-authoritative",
    acl: ["role:reader"],
    retentionPolicy: "operator-default",
    deletionPolicy: "on_owner_delete",
    citationProvenance: "normalized-text-v1",
    callerExpiresAt: null,
  }, caller);
  await opened.index.upsert(corpus.corpusId, {
    sourceId: "gl-source-stale",
    contentHash: `sha256-${"a".repeat(64)}`,
    text: "stale derived row",
  });
  assert.equal((await opened.index.search(corpus.corpusId, "stale", 10)).length, 1);
  const before = (await opened.runtime.corpusStatus(corpus.corpusId, caller)).manifest;
  assert.equal(before.sources[0]?.sourceId, enrolled.sourceId);
  const after = await opened.runtime.rebuildDerivedIndex(corpus.corpusId, caller);
  assert.deepEqual(after.sources, before.sources);
  assert.equal((await opened.index.search(corpus.corpusId, "stale", 10)).length, 0);
  opened.records.close();
  opened.blobs.close();
  opened.index.close();
});

void test("delete revokes access before retryable artifact cleanup completes", async () => {
  const path = await statePath();
  const records = new SqliteDurableRecordStore(path, "corpora-v1");
  const blobs = new SqliteImmutableBlobStore(path, "corpus-source-blobs-v1");
  const index = new SqliteCorpusDerivedIndex(path, "corpus-index-v1");
  const inner = new ImmutableBlobCorpusSourceArtifacts(blobs);
  let failDelete = true;
  const flakyArtifacts: CorpusSourceArtifactPort = {
    put: (input) => inner.put(input),
    read: (input) => inner.read(input),
    delete: async (input) => {
      if (failDelete) {
        failDelete = false;
        return false;
      }
      return await inner.delete(input);
    },
  };
  const runtime = new DurableCorpusRuntime({
    repository: new DurableCorpusRepository(records),
    artifacts: flakyArtifacts,
    index,
    now: () => new Date("2026-09-05T08:00:00.000Z"),
    idFactory: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  const corpus = await runtime.createCorpus({ displayName: "Delete retry", callerExpiresAt: null }, caller);
  await runtime.enrollSource(corpus.corpusId, {
    content: "delete retry payload",
    acl: ["role:reader"],
    retentionPolicy: "operator-default",
    deletionPolicy: "on_owner_delete",
    citationProvenance: "normalized-text-v1",
    callerExpiresAt: null,
  }, caller);
  assert.deepEqual(await runtime.deleteCorpus(corpus.corpusId, caller), {
    derivedIndexDeleted: true,
    artifactDeleted: false,
    isComplete: false,
  });
  await assert.rejects(() => runtime.searchCorpus(corpus.corpusId, "payload", caller), /access is revoked/u);
  assert.deepEqual(await runtime.deleteCorpus(corpus.corpusId, caller), {
    derivedIndexDeleted: true,
    artifactDeleted: true,
    isComplete: true,
  });
  records.close();
  blobs.close();
  index.close();
});

void test("source removal keeps a durable tombstone until cleanup retry succeeds", async () => {
  const path = await statePath();
  const records = new SqliteDurableRecordStore(path, "corpora-v1");
  const blobs = new SqliteImmutableBlobStore(path, "corpus-source-blobs-v1");
  const index = new SqliteCorpusDerivedIndex(path, "corpus-index-v1");
  const inner = new ImmutableBlobCorpusSourceArtifacts(blobs);
  let failDelete = true;
  const runtime = new DurableCorpusRuntime({
    repository: new DurableCorpusRepository(records),
    index,
    artifacts: {
      put: (input) => inner.put(input),
      read: (input) => inner.read(input),
      delete: async (input) => {
        if (failDelete) {
          failDelete = false;
          return false;
        }
        return await inner.delete(input);
      },
    },
    now: () => new Date("2026-09-05T08:00:00.000Z"),
    idFactory: () => "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  });
  const corpus = await runtime.createCorpus({ displayName: "Remove retry", callerExpiresAt: null }, caller);
  const enrolled = await runtime.enrollSource(corpus.corpusId, {
    content: "revoked source must disappear before cleanup",
    acl: ["role:reader"],
    retentionPolicy: "operator-default",
    deletionPolicy: "on_owner_delete",
    citationProvenance: "normalized-text-v1",
    callerExpiresAt: null,
  }, caller);
  assert.deepEqual(await runtime.removeSource(corpus.corpusId, enrolled.sourceId, caller), {
    sourceId: enrolled.sourceId,
    lifecycle: "removed",
    cleanupComplete: false,
  });
  assert.equal((await runtime.searchCorpus(corpus.corpusId, "revoked", caller)).results.length, 0);
  assert.match(
    (await runtime.corpusStatus(corpus.corpusId, caller)).manifest.sources[0]?.lifecycleProvenance ?? "",
    /^revoked:cleanup-pending:/u,
  );
  assert.equal((await runtime.removeSource(corpus.corpusId, enrolled.sourceId, caller)).cleanupComplete, true);
  assert.equal((await runtime.corpusStatus(corpus.corpusId, caller)).manifest.sources.length, 0);
  records.close();
  blobs.close();
  index.close();
});

void test("durable corpus rejects a different credential binding without disclosing data", async () => {
  const path = await statePath();
  const opened = openRuntime(path);
  const corpus = await opened.runtime.createCorpus({ displayName: "Bound", callerExpiresAt: null }, caller);
  await assert.rejects(() => opened.runtime.corpusStatus(corpus.corpusId, {
    ...caller,
    credentialBinding: "managed:credential-b",
  }), /ownership or credential binding mismatch/u);
  opened.records.close();
  opened.blobs.close();
  opened.index.close();
});

void test("durable corpus enforces tenant, ACL, and logical source expiry from manifest truth", async () => {
  const path = await statePath();
  let nowMs = Date.parse("2026-09-05T08:00:00.000Z");
  const opened = openRuntime(path, undefined, () => new Date(nowMs));
  const corpus = await opened.runtime.createCorpus({ displayName: "Scoped", callerExpiresAt: null }, caller);
  await opened.runtime.enrollSource(corpus.corpusId, {
    content: "tenant acl expiry evidence",
    acl: ["role:reader"],
    retentionPolicy: "operator-default",
    deletionPolicy: "on_owner_delete",
    citationProvenance: "normalized-text-v1",
    callerExpiresAt: "2026-09-05T08:00:01.000Z",
  }, caller);

  assert.equal((await opened.runtime.searchCorpus(corpus.corpusId, "evidence", caller)).results.length, 1);
  assert.equal((await opened.runtime.searchCorpus(corpus.corpusId, "evidence", {
    ...caller,
    roles: ["role:other"],
  })).results.length, 0);
  await assert.rejects(() => opened.runtime.corpusStatus(corpus.corpusId, {
    ...caller,
    tenantId: "deployment-b",
  }), /ownership or credential binding mismatch/u);

  nowMs += 1_001;
  assert.equal((await opened.runtime.searchCorpus(corpus.corpusId, "evidence", caller)).results.length, 0);
  assert.equal((await opened.runtime.corpusStatus(corpus.corpusId, caller)).enrolledCount, 0);
  opened.records.close();
  opened.blobs.close();
  opened.index.close();
});
