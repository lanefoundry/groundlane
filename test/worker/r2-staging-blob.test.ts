import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_R2_STAGING_BLOB_BYTES,
  R2StagingBlobStore,
  type R2StagingBlobBinding,
} from "../../src/worker/r2-staging-blob.js";
import type {
  R2BucketLike,
  R2ObjectBodyLike,
  R2ObjectLike,
} from "../../src/worker/r2-immutable-blob.js";

class FakeR2 implements R2BucketLike {
  readonly objects = new Map<string, {
    bytes: Uint8Array;
    metadata: Record<string, string>;
  }>();
  mutateAfterListKey: string | null = null;
  failDeleteOnce = false;

  head(key: string): Promise<R2ObjectLike | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : {
      size: object.bytes.byteLength,
      customMetadata: { ...object.metadata },
    });
  }

  get(key: string): Promise<R2ObjectBodyLike | null> {
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
    options: {
      onlyIf: { etagDoesNotMatch: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<R2ObjectLike | null> {
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.objects.has(key)) return Promise.resolve(null);
    this.objects.set(key, {
      bytes: value.slice(),
      metadata: { ...options.customMetadata },
    });
    return this.head(key);
  }

  delete(key: string): Promise<void> {
    if (this.failDeleteOnce) {
      this.failDeleteOnce = false;
      return Promise.reject(new Error("temporary R2 delete failure"));
    }
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(options: { prefix?: string; cursor?: string; limit?: number; include?: ("httpMetadata" | "customMetadata")[] }): Promise<{
    objects: Array<{ key: string; size: number; customMetadata: Record<string, string> }>;
    truncated: boolean;
    cursor?: string | undefined;
  }> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? "") && key > (options.cursor ?? "")).sort();
    const page = keys.slice(0, options.limit ?? 1_000);
    const result = {
      objects: page.map((key) => {
        const value = this.objects.get(key);
        assert.ok(value !== undefined);
        return { key, size: value.bytes.byteLength, customMetadata: { ...value.metadata } };
      }),
      truncated: keys.length > (options.limit ?? 1_000),
      ...(keys.length > (options.limit ?? 1_000) ? { cursor: page.at(-1) } : {}),
    };
    if (this.mutateAfterListKey !== null) {
      const current = this.objects.get(this.mutateAfterListKey);
      if (current !== undefined) {
        this.objects.set(this.mutateAfterListKey, {
          ...current,
          metadata: {
            ...current.metadata,
            "owner-id": "changed-owner",
            "credential-binding-hash": `sha256-${"f".repeat(64)}`,
          },
        });
      }
      this.mutateAfterListKey = null;
    }
    return Promise.resolve(result);
  }
}

const bytes = new TextEncoder().encode("staging artifact bytes");
const binding: R2StagingBlobBinding = {
  stagingKey: `staging/${"a".repeat(48)}`,
  intentId: "upl_intent-one",
  ownerId: "owner",
  credentialBinding: "managed:credential-secret",
  declaredMime: "text/plain",
  declaredSize: bytes.byteLength,
  expiresAt: 1_800_000_060_000,
};

void test("R2 staging adapter creates conditionally and safely recognizes an exact replay", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);

  const first = await store.putOnce({ ...binding, bytes });
  const replay = await store.putOnce({ ...binding, bytes });

  assert.equal(first.status, "created");
  assert.equal(replay.status, "exists");
  assert.deepEqual(await store.get({ ...binding, nowMs: binding.expiresAt - 1 }), bytes);
  const stored = bucket.objects.get(binding.stagingKey);
  assert.ok(stored !== undefined);
  assert.equal(stored.metadata.credentialBinding, undefined);
  assert.match(stored.metadata["credential-binding-hash"] ?? "", /^sha256-[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(stored.metadata), /credential-secret/u);
});

void test("R2 staging adapter reports a collision when replay bindings differ", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);
  await store.putOnce({ ...binding, bytes });

  const otherBytes = new TextEncoder().encode("other staging content");
  const conflict = await store.putOnce({
    ...binding,
    intentId: "upl_other",
    declaredSize: otherBytes.byteLength,
    bytes: otherBytes,
  });
  assert.equal(conflict.status, "conflict");

  for (const mismatch of [
    { ...binding, intentId: "upl_other" },
    { ...binding, ownerId: "other-owner" },
    { ...binding, credentialBinding: "managed:other" },
    { ...binding, declaredMime: "application/pdf" },
    { ...binding, declaredSize: binding.declaredSize - 1 },
    { ...binding, expiresAt: binding.expiresAt + 1 },
  ]) {
    await assert.rejects(
      store.get({ ...mismatch, nowMs: binding.expiresAt - 1 }),
      /binding mismatch/u,
    );
  }
});

void test("R2 staging adapter enforces expiry and exact bounded sizes", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);
  await store.putOnce({ ...binding, bytes });

  await assert.rejects(
    store.get({ ...binding, nowMs: binding.expiresAt }),
    /expired/u,
  );
  await assert.rejects(
    store.putOnce({ ...binding, declaredSize: bytes.byteLength + 1, bytes }),
    /declared size/u,
  );
  await assert.rejects(
    store.putOnce({
      ...binding,
      stagingKey: `staging/${"b".repeat(48)}`,
      declaredSize: MAX_R2_STAGING_BLOB_BYTES + 1,
      bytes,
    }),
    /supported bounds/u,
  );
});

void test("R2 staging adapter detects metadata, byte, and digest corruption", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);
  await store.putOnce({ ...binding, bytes });
  const stored = bucket.objects.get(binding.stagingKey);
  assert.ok(stored !== undefined);

  stored.bytes = new TextEncoder().encode("X".repeat(bytes.byteLength));
  await assert.rejects(
    store.get({ ...binding, nowMs: binding.expiresAt - 1 }),
    /integrity check/u,
  );

  stored.bytes = bytes.slice();
  stored.metadata.digest = "sha256-not-a-digest";
  await assert.rejects(
    store.get({ ...binding, nowMs: binding.expiresAt - 1 }),
    /metadata is malformed/u,
  );
});

void test("R2 staging adapter verifies a presigned upload without a caller-supplied digest", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);
  const credentialHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(binding.credentialBinding),
  );
  bucket.objects.set(binding.stagingKey, {
    bytes: bytes.slice(),
    metadata: {
      "schema-version": "1",
      kind: "staging",
      "intent-id": binding.intentId,
      "owner-id": binding.ownerId,
      "credential-binding-hash": `sha256-${[...new Uint8Array(credentialHash)].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
      "declared-mime": binding.declaredMime,
      "declared-size": String(binding.declaredSize),
      "expires-at": String(binding.expiresAt),
    },
  });
  assert.deepEqual(await store.get({ ...binding, nowMs: binding.expiresAt - 1 }), bytes);
});

void test("R2 staging adapter deletes only for the matching intent", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);
  assert.equal(await store.deleteIfIntent(binding.stagingKey, binding.intentId), "missing");

  await store.putOnce({ ...binding, bytes });
  assert.equal(await store.deleteIfIntent(binding.stagingKey, "upl_other"), "intent_mismatch");
  assert.ok(bucket.objects.has(binding.stagingKey));
  assert.equal(await store.deleteIfIntent(binding.stagingKey, binding.intentId), "deleted");
  assert.equal(await store.deleteIfIntent(binding.stagingKey, binding.intentId), "missing");
});

void test("expired staging cleanup is bounded, cursor-safe, and fails closed on malformed metadata", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);
  for (const suffix of ["a", "b", "c"]) {
    await store.putOnce({
      ...binding,
      stagingKey: `staging/${suffix.repeat(48)}`,
      intentId: `upl_${suffix}`,
      bytes,
    });
  }
  const malformedKey = `staging/${"d".repeat(48)}`;
  bucket.objects.set(malformedKey, {
    bytes: bytes.slice(),
    metadata: { kind: "staging", "expires-at": String(binding.expiresAt) },
  });

  const first = await store.cleanupExpiredPage(binding.expiresAt, null, 2);
  assert.equal(first.scanned, 2);
  assert.equal(first.deleted, 2);
  assert.equal(first.failures.length, 0);
  assert.ok(first.nextCursor !== null);
  const second = await store.cleanupExpiredPage(binding.expiresAt, first.nextCursor, 2);
  assert.equal(second.deleted, 1);
  assert.deepEqual(second.failures, [malformedKey]);
  assert.equal(second.nextCursor, null);
  assert.ok(bucket.objects.has(malformedKey), "malformed metadata must never be deleted");
});

void test("staging cleanup retries delete failures and rejects owner or credential metadata drift", async () => {
  const bucket = new FakeR2();
  const store = new R2StagingBlobStore(bucket);
  await store.putOnce({ ...binding, bytes });
  bucket.failDeleteOnce = true;
  const failed = await store.cleanupExpiredPage(binding.expiresAt, null, 10);
  assert.equal(failed.deleted, 0);
  assert.deepEqual(failed.failures, [binding.stagingKey]);
  assert.ok(bucket.objects.has(binding.stagingKey));
  const retried = await store.cleanupExpiredPage(binding.expiresAt, null, 10);
  assert.equal(retried.deleted, 1);
  assert.equal(bucket.objects.size, 0);

  await store.putOnce({ ...binding, bytes });
  bucket.mutateAfterListKey = binding.stagingKey;
  const mismatch = await store.cleanupExpiredPage(binding.expiresAt, null, 10);
  assert.equal(mismatch.deleted, 0);
  assert.deepEqual(mismatch.failures, [binding.stagingKey]);
  assert.ok(bucket.objects.has(binding.stagingKey));
});
