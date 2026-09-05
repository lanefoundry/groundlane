import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryDurableRecordStore } from "../../src/core/durable-store.js";
import { documentCacheBindingIdentity } from "../../src/core/document-cache-contract.js";
import type { AuthenticatedPrincipal } from "../../src/worker/auth.js";
import { maybeHandleEdgeArtifacts, maybePrepareArtifactParseRequest } from "../../src/worker/artifact-runtime.js";
import { R2ImmutableBlobStore, type R2BucketLike, type R2ObjectBodyLike, type R2ObjectLike } from "../../src/worker/r2-immutable-blob.js";
import type { R2PresignedPutInput } from "../../src/worker/r2-presigned-put.js";
import { R2StagingBlobStore } from "../../src/worker/r2-staging-blob.js";

class FakeR2 implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();

  head(key: string): Promise<R2ObjectLike | null> {
    const value = this.objects.get(key);
    return Promise.resolve(value === undefined ? null : { size: value.bytes.byteLength, customMetadata: { ...value.metadata } });
  }

  get(key: string): Promise<R2ObjectBodyLike | null> {
    const value = this.objects.get(key);
    return Promise.resolve(value === undefined ? null : {
      size: value.bytes.byteLength,
      customMetadata: { ...value.metadata },
      bytes: () => Promise.resolve(value.bytes.slice()),
    });
  }

  put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string> }): Promise<R2ObjectLike | null> {
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.objects.has(key)) return Promise.resolve(null);
    this.objects.set(key, { bytes: bytes.slice(), metadata: { ...options.customMetadata } });
    return this.head(key);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

const principal: AuthenticatedPrincipal = {
  principalId: "owner",
  authMethod: "static_bearer",
  scopes: ["mcp"],
};

function request(id: number, name: string, argumentsValue: Record<string, unknown>): Request {
  return new Request("https://groundlane.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argumentsValue } }),
  });
}

async function json(response: Response | undefined): Promise<Record<string, unknown>> {
  assert.ok(response !== undefined);
  return await response.json();
}

void test("Worker edge creates an idempotent presigned handoff and finalizes an opaque artifact", async () => {
  const bucket = new FakeR2();
  const records = new InMemoryDurableRecordStore();
  let signed: R2PresignedPutInput | undefined;
  const cacheRevocations: Array<{
    ownershipScope: string;
    sourceIdentity: string;
    nowMs: number;
  }> = [];
  const dependencies = {
    now: () => 1_800_000_000_000,
    records,
    immutableBlobs: new R2ImmutableBlobStore(bucket),
    staging: new R2StagingBlobStore(bucket),
    presigner: {
      create(input: R2PresignedPutInput) {
        signed = input;
        return Promise.resolve({
          method: "PUT" as const,
          url: `https://upload.example.test/${input.stagingKey}?X-Amz-Signature=opaque`,
          headers: { "content-type": input.contentType },
        });
      },
    },
    documentCache: {
      revokeAllSourceBindings(input: {
        ownershipScope: string;
        sourceIdentity: string;
        nowMs: number;
      }) {
        cacheRevocations.push(input);
        return Promise.resolve("revoked" as const);
      },
    },
  };
  const pdf = new TextEncoder().encode("%PDF-1.7\n");
  const createArguments = {
    declaredMime: "application/pdf",
    declaredSize: pdf.byteLength,
    filename: "source.pdf",
    idempotencyKey: "retry-one",
  };
  const first = await json(await maybeHandleEdgeArtifacts(
    request(1, "document_upload_create", createArguments),
    {}, principal, "managed:credential-a", "req-1", dependencies,
  ));
  const replay = await json(await maybeHandleEdgeArtifacts(
    request(2, "document_upload_create", createArguments),
    {}, principal, "managed:credential-a", "req-2", dependencies,
  ));
  const firstText = JSON.stringify(first);
  assert.match(firstText, /X-Amz-Signature/u);
  assert.doesNotMatch(firstText, /managed:credential-a/u);
  const firstResult = first.result as { structuredContent: { data: { uploadIntentId: string } } };
  const replayResult = replay.result as { structuredContent: { data: { uploadIntentId: string } } };
  assert.equal(firstResult.structuredContent.data.uploadIntentId, replayResult.structuredContent.data.uploadIntentId);
  assert.ok(signed !== undefined);
  const credentialDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("managed:credential-a"));
  bucket.objects.set(signed.stagingKey, {
    bytes: pdf,
    metadata: {
      "schema-version": "1",
      kind: "staging",
      "intent-id": signed.metadata.intentId,
      "owner-id": signed.metadata.ownerId,
      "credential-binding-hash": `sha256-${[...new Uint8Array(credentialDigest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
      "declared-mime": signed.contentType,
      "declared-size": String(signed.contentLength),
      "expires-at": String(signed.metadata.expiresAt),
    },
  });

  const complete = await json(await maybeHandleEdgeArtifacts(
    request(3, "document_upload_complete", { uploadIntentId: signed.metadata.intentId }),
    {}, principal, "managed:credential-a", "req-3", dependencies,
  ));
  const completeText = JSON.stringify(complete);
  assert.match(completeText, /"artifactKind":"source"/u);
  assert.match(completeText, /"verified":true/u);
  assert.doesNotMatch(completeText, /staging\/|X-Amz-|managed:credential-a/u);
  assert.equal(bucket.objects.has(signed.stagingKey), false);
  const refId = ((complete.result as { structuredContent: { data: { refId: string } } }).structuredContent.data.refId);
  const bridge = await maybePrepareArtifactParseRequest(
    request(4, "document_parse", {
      source: { kind: "artifact", refId, artifactKind: "source" },
      output: "text",
      maxPages: 5,
      cacheMode: "bypass",
    }), {}, principal, "managed:credential-a", dependencies,
  );
  assert.ok(bridge !== undefined);
  assert.equal(new URL(bridge.url).pathname, "/internal/document-parse-artifact");
  assert.equal(bridge.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await bridge.arrayBuffer()), pdf);

  const deleted = await json(await maybeHandleEdgeArtifacts(
    request(5, "document_artifact_delete", { refId }),
    {}, principal, "managed:credential-a", "req-5", dependencies,
  ));
  assert.deepEqual(
    (deleted.result as { structuredContent?: unknown }).structuredContent,
    { ok: true, data: { refId, deleted: true } },
  );
  assert.deepEqual(cacheRevocations, [{
    ownershipScope: "owner",
    sourceIdentity: documentCacheBindingIdentity({
      kind: "artifact",
      contentHash: `sha256-${[...new Uint8Array(await crypto.subtle.digest("SHA-256", pdf))]
        .map((value) => value.toString(16).padStart(2, "0")).join("")}`,
      artifactRef: refId,
      filename: "source.pdf",
    }, "managed:credential-a"),
    nowMs: 1_800_000_000_000,
  }]);
  assert.equal(bucket.objects.size, 0);
  await assert.rejects(() => maybePrepareArtifactParseRequest(
    request(6, "document_parse", {
      source: { kind: "artifact", refId, artifactKind: "source" },
      output: "text",
    }), {}, principal, "managed:credential-a", dependencies,
  ), /Unknown or unavailable artifact/u);
});

void test("Worker edge hides cross-credential intents and falls through when bindings are absent", async () => {
  const bucket = new FakeR2();
  const dependencies = {
    now: () => 1_800_000_000_000,
    records: new InMemoryDurableRecordStore(),
    immutableBlobs: new R2ImmutableBlobStore(bucket),
    staging: new R2StagingBlobStore(bucket),
    presigner: { create: () => Promise.resolve({ method: "PUT" as const, url: "https://upload.example.test/opaque", headers: {} }) },
  };
  const created = await json(await maybeHandleEdgeArtifacts(
    request(1, "document_upload_create", {
      declaredMime: "application/pdf", declaredSize: 9, filename: "a.pdf", idempotencyKey: "one",
    }), {}, principal, "managed:one", "req-1", dependencies,
  ));
  const intentId = (created.result as { structuredContent: { data: { uploadIntentId: string } } }).structuredContent.data.uploadIntentId;
  const denied = await json(await maybeHandleEdgeArtifacts(
    request(2, "document_upload_complete", { uploadIntentId: intentId }),
    {}, principal, "managed:two", "req-2", dependencies,
  ));
  assert.match(JSON.stringify(denied), /Unknown or unavailable upload intent/u);
  assert.doesNotMatch(JSON.stringify(denied), /managed:one|managed:two/u);

  assert.equal(await maybeHandleEdgeArtifacts(
    request(3, "document_upload_create", {}), {}, principal, "managed:one", "req-3",
  ), undefined);

  assert.equal(await maybeHandleEdgeArtifacts(
    request(4, "document_upload_create", {
      declaredMime: "application/pdf", declaredSize: 9, filename: "a.pdf", idempotencyKey: "two",
    }), {
      R2_ACCOUNT_ID: "account",
      R2_BUCKET_NAME: "artifacts",
      R2_ACCESS_KEY_ID: "access-key",
      R2_SECRET_ACCESS_KEY: "secret-access-key",
    }, principal, "managed:one", "req-4", {
      now: dependencies.now,
      records: dependencies.records,
      immutableBlobs: dependencies.immutableBlobs,
      staging: dependencies.staging,
    },
  ), undefined, "production artifact routing must fail closed without internal signing");
});

void test("Worker edge rejects upload TTLs above the operator cap without clamping", async () => {
  const bucket = new FakeR2();
  const dependencies = {
    now: () => 1_800_000_000_000,
    records: new InMemoryDurableRecordStore(),
    immutableBlobs: new R2ImmutableBlobStore(bucket),
    staging: new R2StagingBlobStore(bucket),
    presigner: {
      create: () => Promise.resolve({
        method: "PUT" as const,
        url: "https://upload.example.test/opaque",
        headers: {},
      }),
    },
  };
  const response = await json(await maybeHandleEdgeArtifacts(
    request(1, "document_upload_create", {
      declaredMime: "application/pdf",
      declaredSize: 9,
      filename: "a.pdf",
      idempotencyKey: "above-operator-cap",
      artifactTtlSeconds: 172_801,
    }), {
      DOCUMENT_UPLOAD_MAX_TTL_SECONDS: "1200",
      DOCUMENT_ARTIFACT_MAX_TTL_SECONDS: "172800",
    }, principal, "managed:one", "req-1", dependencies,
  ));
  assert.match(JSON.stringify(response), /INVALID_INPUT/u);
  assert.match(JSON.stringify(response), /172800000 milliseconds/u);
  assert.doesNotMatch(JSON.stringify(response), /expiresAt/u);
});
