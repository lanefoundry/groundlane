import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  R2ImmutableBlobStore,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
} from "../../src/worker/r2-immutable-blob.js";

class FakeR2 implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();

  head(key: string): Promise<R2ObjectLike | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : { size: object.bytes.byteLength, customMetadata: { ...object.metadata } });
  }

  get(key: string): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    if (object === undefined) return Promise.resolve(null);
    return Promise.resolve({ size: object.bytes.byteLength, customMetadata: { ...object.metadata }, bytes: () => Promise.resolve(object.bytes.slice()) });
  }

  put(key: string, value: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string> }): Promise<R2ObjectLike | null> {
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.objects.has(key)) return Promise.resolve(null);
    this.objects.set(key, { bytes: value.slice(), metadata: { ...options.customMetadata } });
    return this.head(key);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

const bytes = new TextEncoder().encode("immutable artifact bytes");
const digest = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
const blobKey = `blobs/${createHash("sha256").update("internal-key").digest("hex")}`;

void test("R2 immutable adapter creates once and reuses identical content", async () => {
  const bucket = new FakeR2();
  const store = new R2ImmutableBlobStore(bucket);
  const first = await store.putIfAbsent({ blobKey, ownerId: "owner", digest, bytes });
  assert.equal(first.status, "created");
  const replay = await store.putIfAbsent({ blobKey, ownerId: "owner", digest, bytes });
  assert.equal(replay.status, "exists");
  assert.deepEqual(await store.get({ blobKey, ownerId: "owner", digest, maxBytes: 1024 }), bytes);
});

void test("R2 immutable adapter rejects collision, cross-owner read, and wrong digest", async () => {
  const bucket = new FakeR2();
  const store = new R2ImmutableBlobStore(bucket);
  await store.putIfAbsent({ blobKey, ownerId: "owner", digest, bytes });
  const otherBytes = new TextEncoder().encode("different");
  const otherDigest = `sha256-${createHash("sha256").update(otherBytes).digest("hex")}`;
  const conflict = await store.putIfAbsent({ blobKey, ownerId: "owner", digest: otherDigest, bytes: otherBytes });
  assert.equal(conflict.status, "conflict");
  await assert.rejects(store.get({ blobKey, ownerId: "other", digest, maxBytes: 1024 }), /owner or digest mismatch/u);
  await assert.rejects(store.putIfAbsent({ blobKey: `blobs/${"a".repeat(64)}`, ownerId: "owner", digest, bytes: otherBytes }), /digest mismatch/u);
});

void test("R2 immutable adapter deletes only for the owning principal", async () => {
  const bucket = new FakeR2();
  const store = new R2ImmutableBlobStore(bucket);
  await store.putIfAbsent({ blobKey, ownerId: "owner", digest, bytes });
  assert.equal(await store.deleteIfOwner(blobKey, "other"), "owner_mismatch");
  assert.equal(await store.deleteIfOwner(blobKey, "owner"), "deleted");
  assert.equal(await store.deleteIfOwner(blobKey, "owner"), "missing");
});

void test("R2 immutable adapter fails closed on malformed metadata and size caps", async () => {
  const bucket = new FakeR2();
  bucket.objects.set(blobKey, { bytes, metadata: { ownerId: "owner", digest } });
  const store = new R2ImmutableBlobStore(bucket);
  await assert.rejects(store.stat(blobKey), /metadata is malformed/u);
  bucket.objects.set(blobKey, { bytes, metadata: { schemaVersion: "1", ownerId: "owner", digest } });
  await assert.rejects(store.get({ blobKey, ownerId: "owner", digest, maxBytes: 2 }), /read limit/u);
});
