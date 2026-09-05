import { D1R2DocumentCacheRuntime } from "./d1-r2-document-cache.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";
import type { R2BucketLike } from "./r2-immutable-blob.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 4;

interface DocumentCacheSweepPort {
  sweepExpiredPage(
    nowMs: number,
    cursor: string | null,
    limit: number,
  ): Promise<{ readonly scanned: number; readonly removed: number; readonly nextCursor: string | null }>;
}

export interface DocumentCacheCleanupEnv {
  readonly MANAGED_TOKEN_D1?: D1DatabaseLike;
  readonly GROUNDLANE_ARTIFACTS?: R2BucketLike;
  readonly DOCUMENT_CACHE_EDGE_ENABLED?: string;
}

export interface DocumentCacheCleanupDependencies {
  readonly now?: () => number;
  readonly runtime?: DocumentCacheSweepPort;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface DocumentCacheCleanupResult {
  readonly configured: boolean;
  readonly scanned: number;
  readonly removed: number;
  readonly pages: number;
  readonly retryPending: boolean;
}

function bounded(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 100) {
    throw new Error(`${label} must be 1..100`);
  }
  return selected;
}

/** Runs at most maxPages so one cron invocation cannot scan the full cache. */
export async function runDocumentCacheCleanup(
  env: DocumentCacheCleanupEnv,
  dependencies: DocumentCacheCleanupDependencies = {},
): Promise<DocumentCacheCleanupResult> {
  const runtime = dependencies.runtime ?? (
    env.DOCUMENT_CACHE_EDGE_ENABLED === "true" &&
    env.MANAGED_TOKEN_D1 !== undefined &&
    env.GROUNDLANE_ARTIFACTS !== undefined
      ? new D1R2DocumentCacheRuntime({ db: env.MANAGED_TOKEN_D1, bucket: env.GROUNDLANE_ARTIFACTS })
      : undefined
  );
  if (runtime === undefined) {
    return { configured: false, scanned: 0, removed: 0, pages: 0, retryPending: false };
  }
  const nowMs = (dependencies.now ?? Date.now)();
  const pageSize = bounded(dependencies.pageSize, DEFAULT_PAGE_SIZE, "document cache cleanup page size");
  const maxPages = bounded(dependencies.maxPages, DEFAULT_MAX_PAGES, "document cache cleanup max pages");
  let cursor: string | null = null;
  let scanned = 0;
  let removed = 0;
  let pages = 0;
  for (; pages < maxPages; pages += 1) {
    const page = await runtime.sweepExpiredPage(nowMs, cursor, pageSize);
    scanned += page.scanned;
    removed += page.removed;
    cursor = page.nextCursor;
    if (cursor === null) {
      pages += 1;
      break;
    }
  }
  return { configured: true, scanned, removed, pages, retryPending: cursor !== null };
}
