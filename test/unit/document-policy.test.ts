import assert from "node:assert/strict";
import test from "node:test";

import {
  createArtifactRetentionPolicy,
  DEFAULT_ARTIFACT_RETENTION_POLICY,
} from "../../src/core/artifact-retention-policy.js";
import { getDocumentPolicyView } from "../../src/core/document-policy.js";

void test("document policy uses the canonical upload and artifact retention defaults", () => {
  const nowMs = Date.parse("2026-09-05T00:00:00Z");
  const view = getDocumentPolicyView(nowMs);
  assert.deepEqual(
    {
      defaultTtlSeconds: view.upload.defaultTtlSeconds,
      minTtlSeconds: view.upload.minTtlSeconds,
      maxTtlSeconds: view.upload.maxTtlSeconds,
    },
    DEFAULT_ARTIFACT_RETENTION_POLICY.upload,
  );
  assert.deepEqual(
    {
      defaultTtlSeconds: view.artifact.defaultTtlSeconds,
      minTtlSeconds: view.artifact.minTtlSeconds,
      maxTtlSeconds: view.artifact.maxTtlSeconds,
    },
    DEFAULT_ARTIFACT_RETENTION_POLICY.artifact,
  );
});

void test("operator caps are advertised exactly and requests above them are rejected", () => {
  const nowMs = Date.parse("2026-09-05T00:00:00Z");
  const policy = createArtifactRetentionPolicy({
    uploadMaxTtlSeconds: 1_200,
    artifactMaxTtlSeconds: 172_800,
  });
  const bounds = { upload: policy.upload, artifact: policy.artifact };
  const view = getDocumentPolicyView(nowMs, undefined, bounds);
  assert.equal(view.upload.maxTtlSeconds, 1_200);
  assert.equal(view.artifact.maxTtlSeconds, 172_800);
  assert.throws(
    () => getDocumentPolicyView(nowMs, { artifact: { relativeTtlSeconds: 172_801 } }, bounds),
    /exceeds maximum 172800s/u,
  );
});
