// ---------------------------------------------------------------------------
// PRD 671, 672, 673, 674, 677, 682 -- Document processing cache contract
// ---------------------------------------------------------------------------

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
