import assert from "node:assert/strict";
import test from "node:test";

import { R2PresignedPutHandoff } from "../../src/worker/r2-presigned-put.js";

const handoff = new R2PresignedPutHandoff({
  accountId: "0123456789abcdef0123456789abcdef",
  bucketName: "groundlane-artifacts",
  accessKeyId: "public-access-key-id",
  secretAccessKey: "never-return-this-secret",
});

void test("R2 handoff signs one bounded conditional PUT without exposing the secret", async () => {
  const result = await handoff.create({
    stagingKey: "staging/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    contentType: "application/pdf",
    contentLength: 12,
    expiresInSeconds: 900,
    metadata: {
      intentId: "upl_123",
      ownerId: "owner-a",
      credentialHash: "b".repeat(64),
      expiresAt: 1_800_000,
    },
    signingDate: new Date("2026-09-05T00:00:00.000Z"),
  });
  assert.equal(result.method, "PUT");
  assert.equal(result.headers["content-type"], "application/pdf");
  assert.equal(result.headers["content-length"], "12");
  assert.equal(result.headers["if-none-match"], "*");
  assert.match(result.url, /^https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/groundlane-artifacts\/staging\//u);
  assert.match(result.url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/u);
  assert.match(result.url, /X-Amz-Expires=900/u);
  assert.match(result.url, /X-Amz-SignedHeaders=/u);
  assert.doesNotMatch(JSON.stringify(result), /never-return-this-secret/u);
  assert.doesNotMatch(JSON.stringify(result), /managed:credential-a/u);
});

void test("R2 handoff rejects unsafe keys, unbounded expiry, and malformed metadata", async () => {
  const base = {
    stagingKey: "staging/" + "a".repeat(64),
    contentType: "application/pdf",
    contentLength: 12,
    expiresInSeconds: 900,
    metadata: {
      intentId: "upl_123",
      ownerId: "owner-a",
      credentialHash: "b".repeat(64),
      expiresAt: 1_800_000,
    },
  } as const;
  await assert.rejects(handoff.create({ ...base, stagingKey: "../secret" }), /staging key/u);
  await assert.rejects(handoff.create({ ...base, expiresInSeconds: 3_601 }), /expiry/u);
  await assert.rejects(handoff.create({
    ...base,
    metadata: { ...base.metadata, credentialHash: "managed:credential-a" },
  }), /credential hash/u);
});
