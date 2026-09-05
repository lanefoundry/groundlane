import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { DurableArtifactRepository } from "../../src/core/durable-artifacts.js";
import { MAX_DURABLE_METADATA_BYTES } from "../../src/core/durable-store.js";
import { D1DurableRecordStore } from "../../src/worker/d1-durable-store.js";
import { R2ImmutableBlobStore } from "../../src/worker/r2-immutable-blob.js";
import { FakeD1, FakeR2 } from "../support/document-output-bindings.js";

const caller = { tenantId: "cloudflare", ownerId: "owner", credentialBinding: "private-binding" };
const hash = (bytes: Uint8Array): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

void test("large canonical ArtifactRef stores only bounded metadata in D1 and survives native adapter recreation", async () => {
  const db = new FakeD1();
  const bucket = new FakeR2();
  const records = () => new D1DurableRecordStore(db, "prd738-artifacts");
  const repository = () => new DurableArtifactRepository(records(), new R2ImmutableBlobStore(bucket));
  const marker = "PRIVATE_CANONICAL_DOCUMENT_CONTENT_";
  const bytes = Buffer.from(JSON.stringify({ text: marker.repeat(10_000) }));
  assert.ok(bytes.byteLength > MAX_DURABLE_METADATA_BYTES);
  const created = await repository().put({ ...caller, refId: "canonical-large", bytes,
    contentHash: hash(bytes), nowMs: 100, expiresAt: 10_000, verification: "verified",
    retentionPolicy: "bounded", deletionPolicy: "on_expiry",
    details: { kind: "canonical", sourceRefId: "source-input", documentSchemaVersion: "1" },
  });
  assert.equal(created.record.metadata.byteSize, bytes.byteLength);
  assert.equal(created.record.metadata.contentHash, hash(bytes));
  assert.equal(created.record.metadata.tenantId, caller.tenantId);
  assert.equal(created.record.metadata.expiresAt, 10_000);
  assert.equal(JSON.stringify(created.record).includes(caller.credentialBinding), false);
  for (const row of db.rows.values()) {
    assert.equal(typeof row.value, "string");
    assert.ok(Buffer.byteLength(String(row.value)) <= MAX_DURABLE_METADATA_BYTES);
    assert.equal(String(row.value).includes(marker), false);
  }
  assert.equal(bucket.objects.size, 1);
  assert.deepEqual(Buffer.from(await repository().readVerified("canonical-large", caller, 200, bytes.byteLength)), bytes);
  for (const other of [{ ...caller, tenantId: "another" }, { ...caller, ownerId: "another" },
    { ...caller, credentialBinding: "another" }]) {
    await assert.rejects(repository().readVerified("canonical-large", other, 200, bytes.byteLength));
  }
  await assert.rejects(records().createIfAbsent({ key: "accidental-inline-bytes", value: bytes.toString(), nowMs: 200 }), /64 KiB/u);
  assert.equal(await records().get("accidental-inline-bytes"), null);

  const revoked = await repository().deleteExplicit("canonical-large", caller, created.record.revision, 300);
  assert.equal(revoked.status, "updated");
  if (revoked.status !== "updated") throw new Error("Expected revocation");
  const pending = await repository().markCleanupPending("canonical-large", caller, revoked.record.revision, 300);
  if (pending.status !== "updated") throw new Error("Expected cleanup pending");
  bucket.failDelete = true;
  await assert.rejects(repository().cleanupPending("canonical-large", caller, pending.record.revision));
  await assert.rejects(repository().readVerified("canonical-large", caller, 400, bytes.byteLength));
  assert.equal(bucket.objects.size, 1);
  bucket.failDelete = false;
  assert.equal(await repository().cleanupPending("canonical-large", caller, pending.record.revision), "deleted");
  assert.equal(bucket.objects.size, 0);
  assert.equal(await repository().getForCaller("canonical-large", caller), null);
});
