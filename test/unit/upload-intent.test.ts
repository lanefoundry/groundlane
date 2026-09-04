import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ARTIFACT_PROCESSING_POLICY,
  STAGING_CLEANUP_WINDOW_MS,
  UPLOAD_INTENT_DEFAULT_TTL_MS,
  VERIFIED_ARTIFACT_DEFAULT_TTL_MS,
  applyExplicitDelete,
  createArtifactRef,
  resolveEffectiveExpiry,
  resolveUploadMethod,
  validateArtifactProcessingPolicy,
  validateArtifactRefId,
  validateCleanupWindow,
  validateCompleteUpload,
  validateCrossOwnership,
  validateCreateIntent,
  validateDocumentSourceArtifactKind,
  validateResultArtifactRef,
  validateSourceIdentityConsistency,
  validateStatusTransition,
  type ArtifactRef,
  type CleanupAction,
  type CompleteUploadRequest,
  type DeploymentExpiryBounds,
  type StagingObject,
  type UploadHandoffSupport,
  type UploadIntent,
  type UrlProcessingOutput,
} from "../../src/core/upload-intent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeIntent(overrides?: Partial<UploadIntent>): UploadIntent {
  return {
    intentId: "intent_abc123",
    ownershipScope: "deploy_prod",
    declaredMime: "application/pdf",
    declaredSize: 1_000_000,
    maxSize: 10_000_000,
    expectedDigest: null,
    expiresAt: NOW + UPLOAD_INTENT_DEFAULT_TTL_MS,
    status: "pending",
    multipart: false,
    ...overrides,
  };
}

function makeCompleteReq(overrides?: Partial<CompleteUploadRequest>): CompleteUploadRequest {
  return {
    intentId: "intent_abc123",
    actualSize: 1_000_000,
    sniffedMime: "application/pdf",
    contentHash: "sha256-deadbeef",
    ...overrides,
  };
}

function makeArtifactRef(overrides?: Partial<ArtifactRef>): ArtifactRef {
  return {
    refId: "art_opaque_id_123",
    artifactKind: "source",
    ownershipScope: "deploy_prod",
    contentHash: "sha256-deadbeef",
    byteSize: 1_000_000,
    createdAt: NOW,
    expiresAt: NOW + VERIFIED_ARTIFACT_DEFAULT_TTL_MS,
    retentionPolicy: "transient",
    verified: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 665: Upload intent flow
// ---------------------------------------------------------------------------

void test("PRD 665: valid create intent accepted", () => {
  assert.doesNotThrow(() => validateCreateIntent(makeIntent(), NOW));
});

void test("PRD 665: expired intent rejected at creation", () => {
  const expired = makeIntent({ expiresAt: NOW - 1000 });
  assert.throws(
    () => validateCreateIntent(expired, NOW),
    { message: /already expired/ },
  );
});

void test("PRD 665: declared size exceeding max rejected", () => {
  const oversized = makeIntent({ declaredSize: 20_000_000 });
  assert.throws(
    () => validateCreateIntent(oversized, NOW),
    { message: /exceeds max size/ },
  );
});

void test("PRD 665: multipart rejected in V1", () => {
  const mp = { ...makeIntent(), multipart: true as unknown as false };
  assert.throws(
    () => validateCreateIntent(mp, NOW),
    { message: /multipart is rejected/ },
  );
});

void test("PRD 665: valid complete upload accepted", () => {
  const intent = makeIntent({ status: "uploading" });
  assert.doesNotThrow(() => validateCompleteUpload(intent, makeCompleteReq(), NOW));
});

void test("PRD 665: expired intent rejected on complete", () => {
  const intent = makeIntent({ expiresAt: NOW - 1 });
  assert.throws(
    () => validateCompleteUpload(intent, makeCompleteReq(), NOW),
    { message: /expired/ },
  );
});

void test("PRD 665: size mismatch rejected", () => {
  const intent = makeIntent({ status: "uploading", maxSize: 500 });
  const req = makeCompleteReq({ actualSize: 1000 });
  assert.throws(
    () => validateCompleteUpload(intent, req, NOW),
    { message: /exceeds max size/ },
  );
});

void test("PRD 665: digest mismatch rejected", () => {
  const intent = makeIntent({ status: "uploading", expectedDigest: "sha256-expected" });
  const req = makeCompleteReq({ contentHash: "sha256-wrong" });
  assert.throws(
    () => validateCompleteUpload(intent, req, NOW),
    { message: /hash mismatch/ },
  );
});

void test("PRD 665: digest match accepted", () => {
  const intent = makeIntent({ status: "uploading", expectedDigest: "sha256-deadbeef" });
  const req = makeCompleteReq({ contentHash: "sha256-deadbeef" });
  assert.doesNotThrow(() => validateCompleteUpload(intent, req, NOW));
});

void test("PRD 665: MIME mismatch rejected", () => {
  const intent = makeIntent({ status: "uploading", declaredMime: "application/pdf" });
  const req = makeCompleteReq({ sniffedMime: "image/png" });
  assert.throws(
    () => validateCompleteUpload(intent, req, NOW),
    { message: /MIME type mismatch/ },
  );
});

void test("PRD 665: replay detected via intent ID mismatch", () => {
  const intent = makeIntent({ status: "uploading" });
  const req = makeCompleteReq({ intentId: "intent_different" });
  assert.throws(
    () => validateCompleteUpload(intent, req, NOW),
    { message: /replay/ },
  );
});

void test("PRD 665: finalized intent cannot be overwritten", () => {
  const intent = makeIntent({ status: "finalized" });
  assert.throws(
    () => validateCompleteUpload(intent, makeCompleteReq(), NOW),
    { message: /finalized/ },
  );
});

void test("PRD 665: cross-ownership rejected", () => {
  const intent = makeIntent({ ownershipScope: "deploy_prod" });
  assert.throws(
    () => validateCrossOwnership(intent, "deploy_staging"),
    { message: /Cross-ownership/ },
  );
});

void test("PRD 665: same ownership accepted", () => {
  const intent = makeIntent({ ownershipScope: "deploy_prod" });
  assert.doesNotThrow(() => validateCrossOwnership(intent, "deploy_prod"));
});

void test("PRD 665: upload intent default TTL is 15 minutes", () => {
  assert.equal(UPLOAD_INTENT_DEFAULT_TTL_MS, 15 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// PRD 666: ArtifactRef
// ---------------------------------------------------------------------------

void test("PRD 666: create artifact ref requires verified=true", () => {
  const params = { ...makeArtifactRef(), verified: true as const };
  const ref = createArtifactRef(params);
  assert.equal(ref.verified, true);
});

void test("PRD 666: unverified ref rejected", () => {
  const params = { ...makeArtifactRef(), verified: false };
  assert.throws(
    () => createArtifactRef(params as unknown as ArtifactRef & { verified: true }),
    { message: /unverified/ },
  );
});

void test("PRD 666: R2 key pattern rejected from refId", () => {
  assert.throws(
    () => validateArtifactRefId("abcdef01234567890abcdef012345678/550e8400-e29b-41d4-a716-446655440000"),
    { message: /R2 key/ },
  );
});

void test("PRD 666: presigned URL pattern rejected from refId", () => {
  assert.throws(
    () => validateArtifactRefId("https://r2.example.com/obj?X-Amz-Credential=AKIA&Signature=abc"),
    { message: /presigned URL/ },
  );
});

void test("PRD 666: filesystem path rejected from refId", () => {
  assert.throws(
    () => validateArtifactRefId("/var/data/objects/abc123"),
    { message: /filesystem path/ },
  );
});

void test("PRD 666: provider-native ID rejected from refId", () => {
  assert.throws(
    () => validateArtifactRefId("arn:aws:s3:::my-bucket/key"),
    { message: /provider-native ID/ },
  );
});

void test("PRD 666: valid opaque refId accepted", () => {
  assert.doesNotThrow(() => validateArtifactRefId("art_opaque_abc123"));
});

void test("PRD 666: verified artifact default TTL is 24 hours", () => {
  assert.equal(VERIFIED_ARTIFACT_DEFAULT_TTL_MS, 24 * 60 * 60 * 1000);
});

void test("PRD 666: resolveEffectiveExpiry clamps to deployment bounds", () => {
  const bounds: DeploymentExpiryBounds = {
    minTtlMs: 60_000,
    maxTtlMs: 86_400_000,
  };
  // Below min
  const low = resolveEffectiveExpiry(10_000, bounds, NOW);
  assert.equal(low, NOW + 60_000);

  // Above max
  const high = resolveEffectiveExpiry(100_000_000, bounds, NOW);
  assert.equal(high, NOW + 86_400_000);

  // Within bounds
  const ok = resolveEffectiveExpiry(3_600_000, bounds, NOW);
  assert.equal(ok, NOW + 3_600_000);
});

void test("PRD 666: resolveEffectiveExpiry respects operator cap", () => {
  const bounds: DeploymentExpiryBounds = {
    minTtlMs: 60_000,
    maxTtlMs: 86_400_000,
    operatorCapMs: 3_600_000,
  };
  const result = resolveEffectiveExpiry(7_200_000, bounds, NOW);
  assert.equal(result, NOW + 3_600_000);
});

// ---------------------------------------------------------------------------
// PRD 667: Artifact processing policy
// ---------------------------------------------------------------------------

void test("PRD 667: default processing policy has auto-extend and auto-enroll false", () => {
  assert.equal(DEFAULT_ARTIFACT_PROCESSING_POLICY.autoExtendRetention, false);
  assert.equal(DEFAULT_ARTIFACT_PROCESSING_POLICY.autoEnrollCorpus, false);
});

void test("PRD 667: autoExtendRetention=true rejected", () => {
  assert.throws(
    () => validateArtifactProcessingPolicy({
      autoExtendRetention: true as unknown as false,
      autoEnrollCorpus: false,
    }),
    { message: /autoExtendRetention must be false/ },
  );
});

void test("PRD 667: autoEnrollCorpus=true rejected", () => {
  assert.throws(
    () => validateArtifactProcessingPolicy({
      autoExtendRetention: false,
      autoEnrollCorpus: true as unknown as false,
    }),
    { message: /autoEnrollCorpus must be false/ },
  );
});

void test("PRD 667: cleanup actions cover all lifecycle states", () => {
  const actions: CleanupAction[] = [
    { kind: "cancel", reason: "user cancelled" },
    { kind: "failure", reason: "processing error" },
    { kind: "expiry" },
    { kind: "delete", revokeAccess: true },
    { kind: "orphan", staleSinceMs: 3_600_000 },
  ];
  assert.equal(actions.length, 5);
  assert.equal(actions[3]!.kind, "delete");
  if (actions[3]!.kind === "delete") {
    assert.equal(actions[3]!.revokeAccess, true);
  }
});

// ---------------------------------------------------------------------------
// PRD 668: URL processing output
// ---------------------------------------------------------------------------

void test("PRD 668: matching content hash passes consistency", () => {
  const original: UrlProcessingOutput = {
    requestedUrl: "https://example.com/doc",
    finalUrl: "https://example.com/doc",
    fetchedAt: NOW,
    contentHash: "sha256-aaa",
    validator: "etag-123",
    redirectChain: [],
    engine: "http",
    truncated: false,
    truncationReason: null,
  };
  const refetch: UrlProcessingOutput = { ...original, fetchedAt: NOW + 5000 };
  assert.doesNotThrow(() => validateSourceIdentityConsistency(original, refetch));
});

void test("PRD 668: changed content hash detected", () => {
  const original: UrlProcessingOutput = {
    requestedUrl: "https://example.com/doc",
    finalUrl: "https://example.com/doc",
    fetchedAt: NOW,
    contentHash: "sha256-aaa",
    validator: "etag-123",
    redirectChain: [],
    engine: "http",
    truncated: false,
    truncationReason: null,
  };
  const refetch: UrlProcessingOutput = {
    ...original,
    fetchedAt: NOW + 5000,
    contentHash: "sha256-bbb",
  };
  assert.throws(
    () => validateSourceIdentityConsistency(original, refetch),
    { message: /content changed/ },
  );
});

void test("PRD 668: output provenance includes all required fields", () => {
  const output: UrlProcessingOutput = {
    requestedUrl: "https://example.com/page",
    finalUrl: "https://www.example.com/page",
    fetchedAt: NOW,
    contentHash: "sha256-abc",
    validator: "etag-xyz",
    redirectChain: ["https://example.com/page", "https://www.example.com/page"],
    engine: "browser",
    truncated: true,
    truncationReason: "max_bytes_exceeded",
  };
  assert.ok(output.requestedUrl);
  assert.ok(output.finalUrl);
  assert.ok(output.fetchedAt > 0);
  assert.ok(output.contentHash);
  assert.ok(output.validator);
  assert.equal(output.redirectChain.length, 2);
  assert.ok(output.engine);
  assert.equal(output.truncated, true);
  assert.equal(output.truncationReason, "max_bytes_exceeded");
});

// ---------------------------------------------------------------------------
// PRD 669: Upload handoff support
// ---------------------------------------------------------------------------

void test("PRD 669: client with upload handoff gets direct method", () => {
  const client: UploadHandoffSupport = {
    clientId: "claude",
    supportsUploadHandoff: true,
    fallbackMethod: null,
  };
  assert.equal(resolveUploadMethod(client), "direct");
});

void test("PRD 669: client without handoff gets fallback", () => {
  const client: UploadHandoffSupport = {
    clientId: "cursor",
    supportsUploadHandoff: false,
    fallbackMethod: "cli",
  };
  assert.equal(resolveUploadMethod(client), "cli");
});

void test("PRD 669: client without handoff or fallback throws", () => {
  const client: UploadHandoffSupport = {
    clientId: "unknown",
    supportsUploadHandoff: false,
    fallbackMethod: null,
  };
  assert.throws(
    () => resolveUploadMethod(client),
    { message: /no fallback method/ },
  );
});

void test("PRD 669: dashboard fallback accepted", () => {
  const client: UploadHandoffSupport = {
    clientId: "web-app",
    supportsUploadHandoff: false,
    fallbackMethod: "dashboard",
  };
  assert.equal(resolveUploadMethod(client), "dashboard");
});

// ---------------------------------------------------------------------------
// PRD 670: Staging cleanup
// ---------------------------------------------------------------------------

void test("PRD 670: staging cleanup window constant is 1 hour", () => {
  assert.equal(STAGING_CLEANUP_WINDOW_MS, 3_600_000);
});

void test("PRD 670: cleanup window exceeding 1 hour rejected", () => {
  assert.throws(
    () => validateCleanupWindow(3_600_001),
    { message: /exceeds maximum/ },
  );
});

void test("PRD 670: cleanup window at exactly 1 hour accepted", () => {
  assert.doesNotThrow(() => validateCleanupWindow(3_600_000));
});

void test("PRD 670: zero cleanup window rejected", () => {
  assert.throws(
    () => validateCleanupWindow(0),
    { message: /must be positive/ },
  );
});

void test("PRD 670: explicit delete immediately revokes access", () => {
  const staging: StagingObject = {
    intentId: "intent_abc",
    status: "active",
    accessRevoked: false,
  };
  const deleted = applyExplicitDelete(staging);
  assert.equal(deleted.status, "logically_deleted");
  assert.equal(deleted.accessRevoked, true);
});

void test("PRD 670: valid status transitions accepted", () => {
  assert.doesNotThrow(() => validateStatusTransition("active", "logically_deleted"));
  assert.doesNotThrow(() => validateStatusTransition("active", "logically_expired"));
  assert.doesNotThrow(() => validateStatusTransition("active", "physical_cleanup_pending"));
  assert.doesNotThrow(() => validateStatusTransition("logically_deleted", "physical_cleanup_pending"));
  assert.doesNotThrow(() => validateStatusTransition("logically_expired", "physical_cleanup_pending"));
  assert.doesNotThrow(() => validateStatusTransition("physical_cleanup_pending", "cleaned"));
});

void test("PRD 670: invalid status transitions rejected", () => {
  assert.throws(
    () => validateStatusTransition("cleaned", "active"),
    { message: /Invalid staging status transition/ },
  );
  assert.throws(
    () => validateStatusTransition("logically_deleted", "active"),
    { message: /Invalid staging status transition/ },
  );
  assert.throws(
    () => validateStatusTransition("cleaned", "physical_cleanup_pending"),
    { message: /Invalid staging status transition/ },
  );
});

// ---------------------------------------------------------------------------
// PRD 684: Result ArtifactRef with typed artifactKind
// ---------------------------------------------------------------------------

void test("PRD 684: canonical_document ref cannot enter DocumentSource.artifact", () => {
  assert.throws(
    () => validateDocumentSourceArtifactKind("canonical_document"),
    { message: /only accepts artifactKind="source"/ },
  );
});

void test("PRD 684: projection ref cannot enter DocumentSource.artifact", () => {
  assert.throws(
    () => validateDocumentSourceArtifactKind("projection"),
    { message: /only accepts artifactKind="source"/ },
  );
});

void test("PRD 684: source ref accepted in DocumentSource.artifact", () => {
  assert.doesNotThrow(() => validateDocumentSourceArtifactKind("source"));
});

void test("PRD 684: valid result artifact ref accepted", () => {
  const ref = makeArtifactRef({ artifactKind: "canonical_document" });
  assert.doesNotThrow(() => validateResultArtifactRef(ref));
});

void test("PRD 684: unverified result artifact ref rejected", () => {
  const ref = makeArtifactRef({ verified: false });
  assert.throws(
    () => validateResultArtifactRef(ref),
    { message: /must be verified/ },
  );
});

void test("PRD 684: projection result artifact ref accepted", () => {
  const ref = makeArtifactRef({ artifactKind: "projection" });
  assert.doesNotThrow(() => validateResultArtifactRef(ref));
});
