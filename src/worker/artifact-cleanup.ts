import { DurableUploadArtifactService } from "../core/durable-upload-flow.js";
import type { DurableRecordStorePort } from "../core/durable-store.js";
import type { ImmutableBlobPort } from "../core/immutable-blob.js";
import { D1DurableRecordStore } from "./d1-durable-store.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";
import { R2ImmutableBlobStore } from "./r2-immutable-blob.js";
import { R2StagingBlobStore, type R2StagingCleanupPage } from "./r2-staging-blob.js";
import {
  createArtifactCacheRevocationPort,
  type EdgeArtifactsDependencies,
} from "./artifact-runtime.js";
import type { D1R2DocumentCacheRuntime } from "./d1-r2-document-cache.js";

const ARTIFACT_UPLOAD_NAMESPACE = "artifact-upload-v1";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 4;

export interface ArtifactCleanupEnv {
  readonly MANAGED_TOKEN_D1?: D1DatabaseLike;
  readonly GROUNDLANE_ARTIFACTS?: R2Bucket;
  readonly DOCUMENT_CACHE_EDGE_ENABLED?: string;
  readonly DOCUMENT_OUTPUT_EDGE_ENABLED?: string;
  readonly DOCUMENT_ARTIFACT_MAX_TTL_SECONDS?: string;
}

export interface ArtifactCleanupDependencies {
  readonly now?: () => number;
  readonly records?: DurableRecordStorePort;
  readonly immutableBlobs?: ImmutableBlobPort;
  readonly staging?: Pick<R2StagingBlobStore, "cleanupExpiredPage">;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly documentCache?: Pick<D1R2DocumentCacheRuntime, "revokeAllSourceBindings">;
}

export interface ArtifactCleanupResult {
  readonly configured: boolean;
  readonly metadataScanned: number;
  readonly logicallyRevoked: number;
  readonly finalBytesDeleted: number;
  readonly stagingScanned: number;
  readonly stagingDeleted: number;
  readonly retryPending: number;
  readonly failures: readonly string[];
}

function bounded(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 100) {
    throw new Error(`${label} must be 1..100`);
  }
  return selected;
}

/** Runs a bounded metadata and staging cleanup pass. Each invocation starts from a stable null cursor. */
export async function runArtifactCleanup(
  env: ArtifactCleanupEnv,
  dependencies: ArtifactCleanupDependencies = {},
): Promise<ArtifactCleanupResult> {
  const bucket = env.GROUNDLANE_ARTIFACTS;
  const records = dependencies.records ?? (env.MANAGED_TOKEN_D1 === undefined
    ? undefined
    : new D1DurableRecordStore(env.MANAGED_TOKEN_D1, ARTIFACT_UPLOAD_NAMESPACE));
  const immutableBlobs = dependencies.immutableBlobs ?? (bucket === undefined
    ? undefined
    : new R2ImmutableBlobStore(bucket));
  const staging = dependencies.staging ?? (bucket === undefined ? undefined : new R2StagingBlobStore(bucket));
  if (records === undefined || immutableBlobs === undefined || staging === undefined) {
    return {
      configured: false,
      metadataScanned: 0,
      logicallyRevoked: 0,
      finalBytesDeleted: 0,
      stagingScanned: 0,
      stagingDeleted: 0,
      retryPending: 0,
      failures: [],
    };
  }
  const nowMs = (dependencies.now ?? Date.now)();
  const pageSize = bounded(dependencies.pageSize, DEFAULT_PAGE_SIZE, "artifact cleanup page size");
  const maxPages = bounded(dependencies.maxPages, DEFAULT_MAX_PAGES, "artifact cleanup max pages");
  const revocationDependencies: EdgeArtifactsDependencies = {
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    records,
    immutableBlobs,
    ...(dependencies.documentCache === undefined
      ? {}
      : { documentCache: dependencies.documentCache }),
  };
  const service = new DurableUploadArtifactService(
    records,
    immutableBlobs,
    undefined,
    createArtifactCacheRevocationPort(env, revocationDependencies),
  );
  let metadataCursor: string | null = null;
  let stagingCursor: string | null = null;
  let metadataScanned = 0;
  let logicallyRevoked = 0;
  let finalBytesDeleted = 0;
  let stagingScanned = 0;
  let stagingDeleted = 0;
  let retryPending = 0;
  const failures: string[] = [];
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await service.cleanupExpiredPage(nowMs, metadataCursor, pageSize);
    metadataScanned += page.scanned;
    logicallyRevoked += page.logicallyRevoked;
    finalBytesDeleted += page.physicallyDeleted;
    retryPending += page.retryPending;
    failures.push(...page.failures);
    metadataCursor = page.nextCursor;
    if (metadataCursor === null) break;
  }
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    let page: R2StagingCleanupPage;
    try {
      page = await staging.cleanupExpiredPage(nowMs, stagingCursor, pageSize);
    } catch {
      failures.push("staging-page");
      retryPending += 1;
      break;
    }
    stagingScanned += page.scanned;
    stagingDeleted += page.deleted;
    failures.push(...page.failures);
    retryPending += page.failures.length;
    stagingCursor = page.nextCursor;
    if (stagingCursor === null) break;
  }
  return {
    configured: true,
    metadataScanned,
    logicallyRevoked,
    finalBytesDeleted,
    stagingScanned,
    stagingDeleted,
    retryPending,
    failures,
  };
}
