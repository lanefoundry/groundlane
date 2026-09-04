// ---------------------------------------------------------------------------
// Document policy capability view runtime (PRD 666).
//
// Pure function module: announces cache/upload/artifact/corpus defaults and
// hard caps, and resolves an effective absolute expiry per section. This
// module is intentionally NOT mounted on the MCP registry and imports
// nothing from registry, tools, worker, or Cloudflare bindings.
//
// Expiry rules (aligned with DocumentSource ExpiryRequest semantics in
// `src/core/document-source.ts`, absolute unit is epoch milliseconds):
// - Relative and absolute expiry are mutually exclusive.
// - Neither provided resolves to the section default.
// - Out-of-bounds requests are validation errors, never silently clamped.
// ---------------------------------------------------------------------------

import { GroundlaneError, hint } from "./errors.js";

export interface PolicyExpiryRequest {
  readonly relativeTtlSeconds?: number;
  readonly absoluteExpiresAtMs?: number;
}

export interface PolicySectionBounds {
  readonly defaultTtlSeconds: number;
  readonly minTtlSeconds: number;
  readonly maxTtlSeconds: number;
}

export interface PolicySectionView extends PolicySectionBounds {
  readonly effectiveExpiresAtMs: number;
  readonly effectiveExpiresAt: string;
}

export interface DocumentPolicyView {
  readonly cache: PolicySectionView;
  readonly upload: PolicySectionView;
  readonly artifact: PolicySectionView;
  readonly corpus: PolicySectionView;
}

export interface DocumentPolicyOverrides {
  readonly cache?: PolicyExpiryRequest;
  readonly upload?: PolicyExpiryRequest;
  readonly artifact?: PolicyExpiryRequest;
  readonly corpus?: PolicyExpiryRequest;
}

// Working defaults and hard caps. Upload intent default is 15 minutes and
// verified-artifact default is 24 hours, matching the upload-intent lifecycle;
// the processing cache working default is 24 hours.
export const CACHE_BOUNDS: PolicySectionBounds = {
  defaultTtlSeconds: 86400,
  minTtlSeconds: 60,
  maxTtlSeconds: 2592000,
};

export const UPLOAD_BOUNDS: PolicySectionBounds = {
  defaultTtlSeconds: 900,
  minTtlSeconds: 60,
  maxTtlSeconds: 3600,
};

export const ARTIFACT_BOUNDS: PolicySectionBounds = {
  defaultTtlSeconds: 86400,
  minTtlSeconds: 300,
  maxTtlSeconds: 7776000,
};

export const CORPUS_BOUNDS: PolicySectionBounds = {
  defaultTtlSeconds: 7776000,
  minTtlSeconds: 86400,
  maxTtlSeconds: 31536000,
};

function policyError(message: string): GroundlaneError {
  return new GroundlaneError(
    "INVALID_INPUT",
    "document-policy",
    message,
    false,
    undefined,
    hint("document_policy.invalid_expiry", "Pass either relativeTtlSeconds or absoluteExpiresAtMs within the announced min/max bounds."),
  );
}

/**
 * Resolves one section's effective absolute expiry (epoch milliseconds).
 * Throws on mutually-exclusive, missing-basis, non-integer, non-positive,
 * below-minimum, or above-maximum requests. Never clamps.
 */
export function resolveSectionExpiry(
  request: PolicyExpiryRequest,
  bounds: PolicySectionBounds,
  nowMs: number,
): number {
  const hasRelative = request.relativeTtlSeconds !== undefined;
  const hasAbsolute = request.absoluteExpiresAtMs !== undefined;
  if (hasRelative && hasAbsolute) {
    throw policyError("Relative and absolute expiry are mutually exclusive");
  }
  let effectiveTtlSeconds: number;
  if (!hasRelative && !hasAbsolute) {
    effectiveTtlSeconds = bounds.defaultTtlSeconds;
  } else if (hasRelative) {
    const ttl = request.relativeTtlSeconds ?? bounds.defaultTtlSeconds;
    if (!Number.isInteger(ttl)) {
      throw policyError("relativeTtlSeconds must be an integer number of seconds");
    }
    effectiveTtlSeconds = ttl;
  } else {
    const absoluteMs = request.absoluteExpiresAtMs ?? nowMs + bounds.defaultTtlSeconds * 1000;
    if (!Number.isInteger(absoluteMs)) {
      throw policyError("absoluteExpiresAtMs must be an integer number of milliseconds");
    }
    effectiveTtlSeconds = Math.floor((absoluteMs - nowMs) / 1000);
  }
  if (effectiveTtlSeconds < bounds.minTtlSeconds) {
    throw policyError(
      `Requested TTL ${String(effectiveTtlSeconds)}s is below minimum ${String(bounds.minTtlSeconds)}s`,
    );
  }
  if (effectiveTtlSeconds > bounds.maxTtlSeconds) {
    throw policyError(
      `Requested TTL ${String(effectiveTtlSeconds)}s exceeds maximum ${String(bounds.maxTtlSeconds)}s`,
    );
  }
  return nowMs + effectiveTtlSeconds * 1000;
}

function viewSection(
  bounds: PolicySectionBounds,
  request: PolicyExpiryRequest | undefined,
  nowMs: number,
): PolicySectionView {
  const effectiveExpiresAtMs = resolveSectionExpiry(request ?? {}, bounds, nowMs);
  return {
    defaultTtlSeconds: bounds.defaultTtlSeconds,
    minTtlSeconds: bounds.minTtlSeconds,
    maxTtlSeconds: bounds.maxTtlSeconds,
    effectiveExpiresAtMs,
    effectiveExpiresAt: new Date(effectiveExpiresAtMs).toISOString(),
  };
}

/**
 * Returns the full capability view. Every section carries its defaults,
 * hard caps, and the effective absolute expiry resolved at nowMs.
 */
export function getDocumentPolicyView(
  nowMs: number,
  overrides?: DocumentPolicyOverrides,
): DocumentPolicyView {
  if (!Number.isInteger(nowMs) || nowMs <= 0) {
    throw policyError("nowMs must be a positive integer number of milliseconds");
  }
  return {
    cache: viewSection(CACHE_BOUNDS, overrides?.cache, nowMs),
    upload: viewSection(UPLOAD_BOUNDS, overrides?.upload, nowMs),
    artifact: viewSection(ARTIFACT_BOUNDS, overrides?.artifact, nowMs),
    corpus: viewSection(CORPUS_BOUNDS, overrides?.corpus, nowMs),
  };
}
