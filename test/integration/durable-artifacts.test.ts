import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import {
  DurableArtifactRepository,
  type DurableArtifactDetails,
  type PutDurableArtifactInput,
} from "../../src/core/durable-artifacts.js";
import type {
  ImmutableBlobPort,
  ImmutableBlobPutResult,
  ImmutableBlobStat,
} from "../../src/core/immutable-blob.js";

class FakeImmutableBlobStore implements ImmutableBlobPort {
  readonly objects = new Map<string, { ownerId: string; digest: string; bytes: Uint8Array }>();

  putIfAbsent(input: { blobKey: string; ownerId: string; digest: string; bytes: Uint8Array }): Promise<ImmutableBlobPutResult> {
    const existing = this.objects.get(input.blobKey);
    if (existing !== undefined) {
      const stat = this.toStat(input.blobKey, existing);
      return Promise.resolve(existing.ownerId === input.ownerId && existing.digest === input.digest && existing.bytes.byteLength === input.bytes.byteLength
        ? { status: "exists", stat }
        : { status: "conflict", stat });
    }
    const stored = { ownerId: input.ownerId, digest: input.digest, bytes: input.bytes.slice() };
    this.objects.set(input.blobKey, stored);
    return Promise.resolve({ status: "created", stat: this.toStat(input.blobKey, stored) });
  }

  stat(blobKey: string): Promise<ImmutableBlobStat | null> {
    const value = this.objects.get(blobKey);
    return Promise.resolve(value === undefined ? null : this.toStat(blobKey, value));
  }

  get(input: { blobKey: string; ownerId: string; digest: string; maxBytes: number }): Promise<Uint8Array | null> {
    const value = this.objects.get(input.blobKey);
    if (value === undefined) return Promise.resolve(null);
    if (value.ownerId !== input.ownerId || value.digest !== input.digest) {
      return Promise.reject(new Error("immutable blob owner or digest mismatch"));
    }
    if (value.bytes.byteLength > input.maxBytes) return Promise.reject(new Error("immutable blob exceeds read limit"));
    return Promise.resolve(value.bytes.slice());
  }

  deleteIfOwner(blobKey: string, ownerId: string): Promise<"deleted" | "missing" | "owner_mismatch"> {
    const value = this.objects.get(blobKey);
    if (value === undefined) return Promise.resolve("missing");
    if (value.ownerId !== ownerId) return Promise.resolve("owner_mismatch");
    this.objects.delete(blobKey);
    return Promise.resolve("deleted");
  }

  private toStat(blobKey: string, value: { ownerId: string; digest: string; bytes: Uint8Array }): ImmutableBlobStat {
    return { blobKey, ownerId: value.ownerId, digest: value.digest, byteSize: value.bytes.byteLength };
  }
}

async function fixture(t: test.TestContext): Promise<{ path: string; blobs: FakeImmutableBlobStore }> {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { path: join(directory, "artifacts.sqlite"), blobs: new FakeImmutableBlobStore() };
}

function artifactInput(
  refId: string,
  details: DurableArtifactDetails,
  overrides: Partial<PutDurableArtifactInput> = {},
): PutDurableArtifactInput {
  const bytes = new TextEncoder().encode(`bytes:${refId}`);
  return {
    refId,
    ownerId: "owner-a",
    contentHash: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
    expiresAt: 10_000,
    bytes,
    verification: "verified",
    details,
    nowMs: 100,
    ...overrides,
  };
}

void test("source, canonical, and projection metadata survive a SQLite restart", async (t) => {
  const { path, blobs } = await fixture(t);
  const firstStore = new SqliteDurableRecordStore(path, "artifacts");
  const first = new DurableArtifactRepository(firstStore, blobs);
  await first.put(artifactInput("source-1", { kind: "source", mediaType: "application/pdf", filename: "source.pdf" }));
  await first.put(artifactInput("canonical-1", { kind: "canonical", sourceRefId: "source-1", documentSchemaVersion: "1" }));
  await first.put(artifactInput("projection-1", { kind: "projection", canonicalRefId: "canonical-1", format: "markdown" }));
  firstStore.close();

  const reopenedStore = new SqliteDurableRecordStore(path, "artifacts");
  t.after(() => reopenedStore.close());
  const reopened = new DurableArtifactRepository(reopenedStore, blobs);
  assert.equal((await reopened.get("source-1"))?.metadata.details.kind, "source");
  assert.equal((await reopened.get("canonical-1"))?.metadata.details.kind, "canonical");
  assert.equal((await reopened.get("projection-1"))?.metadata.details.kind, "projection");
  assert.deepEqual(await reopened.readVerified("projection-1", "owner-a", 200, 1024), new TextEncoder().encode("bytes:projection-1"));
});

void test("pending bytes are unreadable until blob verification wins its CAS", async (t) => {
  const { path, blobs } = await fixture(t);
  const leftStore = new SqliteDurableRecordStore(path, "artifacts");
  const rightStore = new SqliteDurableRecordStore(path, "artifacts");
  t.after(() => { leftStore.close(); rightStore.close(); });
  const left = new DurableArtifactRepository(leftStore, blobs);
  const right = new DurableArtifactRepository(rightStore, blobs);
  const created = await left.put(artifactInput("pending-1", { kind: "source", mediaType: "text/plain", filename: "pending.txt" }, { verification: "pending" }));
  await assert.rejects(left.readVerified("pending-1", "owner-a", 200, 1024), /not verified/u);

  const verified = await left.markVerified("pending-1", "owner-a", created.record.revision, 300);
  assert.equal(verified.status, "updated");
  const stale = await right.markVerified("pending-1", "owner-a", created.record.revision, 301);
  assert.equal(stale.status, "conflict");
  assert.deepEqual(await right.readVerified("pending-1", "owner-a", 400, 1024), new TextEncoder().encode("bytes:pending-1"));
});

void test("logical expiry is distinct from cleanup pending and physical deletion", async (t) => {
  const { path, blobs } = await fixture(t);
  const store = new SqliteDurableRecordStore(path, "artifacts");
  t.after(() => store.close());
  const repository = new DurableArtifactRepository(store, blobs);
  const created = await repository.put(artifactInput("expiry-1", { kind: "source", mediaType: "text/plain", filename: "expiry.txt" }, { expiresAt: 500 }));
  const blobKey = created.record.metadata.blobKey;

  const page = await repository.expireDue(500, null, 10);
  assert.equal(page.expired[0]?.metadata.status, "logically_expired");
  assert.ok(blobs.objects.has(blobKey));
  await assert.rejects(repository.readVerified("expiry-1", "owner-a", 500, 1024), /expired/u);

  const pending = await repository.markCleanupPending("expiry-1", "owner-a", page.expired[0]?.revision ?? 0, 600);
  assert.equal(pending.status, "updated");
  assert.ok(blobs.objects.has(blobKey));
  assert.equal(await repository.cleanupPending("expiry-1", "owner-a", pending.status === "updated" ? pending.record.revision : 0), "deleted");
  assert.equal(blobs.objects.has(blobKey), false);
  assert.equal(await repository.get("expiry-1"), null);
});

void test("explicit delete revokes immediately and owner-wide deletion skips foreign refs", async (t) => {
  const { path, blobs } = await fixture(t);
  const store = new SqliteDurableRecordStore(path, "artifacts");
  t.after(() => store.close());
  const repository = new DurableArtifactRepository(store, blobs);
  const owned = await repository.put(artifactInput("owned-1", { kind: "source", mediaType: "text/plain", filename: "owned.txt" }));
  await repository.put(artifactInput("foreign-1", { kind: "source", mediaType: "text/plain", filename: "foreign.txt" }, { ownerId: "owner-b" }));

  const deleted = await repository.deleteExplicit("owned-1", "owner-a", owned.record.revision, 200);
  assert.equal(deleted.status, "updated");
  await assert.rejects(repository.readVerified("owned-1", "owner-a", 201, 1024), /revoked/u);
  assert.ok(blobs.objects.has(owned.record.metadata.blobKey));

  const ownerDelete = await repository.deleteOwnerArtifacts("owner-a", ["foreign-1"], 300);
  assert.deepEqual(ownerDelete, { revoked: [], skipped: ["foreign-1"] });
  assert.deepEqual(await repository.readVerified("foreign-1", "owner-b", 301, 1024), new TextEncoder().encode("bytes:foreign-1"));
});

void test("physical cleanup refuses a blob whose owner metadata no longer matches", async (t) => {
  const { path, blobs } = await fixture(t);
  const store = new SqliteDurableRecordStore(path, "artifacts");
  t.after(() => store.close());
  const repository = new DurableArtifactRepository(store, blobs);
  const created = await repository.put(artifactInput("orphan-safe", { kind: "source", mediaType: "text/plain", filename: "safe.txt" }));
  const deleted = await repository.deleteExplicit("orphan-safe", "owner-a", created.record.revision, 200);
  assert.equal(deleted.status, "updated");
  const pending = await repository.markCleanupPending("orphan-safe", "owner-a", deleted.status === "updated" ? deleted.record.revision : 0, 300);
  assert.equal(pending.status, "updated");
  const object = blobs.objects.get(created.record.metadata.blobKey);
  assert.ok(object !== undefined);
  blobs.objects.set(created.record.metadata.blobKey, { ...object, ownerId: "owner-b" });

  assert.equal(await repository.cleanupPending("orphan-safe", "owner-a", pending.status === "updated" ? pending.record.revision : 0), "owner_mismatch");
  assert.ok(blobs.objects.has(created.record.metadata.blobKey));
  assert.equal((await repository.get("orphan-safe"))?.metadata.status, "physical_cleanup_pending");
});

void test("refId conflicts remove only the new orphan blob and preserve the original", async (t) => {
  const { path, blobs } = await fixture(t);
  const store = new SqliteDurableRecordStore(path, "artifacts");
  t.after(() => store.close());
  const repository = new DurableArtifactRepository(store, blobs);
  const original = await repository.put(artifactInput("stable-ref", { kind: "source", mediaType: "text/plain", filename: "original.txt" }));
  const replacementBytes = new TextEncoder().encode("replacement bytes");
  const replacementHash = `sha256-${createHash("sha256").update(replacementBytes).digest("hex")}`;

  await assert.rejects(
    repository.put(artifactInput("stable-ref", { kind: "source", mediaType: "text/plain", filename: "replacement.txt" }, {
      bytes: replacementBytes,
      contentHash: replacementHash,
    })),
    /different metadata/u,
  );
  assert.equal(blobs.objects.size, 1);
  assert.ok(blobs.objects.has(original.record.metadata.blobKey));
  assert.deepEqual(await repository.readVerified("stable-ref", "owner-a", 200, 1024), new TextEncoder().encode("bytes:stable-ref"));
});
