import { z } from "zod";

import type { ManagedClock } from "../worker/managed-tokens.js";
import type {
  AuthenticatedPrincipal,
  TimingSafeSubtleCrypto,
} from "../worker/auth.js";
import {
  INTERNAL_CONTEXT_HEADER,
  INTERNAL_REQUEST_ID_HEADER,
  mintInternalContext,
  verifyInternalContext,
  type InternalContextPayload,
} from "../worker/internal-context.js";

export const DOCUMENT_CACHE_BRIDGE_HOST = "groundlane-cache.internal";
export const DOCUMENT_CACHE_BRIDGE_AUDIENCE = "groundlane-worker-cache-v1";
export const DOCUMENT_CACHE_BRIDGE_ISSUER = "groundlane-container";
export const DOCUMENT_CACHE_LOOKUP_PATH = "/v1/lookup";
export const DOCUMENT_CACHE_COMMIT_PATH = "/v1/commit";
export const DOCUMENT_CACHE_REVOKE_PATH = "/v1/revoke";
export const DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES = 32 * 1024 * 1024 + 64 * 1024;
export const DOCUMENT_CACHE_BRIDGE_VERSION = 1;

const boundedRequiredString = z.string().min(1).max(2048);
const boundedOptionalString = z.string().max(2048);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const documentCacheKeySchema = z.object({
  ownershipScope: boundedRequiredString,
  contentHash: boundedRequiredString,
  engineId: boundedRequiredString,
  engineVersion: boundedRequiredString,
  modelId: boundedRequiredString,
  modelVersion: boundedRequiredString,
  normalizedOptions: boundedOptionalString,
  schemaVersion: boundedRequiredString,
  policyVersion: boundedRequiredString,
}).strict();

export const documentCacheIdentitySchema = z.object({
  mode: z.enum(["use", "refresh", "bypass"]),
  key: documentCacheKeySchema,
  sourceIdentity: z.string().min(1).max(1024),
  sourceVersion: boundedRequiredString,
  ownershipScope: boundedRequiredString,
  nowMs: positiveSafeInteger,
  sourceExpiresAt: positiveSafeInteger.optional(),
  requestedTtlSeconds: nonnegativeSafeInteger.optional(),
  toolName: z.string().min(1).max(128).optional(),
  networkPolicyChecked: z.boolean().optional(),
}).strict();

export const documentCacheBillingProvenanceSchema = z.object({
  isOriginal: z.boolean(),
  originalCost: z.number().finite(),
  engine: boundedRequiredString,
  model: boundedRequiredString,
}).strict();

export const documentCacheLookupMissSchema = z.object({
  cached: z.literal(false),
  disposition: z.enum(["ordinary", "revoked", "disabled", "bypass", "refresh"]),
  commitFence: z.object({
    bindingRevision: nonnegativeSafeInteger.nullable(),
  }).strict().optional(),
  degraded: z.boolean().optional(),
  cacheError: z.string().min(1).max(256).optional(),
}).strict();

const documentCacheHitSchema = z.object({
  cached: z.literal(true),
  createdAt: positiveSafeInteger,
  expiresAt: positiveSafeInteger,
  ageSeconds: nonnegativeSafeInteger,
  sourceHash: boundedRequiredString,
  engineVersion: boundedRequiredString,
  modelVersion: boundedRequiredString,
  billingProvenance: documentCacheBillingProvenanceSchema,
}).strict();

export const documentCacheLookupResultSchema = z.union([
  z.object({
    cached: z.literal(true),
    data: z.unknown(),
    hit: documentCacheHitSchema,
  }).strict(),
  documentCacheLookupMissSchema,
]);

export const documentCacheExecutionSchema = z.object({
  data: z.unknown(),
  provenance: documentCacheBillingProvenanceSchema,
}).strict();

export const documentCacheCommitResultSchema = z.object({
  cached: z.literal(false),
  data: z.unknown(),
  provenance: documentCacheBillingProvenanceSchema,
  stored: z.boolean(),
  createdAt: positiveSafeInteger.optional(),
  expiresAt: positiveSafeInteger.optional(),
  degraded: z.boolean().optional(),
  cacheError: z.string().min(1).max(256).optional(),
}).strict();

const documentCacheBridgeRequestBaseSchema = z.object({
  version: z.literal(DOCUMENT_CACHE_BRIDGE_VERSION),
  deadlineAt: positiveSafeInteger,
});

export const documentCacheLookupBridgeRequestSchema = documentCacheBridgeRequestBaseSchema.extend({
  operation: z.literal("lookup"),
  identity: documentCacheIdentitySchema,
}).strict();

export const documentCacheCommitBridgeRequestSchema = documentCacheBridgeRequestBaseSchema.extend({
  operation: z.literal("commit"),
  identity: documentCacheIdentitySchema,
  execution: documentCacheExecutionSchema,
  decision: documentCacheLookupMissSchema,
}).strict();

export const documentCacheBridgeRequestSchema = z.discriminatedUnion("operation", [
  documentCacheLookupBridgeRequestSchema,
  documentCacheCommitBridgeRequestSchema,
  documentCacheBridgeRequestBaseSchema.extend({ operation: z.literal("revoke"), sourceIdentity: z.string().min(1).max(1024) }).strict(),
]);

export const documentCacheBridgeErrorSchema = z.object({
  code: z.enum(["DOCUMENT_CACHE_INVALID_REQUEST", "DOCUMENT_CACHE_UNAVAILABLE"]),
  retryable: z.boolean(),
}).strict();

export const documentCacheLookupBridgeResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(DOCUMENT_CACHE_BRIDGE_VERSION),
    ok: z.literal(true),
    result: documentCacheLookupResultSchema,
  }).strict(),
  z.object({
    version: z.literal(DOCUMENT_CACHE_BRIDGE_VERSION),
    ok: z.literal(false),
    error: documentCacheBridgeErrorSchema,
  }).strict(),
]);

export const documentCacheCommitBridgeResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(DOCUMENT_CACHE_BRIDGE_VERSION),
    ok: z.literal(true),
    result: documentCacheCommitResultSchema,
  }).strict(),
  z.object({
    version: z.literal(DOCUMENT_CACHE_BRIDGE_VERSION),
    ok: z.literal(false),
    error: documentCacheBridgeErrorSchema,
  }).strict(),
]);

export type DocumentCacheLookupBridgeRequest = z.infer<typeof documentCacheLookupBridgeRequestSchema>;
export type DocumentCacheCommitBridgeRequest = z.infer<typeof documentCacheCommitBridgeRequestSchema>;
export type DocumentCacheLookupBridgeResponse = z.infer<typeof documentCacheLookupBridgeResponseSchema>;
export type DocumentCacheCommitBridgeResponse = z.infer<typeof documentCacheCommitBridgeResponseSchema>;

export type DocumentCacheBridgePath =
  | typeof DOCUMENT_CACHE_LOOKUP_PATH
  | typeof DOCUMENT_CACHE_COMMIT_PATH
  | typeof DOCUMENT_CACHE_REVOKE_PATH;

export interface VerifiedDocumentCacheBridgeRequest {
  readonly ok: true;
  readonly body: Uint8Array;
  readonly context: InternalContextPayload;
}

export interface RejectedDocumentCacheBridgeRequest {
  readonly ok: false;
  readonly status: 400 | 401 | 413;
  readonly code: "invalid_request" | "invalid_context" | "payload_too_large";
}

interface DocumentCacheBridgeRequestLike {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function purposeFor(path: DocumentCacheBridgePath): string {
  if (path === DOCUMENT_CACHE_REVOKE_PATH) return "document-cache-revoke";
  return path === DOCUMENT_CACHE_LOOKUP_PATH
    ? "document-cache-lookup"
    : "document-cache-commit";
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(
  body: Uint8Array,
  subtle: TimingSafeSubtleCrypto,
): Promise<string> {
  const copied = new Uint8Array(body.byteLength);
  copied.set(body);
  return `sha256-${hex(await subtle.digest("SHA-256", copied.buffer))}`;
}

function assertBodyBound(body: Uint8Array): void {
  if (body.byteLength < 1 || body.byteLength > DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES) {
    throw new Error("document cache bridge body is outside the supported bounds");
  }
}

/** Build one body-bound Container-to-Worker cache request for the synthetic host. */
export async function buildDocumentCacheBridgeRequest(options: {
  readonly path: DocumentCacheBridgePath;
  readonly body: Uint8Array;
  readonly signingSecret: string;
  readonly requestId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly credentialBinding: string;
  readonly subtle: TimingSafeSubtleCrypto;
  readonly clock: ManagedClock;
  readonly signal?: AbortSignal;
}): Promise<Request> {
  assertBodyBound(options.body);
  const bodySha256 = await digest(options.body, options.subtle);
  const token = await mintInternalContext({
    issuer: DOCUMENT_CACHE_BRIDGE_ISSUER,
    signingSecret: options.signingSecret,
    audience: DOCUMENT_CACHE_BRIDGE_AUDIENCE,
    method: "POST",
    path: options.path,
    requestId: options.requestId,
    principal: options.principal,
    credentialBinding: options.credentialBinding,
    purpose: purposeFor(options.path),
    bodySha256,
  }, options.subtle, options.clock);
  const body = options.body.slice();
  return new Request(`http://${DOCUMENT_CACHE_BRIDGE_HOST}${options.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INTERNAL_CONTEXT_HEADER]: token,
      [INTERNAL_REQUEST_ID_HEADER]: options.requestId,
    },
    body,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** Verify direction, route, request ID, and exact body before decoding cache JSON. */
export async function verifyDocumentCacheBridgeRequest(
  request: DocumentCacheBridgeRequestLike,
  signingSecret: string,
  subtle: TimingSafeSubtleCrypto,
  clock: ManagedClock,
): Promise<VerifiedDocumentCacheBridgeRequest | RejectedDocumentCacheBridgeRequest> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== "POST" || url.hostname !== DOCUMENT_CACHE_BRIDGE_HOST ||
      (path !== DOCUMENT_CACHE_LOOKUP_PATH && path !== DOCUMENT_CACHE_COMMIT_PATH && path !== DOCUMENT_CACHE_REVOKE_PATH) ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return { ok: false, status: 400, code: "invalid_request" };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: "payload_too_large" };
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength < 1 || body.byteLength > DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: "payload_too_large" };
  }
  const requestId = request.headers.get(INTERNAL_REQUEST_ID_HEADER);
  if (requestId === null || requestId.length === 0 || requestId.length > 128) {
    return { ok: false, status: 401, code: "invalid_context" };
  }
  const typedPath = path;
  const verified = await verifyInternalContext(
    request.headers.get(INTERNAL_CONTEXT_HEADER),
    {
      signingSecret,
      expectedIssuer: DOCUMENT_CACHE_BRIDGE_ISSUER,
      expectedAudience: DOCUMENT_CACHE_BRIDGE_AUDIENCE,
      expectedMethod: "POST",
      expectedPath: typedPath,
      expectedRequestId: requestId,
      expectedPurpose: purposeFor(typedPath),
      expectedBodySha256: await digest(body, subtle),
    },
    subtle,
    clock,
  );
  return verified.ok
    ? { ok: true, body, context: verified.payload }
    : { ok: false, status: 401, code: "invalid_context" };
}
