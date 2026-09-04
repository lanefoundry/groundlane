// ---------------------------------------------------------------------------
// PRD 671, 672, 673, 674, 677, 682 -- Document processing cache contract
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { GroundlaneError } from "./errors.js";

// -- PRD 671: Cache mode and configuration -----------------------------------

export type CacheMode = "use" | "refresh" | "bypass";

export const DEFAULT_CACHE_TTL_SECONDS = 86400; // 24 hours
export const DEFAULT_CACHE_MODE: CacheMode = "use";

export interface CacheConfig {
  readonly defaultTtlSeconds: number;
  readonly operatorMaxTtlSeconds?: number;
  readonly enabled: boolean;
  readonly sourceExpirySeconds?: number;
}

export interface ResolvedCacheMode {
  readonly effectiveMode: CacheMode;
  readonly degraded: boolean;
  readonly reason?: string;
}

/**
 * Resolves the effective cache mode, handling operator disable.
 * When the operator disables the cache, use/refresh degrade to normal
 * execution with no cache write and cached=false.
 */
export function resolveCacheMode(
  requested: CacheMode,
  config: CacheConfig,
): ResolvedCacheMode {
  if (!config.enabled) {
    if (requested === "use" || requested === "refresh") {
      return {
        effectiveMode: "bypass",
        degraded: true,
        reason: "Operator disabled cache; degraded to bypass",
      };
    }
    return { effectiveMode: "bypass", degraded: false };
  }
  return { effectiveMode: requested, degraded: false };
}

/**
 * Computes the effective TTL as the minimum of all applicable constraints.
 */
export function resolveEffectiveTtl(
  requestedTtlSeconds: number | undefined,
  config: CacheConfig,
): number {
  const requested = requestedTtlSeconds ?? config.defaultTtlSeconds;
  let effective = requested;

  if (config.operatorMaxTtlSeconds !== undefined) {
    effective = Math.min(effective, config.operatorMaxTtlSeconds);
  }
  if (config.sourceExpirySeconds !== undefined) {
    effective = Math.min(effective, config.sourceExpirySeconds);
  }

  return Math.max(effective, 0);
}

/**
 * Validates that cache failure does not propagate as processing failure.
 * Returns a safe result rather than throwing.
 */
export function safeCacheOperation<T>(
  operation: () => T,
  fallback: T,
): { result: T; cacheError?: string } {
  try {
    return { result: operation() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: fallback, cacheError: message };
  }
}

// -- PRD 672: Cache key structures -------------------------------------------

export interface ParsedPayloadCacheKey {
  readonly ownershipScope: string;
  readonly contentHash: string;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly normalizedOptions: string;
  readonly schemaVersion: string;
  readonly policyVersion: string;
}

export interface SourceBindingKey extends ParsedPayloadCacheKey {
  readonly sourceIdentity: string;
  readonly sourceVersion: string;
}

/**
 * Validates a cache key, rejecting keys that rely only on URL, filename,
 * MIME type, or unverified digest.
 */
export function validateCacheKey(key: ParsedPayloadCacheKey): void {
  if (!key.ownershipScope) {
    throw new Error("Cache key must include ownershipScope");
  }
  if (!key.contentHash) {
    throw new Error("Cache key must include contentHash");
  }
  if (!key.engineId) {
    throw new Error("Cache key must include engineId");
  }
  if (!key.engineVersion) {
    throw new Error("Cache key must include engineVersion");
  }
  if (!key.modelId) {
    throw new Error("Cache key must include modelId");
  }
  if (!key.modelVersion) {
    throw new Error("Cache key must include modelVersion");
  }
  if (!key.schemaVersion) {
    throw new Error("Cache key must include schemaVersion");
  }
  if (!key.policyVersion) {
    throw new Error("Cache key must include policyVersion");
  }
}

/**
 * Rejects keys that rely on forbidden-only identifiers.
 */
export function rejectForbiddenKeyBasis(fields: {
  readonly hasContentHash: boolean;
  readonly hasUrlOnly: boolean;
  readonly hasFilenameOnly: boolean;
  readonly hasMimeOnly: boolean;
  readonly hasUnverifiedDigest: boolean;
}): void {
  if (!fields.hasContentHash) {
    if (fields.hasUrlOnly) {
      throw new Error("Cache key must not rely solely on URL");
    }
    if (fields.hasFilenameOnly) {
      throw new Error("Cache key must not rely solely on filename");
    }
    if (fields.hasMimeOnly) {
      throw new Error("Cache key must not rely solely on caller-declared MIME");
    }
    if (fields.hasUnverifiedDigest) {
      throw new Error("Cache key must not rely on unverified digest");
    }
  }
}

/**
 * Cross-tenant/project/deployment reuse is forbidden by default.
 */
export function validateOwnershipScope(
  requestScope: string,
  keyScope: string,
): void {
  if (requestScope !== keyScope) {
    throw new Error(
      `Cross-tenant cache reuse forbidden: request scope "${requestScope}" ` +
      `does not match key scope "${keyScope}"`,
    );
  }
}

// -- PRD 673: Cache payload, source binding, live references -----------------

export interface CachePayload {
  readonly payloadId: string;
  readonly contentHash: string;
  readonly data: unknown;
  readonly createdAt: number;
}

export interface SourceBinding {
  readonly bindingId: string;
  readonly sourceIdentity: string;
  readonly payloadId: string;
  readonly ownershipScope: string;
  readonly createdAt: number;
  readonly revoked: boolean;
}

export interface LiveReferenceSet {
  readonly payloadId: string;
  readonly bindings: readonly SourceBinding[];
}

/**
 * Revokes the binding for a specific source without affecting other bindings
 * to the same payload.
 */
export function revokeBinding(
  referenceSet: LiveReferenceSet,
  sourceIdentity: string,
): LiveReferenceSet {
  return {
    payloadId: referenceSet.payloadId,
    bindings: referenceSet.bindings.map((b) =>
      b.sourceIdentity === sourceIdentity ? { ...b, revoked: true } : b,
    ),
  };
}

/**
 * Checks whether a cache payload can be reclaimed (no live bindings remain).
 */
export function isPayloadReclaimable(
  referenceSet: LiveReferenceSet,
): boolean {
  return referenceSet.bindings.every((b) => b.revoked);
}

/**
 * Checks whether a specific source can hit the cache (binding is not revoked).
 */
export function canSourceHitCache(
  referenceSet: LiveReferenceSet,
  sourceIdentity: string,
): boolean {
  const binding = referenceSet.bindings.find(
    (b) => b.sourceIdentity === sourceIdentity,
  );
  return binding !== undefined && !binding.revoked;
}

// -- PRD 674: Cache hit result -----------------------------------------------

export interface BillingProvenance {
  readonly isOriginal: boolean;
  readonly originalCost: number;
  readonly engine: string;
  readonly model: string;
}

export interface CacheHitResult {
  readonly cached: true;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly ageSeconds: number;
  readonly sourceHash: string;
  readonly engineVersion: string;
  readonly modelVersion: string;
  readonly billingProvenance: BillingProvenance;
}

export interface CacheMissResult {
  readonly cached: false;
  readonly reason: string;
}

export type CacheLookupResult = CacheHitResult | CacheMissResult;

export interface InvalidationCheck {
  readonly engineVersionChanged: boolean;
  readonly modelVersionChanged: boolean;
  readonly schemaVersionChanged: boolean;
  readonly policyVersionChanged: boolean;
  readonly sourceDeleted: boolean;
  readonly sourceExpired: boolean;
  readonly ownershipChanged: boolean;
  readonly explicitInvalidation: boolean;
}

/**
 * Determines whether a cache entry should be invalidated.
 */
export function shouldInvalidate(check: InvalidationCheck): boolean {
  return (
    check.engineVersionChanged ||
    check.modelVersionChanged ||
    check.schemaVersionChanged ||
    check.policyVersionChanged ||
    check.sourceDeleted ||
    check.sourceExpired ||
    check.ownershipChanged ||
    check.explicitInvalidation
  );
}

/**
 * Validates that a cache hit carries original billing provenance.
 */
export function validateCacheHit(hit: CacheHitResult): void {
  if (!hit.billingProvenance.isOriginal) {
    throw new Error("Cache hit must report original billing provenance, not new execution");
  }
  if (hit.ageSeconds < 0) {
    throw new Error("Cache hit ageSeconds must be non-negative");
  }
  if (hit.expiresAt <= hit.createdAt) {
    throw new Error("Cache hit expiresAt must be after createdAt");
  }
}

// -- PRD 677: Cache scope policy ---------------------------------------------

export type DocumentToolFamily = "document";
export type ExcludedTool = "web_fetch" | "web_extract" | "parse";

export interface CacheScopePolicy {
  readonly appliesTo: DocumentToolFamily;
  readonly excludes: readonly ExcludedTool[];
  readonly requiresNetworkPolicyCheck: boolean;
}

export const DEFAULT_CACHE_SCOPE_POLICY: CacheScopePolicy = {
  appliesTo: "document",
  excludes: ["web_fetch", "web_extract", "parse"],
  requiresNetworkPolicyCheck: true,
};

/**
 * Validates whether a tool is within the cache scope.
 */
export function validateCacheScope(
  toolName: string,
  policy: CacheScopePolicy,
): { allowed: boolean; reason: string } {
  if ((policy.excludes as readonly string[]).includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is excluded from document processing cache`,
    };
  }
  return { allowed: true, reason: "Tool is within cache scope" };
}

/**
 * Validates that URL-backed document operations complete network policy
 * checks before cache lookup.
 */
export function validateNetworkPolicyRequired(
  policy: CacheScopePolicy,
  networkPolicyChecked: boolean,
): void {
  if (policy.requiresNetworkPolicyCheck && !networkPolicyChecked) {
    throw new Error(
      "URL security/DNS/redirect checks must complete before cache lookup",
    );
  }
}

// -- PRD 682: Cache key separation -------------------------------------------

export interface CanonicalCoreKey {
  readonly contentHash: string;
  readonly engineVersion: string;
  readonly modelVersion: string;
  readonly schemaVersion: string;
  readonly policyVersion: string;
  readonly normalizedParseOptions: string;
}

export interface ProjectionCacheKey extends CanonicalCoreKey {
  readonly canonicalContentId: string;
  readonly projectionKind: string;
  readonly projectionVersion: string;
  readonly projectionOptions: string;
}

/**
 * Builds a canonical core key. Output mode is explicitly excluded.
 */
export function buildCanonicalCoreKey(params: {
  readonly contentHash: string;
  readonly engineVersion: string;
  readonly modelVersion: string;
  readonly schemaVersion: string;
  readonly policyVersion: string;
  readonly normalizedParseOptions: string;
}): CanonicalCoreKey {
  return {
    contentHash: params.contentHash,
    engineVersion: params.engineVersion,
    modelVersion: params.modelVersion,
    schemaVersion: params.schemaVersion,
    policyVersion: params.policyVersion,
    normalizedParseOptions: params.normalizedParseOptions,
  };
}

/**
 * Builds a projection cache key that extends the canonical core key.
 */
export function buildProjectionCacheKey(
  coreKey: CanonicalCoreKey,
  params: {
    readonly canonicalContentId: string;
    readonly projectionKind: string;
    readonly projectionVersion: string;
    readonly projectionOptions: string;
  },
): ProjectionCacheKey {
  return {
    ...coreKey,
    canonicalContentId: params.canonicalContentId,
    projectionKind: params.projectionKind,
    projectionVersion: params.projectionVersion,
    projectionOptions: params.projectionOptions,
  };
}

/**
 * Computes a deterministic key string from a canonical core key.
 * Output selection is deliberately excluded.
 */
export function canonicalCoreKeyString(key: CanonicalCoreKey): string {
  return [
    key.contentHash,
    key.engineVersion,
    key.modelVersion,
    key.schemaVersion,
    key.policyVersion,
    key.normalizedParseOptions,
  ].join(":");
}

/**
 * Computes a deterministic key string from a projection cache key.
 */
export function projectionCacheKeyString(key: ProjectionCacheKey): string {
  return [
    canonicalCoreKeyString(key),
    key.canonicalContentId,
    key.projectionKind,
    key.projectionVersion,
    key.projectionOptions,
  ].join(":");
}

// ---------------------------------------------------------------------------
// PRD 662: Document processing cache runtime (in-memory port)
// ---------------------------------------------------------------------------
//
// In-memory deterministic runtime behind the contract validators above.
// No live D1/KV/network: `DocumentCacheStorePort` is the explicit seam where
// a future durable backend replaces `InMemoryDocumentCacheStore`.
// Working default TTL is 24h via DEFAULT_CACHE_TTL_SECONDS.
//
// Modes:
// - use: hit-read, miss-execute-and-write
// - refresh: skip-read, re-execute-and-replace
// - bypass: no-read, no-write
// Operator-disabled degrades use/refresh to bypass (degraded=true).
// Tools outside document scope (web_fetch/web_extract/parse) are forced to
// bypass so existing contracts stay uncached.
// Cache failures never fail processing: get/set faults are captured as
// `cacheError` and the fresh execution result is still returned.

export const MAX_DOCUMENT_CACHE_ENTRIES = 500;
export const MAX_DOCUMENT_CACHE_KEY_CHARS = 2048;
export const MAX_SOURCE_IDENTITY_CHARS = 1024;

export interface DocumentCacheEntry {
  readonly key: ParsedPayloadCacheKey;
  readonly keyString: string;
  readonly payload: CachePayload;
  readonly bindings: LiveReferenceSet;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly provenance: BillingProvenance;
}

export interface DocumentCacheExecution<T> {
  readonly data: T;
  readonly provenance: BillingProvenance;
}

export interface DocumentCacheProcessParams<T> {
  readonly mode: CacheMode;
  readonly key: ParsedPayloadCacheKey;
  readonly sourceIdentity: string;
  readonly sourceVersion: string;
  readonly ownershipScope: string;
  readonly nowMs: number;
  readonly requestedTtlSeconds?: number;
  readonly toolName?: string;
  readonly networkPolicyChecked?: boolean;
  readonly execute: () => DocumentCacheExecution<T>;
}

export type DocumentCacheProcessResult<T> =
  | {
      readonly cached: true;
      readonly data: T;
      readonly hit: CacheHitResult;
      readonly cacheError?: string;
    }
  | {
      readonly cached: false;
      readonly data: T;
      readonly provenance: BillingProvenance;
      readonly stored: boolean;
      readonly degraded?: boolean;
      readonly cacheError?: string;
    };

/** Durable-backend port: D1/KV snapshots plug in here. */
export interface DocumentCacheStorePort {
  get(keyString: string): DocumentCacheEntry | undefined;
  set(entry: DocumentCacheEntry): void;
  revokeSourceBinding(sourceIdentity: string): void;
  size(): number;
  sweepExpired(nowMs: number): number;
}

function cacheRuntimeError(message: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "document-cache", message);
}

/**
 * Deterministic key string for the processing-cache runtime. Includes
 * ownershipScope + contentHash + engine/model/schema/policy versions.
 * URL/filename alone can never produce a valid key because contentHash,
 * engine, model, schema, and policy versions are all required.
 */
export function documentCacheKeyString(key: ParsedPayloadCacheKey): string {
  validateCacheKey(key);
  const raw = [
    key.ownershipScope,
    key.contentHash,
    key.engineId,
    key.engineVersion,
    key.modelId,
    key.modelVersion,
    key.normalizedOptions,
    key.schemaVersion,
    key.policyVersion,
  ].join(":");
  if (raw.length > MAX_DOCUMENT_CACHE_KEY_CHARS) {
    throw cacheRuntimeError(
      `Document cache key exceeds ${String(MAX_DOCUMENT_CACHE_KEY_CHARS)} characters`,
    );
  }
  return raw;
}

function buildPayloadId(keyString: string): string {
  return createHash("sha256").update(keyString).digest("hex").slice(0, 32);
}

function isExcludedTool(toolName: string | undefined): boolean {
  if (toolName === undefined) return false;
  return validateCacheScope(toolName, DEFAULT_CACHE_SCOPE_POLICY).allowed === false;
}

export class InMemoryDocumentCacheStore implements DocumentCacheStorePort {
  private readonly entries = new Map<string, DocumentCacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = MAX_DOCUMENT_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(keyString: string): DocumentCacheEntry | undefined {
    return this.entries.get(keyString);
  }

  set(entry: DocumentCacheEntry): void {
    if (!this.entries.has(entry.keyString) && this.entries.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestCreated = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.entries) {
        if (v.createdAt < oldestCreated) {
          oldestCreated = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(entry.keyString, entry);
  }

  revokeSourceBinding(sourceIdentity: string): void {
    for (const [k, entry] of this.entries) {
      const hasBinding = entry.bindings.bindings.some(
        (b) => b.sourceIdentity === sourceIdentity,
      );
      if (!hasBinding) continue;
      this.entries.set(k, {
        ...entry,
        bindings: revokeBinding(entry.bindings, sourceIdentity),
      });
    }
  }

  size(): number {
    return this.entries.size;
  }

  sweepExpired(nowMs: number): number {
    let removed = 0;
    for (const [k, entry] of this.entries) {
      if (nowMs > entry.expiresAt) {
        this.entries.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Revokes only the named source binding across all entries. */
export function revokeDocumentSourceBinding(
  store: DocumentCacheStorePort,
  sourceIdentity: string,
): void {
  if (sourceIdentity.length === 0 || sourceIdentity.length > MAX_SOURCE_IDENTITY_CHARS) {
    throw cacheRuntimeError("sourceIdentity must be non-empty and bounded");
  }
  store.revokeSourceBinding(sourceIdentity);
}

function buildEntry<T>(
  key: ParsedPayloadCacheKey,
  keyString: string,
  sourceIdentity: string,
  sourceVersion: string,
  ownershipScope: string,
  nowMs: number,
  expiresAt: number,
  execution: DocumentCacheExecution<T>,
): DocumentCacheEntry {
  const payloadId = buildPayloadId(keyString);
  const binding: SourceBinding = {
    bindingId: `bind-${sourceIdentity}@${sourceVersion}`,
    sourceIdentity,
    payloadId,
    ownershipScope,
    createdAt: nowMs,
    revoked: false,
  };
  return {
    key,
    keyString,
    payload: {
      payloadId,
      contentHash: key.contentHash,
      data: execution.data,
      createdAt: nowMs,
    },
    bindings: { payloadId, bindings: [binding] },
    createdAt: nowMs,
    expiresAt,
    provenance: execution.provenance,
  };
}

function toHitResult(
  entry: DocumentCacheEntry,
  nowMs: number,
): CacheHitResult {
  const ageSeconds = Math.max(0, Math.floor((nowMs - entry.createdAt) / 1000));
  const hit: CacheHitResult = {
    cached: true,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    ageSeconds,
    sourceHash: entry.key.contentHash,
    engineVersion: entry.key.engineVersion,
    modelVersion: entry.key.modelVersion,
    billingProvenance: entry.provenance,
  };
  validateCacheHit(hit);
  return hit;
}

/**
 * Runs one document-cache operation with the requested mode.
 * Never throws for store faults: they are captured as `cacheError`.
 * Throws (sanitized, no payload/secret) for invalid keys, ownership
 * mismatch, or missing network-policy evidence.
 */
export function processDocumentCache<T>(
  store: DocumentCacheStorePort,
  config: CacheConfig,
  params: DocumentCacheProcessParams<T>,
): DocumentCacheProcessResult<T> {
  if (params.sourceIdentity.length === 0 || params.sourceIdentity.length > MAX_SOURCE_IDENTITY_CHARS) {
    throw cacheRuntimeError("sourceIdentity must be non-empty and bounded");
  }
  if (!Number.isInteger(params.nowMs) || params.nowMs <= 0) {
    throw cacheRuntimeError("nowMs must be a positive integer");
  }
  validateCacheKey(params.key);
  validateOwnershipScope(params.ownershipScope, params.key.ownershipScope);
  if (params.networkPolicyChecked === false) {
    validateNetworkPolicyRequired(DEFAULT_CACHE_SCOPE_POLICY, false);
  }

  const resolved = resolveCacheMode(params.mode, config);
  let effectiveMode = resolved.effectiveMode;
  if (isExcludedTool(params.toolName)) {
    effectiveMode = "bypass";
  }

  const runExecute = (): DocumentCacheExecution<T> => params.execute();

  if (effectiveMode === "bypass") {
    const execution = runExecute();
    const result: DocumentCacheProcessResult<T> = resolved.degraded
      ? {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
          degraded: true,
        }
      : { cached: false, data: execution.data, provenance: execution.provenance, stored: false };
    return result;
  }

  const keyString = documentCacheKeyString(params.key);
  const ttlSeconds = resolveEffectiveTtl(params.requestedTtlSeconds, config);
  const expiresAt = params.nowMs + ttlSeconds * 1000;

  if (effectiveMode === "refresh") {
    const execution = runExecute();
    try {
      let next: DocumentCacheEntry;
      const existing = store.get(keyString);
      if (existing === undefined) {
        next = buildEntry(
          params.key,
          keyString,
          params.sourceIdentity,
          params.sourceVersion,
          params.ownershipScope,
          params.nowMs,
          expiresAt,
          execution,
        );
      } else {
        const hasBinding = existing.bindings.bindings.some(
          (b) => b.sourceIdentity === params.sourceIdentity,
        );
        const binding: SourceBinding = {
          bindingId: `bind-${params.sourceIdentity}@${params.sourceVersion}`,
          sourceIdentity: params.sourceIdentity,
          payloadId: existing.payload.payloadId,
          ownershipScope: params.ownershipScope,
          createdAt: params.nowMs,
          revoked: false,
        };
        const bindings: LiveReferenceSet = hasBinding
          ? {
              payloadId: existing.payload.payloadId,
              bindings: existing.bindings.bindings.map((b) =>
                b.sourceIdentity === params.sourceIdentity ? binding : b,
              ),
            }
          : {
              payloadId: existing.payload.payloadId,
              bindings: [...existing.bindings.bindings, binding],
            };
        next = {
          key: params.key,
          keyString,
          payload: {
            payloadId: existing.payload.payloadId,
            contentHash: params.key.contentHash,
            data: execution.data,
            createdAt: params.nowMs,
          },
          bindings,
          createdAt: params.nowMs,
          expiresAt,
          provenance: execution.provenance,
        };
      }
      store.set(next);
    } catch (error) {
      const cacheError = error instanceof Error ? error.message.slice(0, 500) : "Cache operation failed";
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: false,
        cacheError,
      };
    }
    return {
      cached: false,
      data: execution.data,
      provenance: execution.provenance,
      stored: true,
    };
  }

  // effectiveMode === "use": try read, miss -> execute and write.
  let cachedEntry: DocumentCacheEntry | undefined;
  let readError: string | undefined;
  try {
    cachedEntry = store.get(keyString);
  } catch (error) {
    readError = error instanceof Error ? error.message.slice(0, 500) : "Cache read failed";
    cachedEntry = undefined;
  }
  if (cachedEntry !== undefined && readError === undefined) {
    const expired = params.nowMs > cachedEntry.expiresAt;
    const existingBinding = cachedEntry.bindings.bindings.find(
      (b) => b.sourceIdentity === params.sourceIdentity,
    );
    const bindingLive = existingBinding !== undefined && !existingBinding.revoked;
    const ownershipOk = cachedEntry.bindings.bindings.every(
      (b) => b.ownershipScope === params.ownershipScope || b.sourceIdentity !== params.sourceIdentity,
    );
    if (!expired && bindingLive && ownershipOk) {
      try {
        validateOwnershipScope(params.ownershipScope, cachedEntry.key.ownershipScope);
        const hit = toHitResult(cachedEntry, params.nowMs);
        return {
          cached: true,
          data: cachedEntry.payload.data as T,
          hit,
        };
      } catch (error) {
        readError = error instanceof Error ? error.message.slice(0, 500) : "Cache hit validation failed";
      }
    }
    // Revoked binding: source deleted -> miss without restoring the binding.
    // Missing binding (never seen source): fall through to execute-and-append below.
    if (existingBinding !== undefined && !bindingLive) {
      const execution = runExecute();
      if (readError !== undefined) {
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
          cacheError: readError,
        };
      }
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: false,
      };
    }
    if (!expired && existingBinding === undefined) {
      // Same payload shared by a new source: execute then append binding.
      const execution = runExecute();
      try {
        const latest = store.get(keyString);
        if (latest !== undefined && params.nowMs <= latest.expiresAt) {
          const binding: SourceBinding = {
            bindingId: `bind-${params.sourceIdentity}@${params.sourceVersion}`,
            sourceIdentity: params.sourceIdentity,
            payloadId: latest.payload.payloadId,
            ownershipScope: params.ownershipScope,
            createdAt: params.nowMs,
            revoked: false,
          };
          store.set({
            ...latest,
            bindings: {
              payloadId: latest.payload.payloadId,
              bindings: [...latest.bindings.bindings, binding],
            },
          });
          return {
            cached: false,
            data: execution.data,
            provenance: execution.provenance,
            stored: true,
          };
        }
      } catch (error) {
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
          cacheError: error instanceof Error ? error.message.slice(0, 500) : "Cache write failed",
        };
      }
      // Entry vanished/expired between reads: fall through to create path.
      try {
        store.set(
          buildEntry(
            params.key,
            keyString,
            params.sourceIdentity,
            params.sourceVersion,
            params.ownershipScope,
            params.nowMs,
            expiresAt,
            execution,
          ),
        );
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: true,
        };
      } catch (error) {
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
          cacheError: error instanceof Error ? error.message.slice(0, 500) : "Cache write failed",
        };
      }
    }
  }

  const execution = runExecute();
  if (readError !== undefined) {
    return {
      cached: false,
      data: execution.data,
      provenance: execution.provenance,
      stored: false,
      cacheError: readError,
    };
  }
  try {
    const existing = store.get(keyString);
    if (existing === undefined || params.nowMs > existing.expiresAt) {
      store.set(
        buildEntry(
          params.key,
          keyString,
          params.sourceIdentity,
          params.sourceVersion,
          params.ownershipScope,
          params.nowMs,
          expiresAt,
          execution,
        ),
      );
    } else {
      const hasBinding = existing.bindings.bindings.some(
        (b) => b.sourceIdentity === params.sourceIdentity,
      );
      if (!hasBinding) {
        const binding: SourceBinding = {
          bindingId: `bind-${params.sourceIdentity}@${params.sourceVersion}`,
          sourceIdentity: params.sourceIdentity,
          payloadId: existing.payload.payloadId,
          ownershipScope: params.ownershipScope,
          createdAt: params.nowMs,
          revoked: false,
        };
        store.set({
          ...existing,
          bindings: {
            payloadId: existing.payload.payloadId,
            bindings: [...existing.bindings.bindings, binding],
          },
        });
      }
    }
    return {
      cached: false,
      data: execution.data,
      provenance: execution.provenance,
      stored: true,
    };
  } catch (error) {
    return {
      cached: false,
      data: execution.data,
      provenance: execution.provenance,
      stored: false,
      cacheError: error instanceof Error ? error.message.slice(0, 500) : "Cache write failed",
    };
  }
}
