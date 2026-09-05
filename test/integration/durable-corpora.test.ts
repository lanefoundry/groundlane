import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { DurableCorpusRepository, type DurableCorpusBinding } from "../../src/core/durable-corpora.js";
import type { CorpusManifest } from "../../src/core/corpus-contract.js";

const binding: DurableCorpusBinding = { tenantId: "tenant-a", ownerId: "owner-a", credentialBinding: "managed:cred-a" };

function manifest(corpusId: string, sources: readonly string[], updatedAt = "2026-09-05T00:00:00.000Z"): CorpusManifest {
  return {
    corpusId,
    updatedAt,
    sources: sources.map((sourceId) => ({
      sourceId,
      contentHash: `sha256-${sourceId}`,
      acl: ["role:reader"],
      retentionPolicy: "persistent",
      deletionPolicy: "delete_with_corpus",
      lifecycleProvenance: "explicit_enroll",
      citationProvenance: `source:${sourceId}`,
      backendProvenance: "fake-index-v1",
    })),
  };
}

async function fixture(t: test.TestContext): Promise<{ path: string; store: SqliteDurableRecordStore }> {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-corpus-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { path: join(directory, "state.sqlite"), store: new SqliteDurableRecordStore(join(directory, "state.sqlite"), "corpora") };
}

void test("durable corpus manifest survives process-style close and reopen", async (t) => {
  const { path, store } = await fixture(t);
  const repository = new DurableCorpusRepository(store);
  const created = await repository.create({
    ...binding, corpusId: "corpus-a", displayName: "Research", manifest: manifest("corpus-a", ["source-a"]),
    nowMs: 100, expiresAt: 1000,
  });
  assert.equal(created.status, "created");
  store.close();
  const reopened = new SqliteDurableRecordStore(path, "corpora");
  t.after(() => reopened.close());
  const restored = await new DurableCorpusRepository(reopened).get("corpus-a", binding, 200);
  assert.deepEqual(restored?.record.manifest.sources.map((source) => source.sourceId), ["source-a"]);
  assert.equal(restored?.revision, 1);
});

void test("concurrent corpus create is idempotent and rejects ownership replay", async (t) => {
  const { path, store: leftStore } = await fixture(t);
  const rightStore = new SqliteDurableRecordStore(path, "corpora");
  t.after(() => { leftStore.close(); rightStore.close(); });
  const input = { ...binding, corpusId: "corpus-idempotent", displayName: "Corpus", manifest: manifest("corpus-idempotent", []), nowMs: 100 };
  const results = await Promise.all([
    new DurableCorpusRepository(leftStore).create(input),
    new DurableCorpusRepository(rightStore).create(input),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["created", "exists"]);
  await assert.rejects(
    new DurableCorpusRepository(leftStore).create({ ...input, ownerId: "other" }),
    /ownership or credential binding mismatch/u,
  );
});

void test("manifest CAS fences stale writers and preserves the truth source", async (t) => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  const repository = new DurableCorpusRepository(store);
  const created = await repository.create({ ...binding, corpusId: "corpus-cas", displayName: "Corpus", manifest: manifest("corpus-cas", []), nowMs: 100 });
  const updated = await repository.update("corpus-cas", binding, created.view.revision, {
    manifest: manifest("corpus-cas", ["source-a"], "2026-09-05T00:01:00.000Z"),
    state: "active", deletion: created.view.record.deletion, nowMs: 200,
  });
  assert.equal(updated.revision, 2);
  await assert.rejects(repository.update("corpus-cas", binding, 1, {
    manifest: manifest("corpus-cas", ["stale"]), state: "active", deletion: created.view.record.deletion, nowMs: 300,
  }), /revision conflict/u);
  assert.deepEqual((await repository.get("corpus-cas", binding, 300))?.record.manifest.sources.map((source) => source.sourceId), ["source-a"]);
});

void test("delete state revokes access immediately and only completes with both cleanups", async (t) => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  const repository = new DurableCorpusRepository(store);
  const created = await repository.create({ ...binding, corpusId: "corpus-delete", displayName: "Corpus", manifest: manifest("corpus-delete", ["source-a"]), nowMs: 100 });
  const deleting = await repository.update("corpus-delete", binding, 1, {
    manifest: created.view.record.manifest, state: "deleting",
    deletion: { derivedIndexDeleted: true, artifactDeleted: false, isComplete: false }, nowMs: 200,
  });
  await assert.rejects(repository.get("corpus-delete", binding, 201), /access is revoked/u);
  await assert.rejects(repository.update("corpus-delete", binding, deleting.revision, {
    manifest: deleting.record.manifest, state: "deleted",
    deletion: { derivedIndexDeleted: true, artifactDeleted: false, isComplete: true }, nowMs: 300,
  }), /Deletion cannot be reported as complete/u);
  const deleted = await repository.update("corpus-delete", binding, deleting.revision, {
    manifest: deleting.record.manifest, state: "deleted",
    deletion: { derivedIndexDeleted: true, artifactDeleted: true, isComplete: true }, nowMs: 300,
  });
  assert.equal(deleted.record.state, "deleted");
  await assert.rejects(repository.update("corpus-delete", binding, deleted.revision, {
    manifest: deleted.record.manifest, state: "active", deletion: deleted.record.deletion, nowMs: 400,
  }), /terminal/u);
});

void test("tenant, owner, credential, expiry, and malformed manifest boundaries fail closed", async (t) => {
  const { store } = await fixture(t);
  t.after(() => store.close());
  const repository = new DurableCorpusRepository(store);
  await repository.create({ ...binding, corpusId: "corpus-boundary", displayName: "Corpus", manifest: manifest("corpus-boundary", []), nowMs: 100, expiresAt: 200 });
  for (const mismatch of [
    { ...binding, tenantId: "other" }, { ...binding, ownerId: "other" }, { ...binding, credentialBinding: "managed:other" },
  ]) await assert.rejects(repository.get("corpus-boundary", mismatch, 150), /binding mismatch/u);
  await assert.rejects(repository.get("corpus-boundary", binding, 200), /expired/u);
  await assert.rejects(repository.create({
    ...binding, corpusId: "corpus-duplicate", displayName: "Corpus",
    manifest: manifest("corpus-duplicate", ["same", "same"]), nowMs: 100,
  }), /duplicate source IDs/u);
});
