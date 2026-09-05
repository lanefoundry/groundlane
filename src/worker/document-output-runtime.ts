import { createArtifactRetentionPolicy } from "../core/artifact-retention-policy.js";
import { DurableArtifactRepository } from "../core/durable-artifacts.js";
import { DurableDocumentOutputRuntime } from "../core/durable-document-output.js";
import { GroundlaneError } from "../core/errors.js";
import { DurableUploadArtifactService } from "../core/durable-upload-flow.js";
import { MAX_IMMUTABLE_BLOB_BYTES } from "../core/immutable-blob.js";
import { D1DurableRecordStore } from "./d1-durable-store.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";
import { R2ImmutableBlobStore, type R2BucketLike } from "./r2-immutable-blob.js";

export const DOCUMENT_OUTPUT_NAMESPACE = "document-output-v1";

export interface EdgeDocumentOutputEnv {
  readonly MANAGED_TOKEN_D1?: D1DatabaseLike;
  readonly GROUNDLANE_ARTIFACTS?: R2BucketLike;
  readonly DOCUMENT_ARTIFACT_MAX_TTL_SECONDS?: string;
}

export interface EdgeDocumentOutputOptions {
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

/** D1 stores bounded metadata; immutable source and canonical bytes live only in R2. */
export function createEdgeDocumentOutputRuntime(
  env: EdgeDocumentOutputEnv,
  options: EdgeDocumentOutputOptions = {},
): { readonly repository: DurableArtifactRepository; readonly runtime: DurableDocumentOutputRuntime } {
  if (env.MANAGED_TOKEN_D1 === undefined || env.GROUNDLANE_ARTIFACTS === undefined ||
      typeof env.MANAGED_TOKEN_D1.withSession !== "function") {
    throw new GroundlaneError("PROVIDER_UNAVAILABLE", "document-output", "Document output storage is unavailable");
  }
  let ttlSeconds: number;
  try {
    const rawMaximum = env.DOCUMENT_ARTIFACT_MAX_TTL_SECONDS;
    if (rawMaximum !== undefined && rawMaximum.trim().length > 0 && !/^\d+$/u.test(rawMaximum)) {
      throw new Error("Invalid artifact retention cap");
    }
    const policy = createArtifactRetentionPolicy(
      rawMaximum === undefined || rawMaximum.trim().length === 0
        ? {}
        : { artifactMaxTtlSeconds: Number(rawMaximum) },
    ).artifact;
    ttlSeconds = options.ttlSeconds ?? policy.defaultTtlSeconds;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < policy.minTtlSeconds || ttlSeconds > policy.maxTtlSeconds) {
      throw new Error("Invalid document output retention");
    }
  } catch {
    throw new GroundlaneError("INVALID_INPUT", "document-output", "Document output retention configuration is invalid");
  }
  const repository = new DurableArtifactRepository(
    new D1DurableRecordStore(env.MANAGED_TOKEN_D1, DOCUMENT_OUTPUT_NAMESPACE),
    new R2ImmutableBlobStore(env.GROUNDLANE_ARTIFACTS),
  );
  // Read-only authority avoids recursively constructing upload revocation ports.
  const uploads = new DurableUploadArtifactService(
    new D1DurableRecordStore(env.MANAGED_TOKEN_D1, "artifact-upload-v1"),
    new R2ImmutableBlobStore(env.GROUNDLANE_ARTIFACTS),
  );
  const now = options.now ?? Date.now;
  return { repository, runtime: new DurableDocumentOutputRuntime(repository, ttlSeconds, now, {
    async assertActive(refId, caller, signal) {
      signal.throwIfAborted();
      if (caller.tenantId !== "cloudflare") {
        throw new GroundlaneError("INVALID_INPUT", "document-output", "Document source is unavailable");
      }
      const source = await uploads.readArtifact(refId, caller, now(), MAX_IMMUTABLE_BLOB_BYTES);
      signal.throwIfAborted();
      return { expiresAt: source.ref.expiresAt, contentHash: source.ref.contentHash };
    },
  }, new D1DurableRecordStore(env.MANAGED_TOKEN_D1, "document-output-intents-v1")) };
}
