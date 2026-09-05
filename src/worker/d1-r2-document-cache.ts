import {
  DurableDocumentCacheRepository,
  type DurableDocumentCacheOptions,
} from "../core/durable-document-cache.js";
import { D1DurableRecordStore } from "./d1-durable-store.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";
import {
  R2ImmutableBlobStore,
  type R2BucketLike,
} from "./r2-immutable-blob.js";

export const D1_R2_DOCUMENT_CACHE_NAMESPACE = "document-cache";

export interface D1R2DocumentCacheBindings {
  readonly db: D1DatabaseLike;
  readonly bucket: R2BucketLike;
}

export interface D1R2DocumentCacheOptions {
  /** Namespace override is intended for deterministic isolation in tests. */
  readonly namespace?: string;
  readonly maxCasAttempts?: number;
}

/**
 * Cloudflare document-processing cache runtime.
 *
 * D1 contains only bounded, revision-fenced metadata and source bindings.
 * R2 contains immutable, digest-checked payload bytes. Cache semantics,
 * tenant/source isolation, TTL handling, and fail-open processing behavior
 * remain centralized in DurableDocumentCacheRepository.
 */
export class D1R2DocumentCacheRuntime extends DurableDocumentCacheRepository {
  constructor(
    bindings: D1R2DocumentCacheBindings,
    options: D1R2DocumentCacheOptions = {},
  ) {
    const repositoryOptions: DurableDocumentCacheOptions = {
      payloads: new R2ImmutableBlobStore(bindings.bucket),
      ...(options.maxCasAttempts === undefined
        ? {}
        : { maxCasAttempts: options.maxCasAttempts }),
    };
    super(
      new D1DurableRecordStore(
        bindings.db,
        options.namespace ?? D1_R2_DOCUMENT_CACHE_NAMESPACE,
      ),
      repositoryOptions,
    );
  }
}

/** Compile-time binding helper for Worker composition. */
export function createD1R2DocumentCacheRuntime(
  db: D1Database,
  bucket: R2Bucket,
  options: D1R2DocumentCacheOptions = {},
): D1R2DocumentCacheRuntime {
  return new D1R2DocumentCacheRuntime({ db, bucket }, options);
}
