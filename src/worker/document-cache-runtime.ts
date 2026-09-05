import type {
  OutboundHandler,
  OutboundHandlerContext,
} from "@cloudflare/containers";

import type {
  CacheConfig,
  DocumentCacheIdentity,
  DocumentCacheLookupMiss,
} from "../core/document-cache-contract.js";
import {
  DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES,
  DOCUMENT_CACHE_BRIDGE_VERSION,
  DOCUMENT_CACHE_COMMIT_PATH,
  DOCUMENT_CACHE_LOOKUP_PATH,
  DOCUMENT_CACHE_REVOKE_PATH,
  documentCacheBridgeRequestSchema,
  documentCacheCommitBridgeResponseSchema,
  documentCacheLookupBridgeResponseSchema,
  verifyDocumentCacheBridgeRequest,
  type DocumentCacheCommitBridgeRequest,
  type DocumentCacheCommitBridgeResponse,
  type DocumentCacheLookupBridgeResponse,
} from "../mcp/document-cache-bridge.js";
import type { TimingSafeSubtleCrypto } from "./auth.js";
import {
  D1R2DocumentCacheRuntime,
} from "./d1-r2-document-cache.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";
import {
  systemUtcClock,
  type ManagedClock,
} from "./managed-tokens.js";
import type { R2BucketLike } from "./r2-immutable-blob.js";

const GROUNDLANE_CONTAINER_CLASS = "GroundlaneContainer";
const DEFAULT_CACHE_TTL_SECONDS = 86_400;
const DEFAULT_CACHE_MAX_TTL_SECONDS = 2_592_000;
const MIN_CACHE_TTL_SECONDS = 60;
const MAX_CACHE_TTL_SECONDS = 2_592_000;
const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

export interface DocumentCacheOutboundEnv {
  readonly GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
  readonly MANAGED_TOKEN_D1?: D1DatabaseLike;
  readonly GROUNDLANE_ARTIFACTS?: R2BucketLike;
  readonly DOCUMENT_CACHE_EDGE_ENABLED?: string;
  readonly DOCUMENT_CACHE_DEFAULT_TTL_SECONDS?: string;
  readonly DOCUMENT_CACHE_MAX_TTL_SECONDS?: string;
}

export interface DocumentCacheOutboundDependencies {
  readonly subtle?: TimingSafeSubtleCrypto;
  readonly clock?: ManagedClock;
}

export type DocumentCacheOutboundHandler = (
  request: Request,
  env: DocumentCacheOutboundEnv,
  context: OutboundHandlerContext,
) => Promise<Response>;

function unavailable(status = 503): Response {
  return boundedJsonResponse({
    version: DOCUMENT_CACHE_BRIDGE_VERSION,
    ok: false,
    error: {
      code: "DOCUMENT_CACHE_UNAVAILABLE",
      retryable: true,
    },
  }, status);
}

function invalidRequest(status = 400): Response {
  return boundedJsonResponse({
    version: DOCUMENT_CACHE_BRIDGE_VERSION,
    ok: false,
    error: {
      code: "DOCUMENT_CACHE_INVALID_REQUEST",
      retryable: false,
    },
  }, status);
}

function boundedJsonResponse(value: unknown, status = 200): Response {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = JSON.stringify({
      version: DOCUMENT_CACHE_BRIDGE_VERSION,
      ok: false,
      error: {
        code: "DOCUMENT_CACHE_UNAVAILABLE",
        retryable: true,
      },
    });
    status = 503;
  }
  if (new TextEncoder().encode(encoded).byteLength > DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES) {
    encoded = JSON.stringify({
      version: DOCUMENT_CACHE_BRIDGE_VERSION,
      ok: false,
      error: {
        code: "DOCUMENT_CACHE_UNAVAILABLE",
        retryable: true,
      },
    });
    status = 503;
  }
  return new Response(encoded, { status, headers: JSON_HEADERS });
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("document cache configuration is unavailable");
}

function parseTtl(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) {
    throw new Error("document cache configuration is unavailable");
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_CACHE_TTL_SECONDS ||
    parsed > MAX_CACHE_TTL_SECONDS
  ) {
    throw new Error("document cache configuration is unavailable");
  }
  return parsed;
}

function cacheConfigFromEnv(env: DocumentCacheOutboundEnv): CacheConfig {
  const defaultTtlSeconds = parseTtl(
    env.DOCUMENT_CACHE_DEFAULT_TTL_SECONDS,
    DEFAULT_CACHE_TTL_SECONDS,
  );
  const operatorMaxTtlSeconds = parseTtl(
    env.DOCUMENT_CACHE_MAX_TTL_SECONDS,
    DEFAULT_CACHE_MAX_TTL_SECONDS,
  );
  if (defaultTtlSeconds > operatorMaxTtlSeconds) {
    throw new Error("document cache configuration is unavailable");
  }
  return {
    enabled: parseBoolean(env.DOCUMENT_CACHE_EDGE_ENABLED),
    defaultTtlSeconds,
    operatorMaxTtlSeconds,
  };
}

function identityFromBridge(
  value: DocumentCacheCommitBridgeRequest["identity"],
): DocumentCacheIdentity {
  return {
    mode: value.mode,
    key: value.key,
    sourceIdentity: value.sourceIdentity,
    sourceVersion: value.sourceVersion,
    ownershipScope: value.ownershipScope,
    nowMs: value.nowMs,
    ...(value.sourceExpiresAt === undefined
      ? {}
      : { sourceExpiresAt: value.sourceExpiresAt }),
    ...(value.requestedTtlSeconds === undefined
      ? {}
      : { requestedTtlSeconds: value.requestedTtlSeconds }),
    ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    ...(value.networkPolicyChecked === undefined
      ? {}
      : { networkPolicyChecked: value.networkPolicyChecked }),
  };
}

function lookupMissFromBridge(
  value: DocumentCacheCommitBridgeRequest["decision"],
): DocumentCacheLookupMiss {
  return {
    cached: false,
    disposition: value.disposition,
    ...(value.commitFence === undefined
      ? {}
      : { commitFence: value.commitFence }),
    ...(value.degraded === undefined ? {} : { degraded: value.degraded }),
    ...(value.cacheError === undefined ? {} : { cacheError: value.cacheError }),
  };
}

function validContainerContext(context: OutboundHandlerContext): boolean {
  return context.className === GROUNDLANE_CONTAINER_CLASS &&
    context.containerId.length > 0 &&
    context.containerId.length <= 256 &&
    context.params === undefined;
}

function deadlineExceeded(
  request: Request,
  deadlineAt: number,
  clock: ManagedClock,
): boolean {
  return request.signal.aborted || clock.now() >= deadlineAt;
}

async function executeDocumentCacheOutbound(
  request: Request,
  env: DocumentCacheOutboundEnv,
  context: OutboundHandlerContext,
  dependencies: DocumentCacheOutboundDependencies,
): Promise<Response> {
  if (!validContainerContext(context)) return invalidRequest(403);
  if (request.signal.aborted) return unavailable();

  const signingSecret = env.GROUNDLANE_INTERNAL_SIGNING_SECRET;
  if (signingSecret === undefined || signingSecret.length === 0) return unavailable();
  const clock = dependencies.clock ?? systemUtcClock();
  const subtle = dependencies.subtle ?? crypto.subtle;

  let verified: Awaited<ReturnType<typeof verifyDocumentCacheBridgeRequest>>;
  try {
    verified = await verifyDocumentCacheBridgeRequest(
      request,
      signingSecret,
      subtle,
      clock,
    );
  } catch {
    return request.signal.aborted ? unavailable() : invalidRequest();
  }
  if (!verified.ok) return invalidRequest(verified.status);
  if (request.signal.aborted) return unavailable();

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(verified.body),
    ) as unknown;
  } catch {
    return invalidRequest();
  }
  const parsed = documentCacheBridgeRequestSchema.safeParse(decoded);
  if (!parsed.success) return invalidRequest();
  const body = parsed.data;
  const url = new URL(request.url);
  if (body.operation === "revoke") {
    if (url.pathname !== DOCUMENT_CACHE_REVOKE_PATH || !verified.context.principal.scopes.includes("mcp")) return invalidRequest(403);
    if (deadlineExceeded(request, body.deadlineAt, clock)) return unavailable();
    if (env.MANAGED_TOKEN_D1 === undefined || env.GROUNDLANE_ARTIFACTS === undefined) return unavailable();
    const runtime = new D1R2DocumentCacheRuntime({ db: env.MANAGED_TOKEN_D1, bucket: env.GROUNDLANE_ARTIFACTS });
    try {
      const result = await runtime.revokeAllSourceBindings({ sourceIdentity: body.sourceIdentity, ownershipScope: verified.context.principal.principalId, nowMs: clock.now() });
      return deadlineExceeded(request, body.deadlineAt, clock) ? unavailable() : boundedJsonResponse({ version: DOCUMENT_CACHE_BRIDGE_VERSION, ok: true, result });
    } catch { return unavailable(); }
  }
  if (
    (body.operation === "lookup" && url.pathname !== DOCUMENT_CACHE_LOOKUP_PATH) ||
    (body.operation === "commit" && url.pathname !== DOCUMENT_CACHE_COMMIT_PATH)
  ) {
    return invalidRequest();
  }
  if (deadlineExceeded(request, body.deadlineAt, clock)) return unavailable();
  if (
    verified.context.principal.principalId !== body.identity.ownershipScope ||
    body.identity.key.ownershipScope !== body.identity.ownershipScope ||
    !verified.context.principal.scopes.includes("mcp")
  ) {
    return invalidRequest(403);
  }

  let config: CacheConfig;
  try {
    config = cacheConfigFromEnv(env);
  } catch {
    return unavailable();
  }
  if (
    body.identity.requestedTtlSeconds !== undefined &&
    (body.identity.requestedTtlSeconds < MIN_CACHE_TTL_SECONDS ||
      body.identity.requestedTtlSeconds > (config.operatorMaxTtlSeconds ?? 0))
  ) {
    return invalidRequest();
  }
  if (
    env.MANAGED_TOKEN_D1 === undefined ||
    env.GROUNDLANE_ARTIFACTS === undefined
  ) {
    return unavailable();
  }

  const runtime = new D1R2DocumentCacheRuntime({
    db: env.MANAGED_TOKEN_D1,
    bucket: env.GROUNDLANE_ARTIFACTS,
  });
  const identity = identityFromBridge(body.identity);
  try {
    if (body.operation === "lookup") {
      const result = await runtime.lookup(config, identity);
      if (deadlineExceeded(request, body.deadlineAt, clock)) return unavailable();
      const response: DocumentCacheLookupBridgeResponse = {
        version: DOCUMENT_CACHE_BRIDGE_VERSION,
        ok: true,
        result,
      };
      const checked = documentCacheLookupBridgeResponseSchema.safeParse(response);
      return checked.success ? boundedJsonResponse(checked.data) : unavailable();
    }

    const result = await runtime.commit(
      config,
      identity,
      body.execution,
      lookupMissFromBridge(body.decision),
    );
    if (deadlineExceeded(request, body.deadlineAt, clock)) return unavailable();
    const response: DocumentCacheCommitBridgeResponse = {
      version: DOCUMENT_CACHE_BRIDGE_VERSION,
      ok: true,
      result,
    };
    const checked = documentCacheCommitBridgeResponseSchema.safeParse(response);
    return checked.success ? boundedJsonResponse(checked.data) : unavailable();
  } catch {
    return invalidRequest();
  }
}

/**
 * Private ContainerProxy egress target for two-phase D1/R2 document caching.
 * It is intentionally not registered on the public Worker request router.
 */
export function handleDocumentCacheOutbound(
  request: Request,
  env: DocumentCacheOutboundEnv,
  context: OutboundHandlerContext,
): Promise<Response> {
  return executeDocumentCacheOutbound(request, env, context, {});
}

/** Deterministic dependency seam for protocol tests; production uses the handler above. */
export function createDocumentCacheOutboundHandler(
  dependencies: DocumentCacheOutboundDependencies,
): DocumentCacheOutboundHandler {
  const handler: DocumentCacheOutboundHandler = (request, env, context) =>
    executeDocumentCacheOutbound(request, env, context, dependencies);
  handler satisfies OutboundHandler<DocumentCacheOutboundEnv>;
  return handler;
}
