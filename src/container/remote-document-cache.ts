import { timingSafeEqual } from "node:crypto";

import { GroundlaneError } from "../core/errors.js";
import type {
  CacheConfig,
  DocumentCacheCommitResult,
  DocumentCacheExecution,
  DocumentCacheIdentity,
  DocumentCacheLookupMiss,
  DocumentCacheLookupResult,
  DocumentCacheOperationContext,
  DocumentCacheRuntimePort,
} from "../core/document-cache-contract.js";
import {
  buildDocumentCacheBridgeRequest,
  documentCacheCommitBridgeResponseSchema,
  DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES,
  DOCUMENT_CACHE_BRIDGE_VERSION,
  DOCUMENT_CACHE_COMMIT_PATH,
  documentCacheLookupBridgeResponseSchema,
  DOCUMENT_CACHE_LOOKUP_PATH,
  DOCUMENT_CACHE_REVOKE_PATH,
} from "../mcp/document-cache-bridge.js";
import type { AuthenticatedPrincipal, TimingSafeSubtleCrypto } from "../worker/auth.js";
import type { ManagedClock } from "../worker/managed-tokens.js";

const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;
const CACHE_UNAVAILABLE = "Document cache unavailable";

export const nodeDocumentCacheSubtle: TimingSafeSubtleCrypto = {
  digest: (algorithm, data) => crypto.subtle.digest(algorithm, data),
  timingSafeEqual: (left, right) => timingSafeEqual(
    left instanceof ArrayBuffer
      ? Buffer.from(left)
      : Buffer.from(left.buffer, left.byteOffset, left.byteLength),
    right instanceof ArrayBuffer
      ? Buffer.from(right)
      : Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  ),
};

export interface RemoteDocumentCacheOptions<T> {
  readonly signingSecret: string;
  readonly principal: AuthenticatedPrincipal;
  readonly credentialBinding: string;
  readonly subtle: TimingSafeSubtleCrypto;
  readonly clock: ManagedClock;
  readonly validateData: (value: unknown) => value is T;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly requestId?: () => string;
  readonly defaultTimeoutMs?: number;
}

function throwIfCancelledOrExpired(
  context: DocumentCacheOperationContext | undefined,
  deadlineAt: number,
  now: number,
): void {
  if (context?.signal?.aborted === true) {
    if (context.signal.reason instanceof Error) throw context.signal.reason;
    throw new GroundlaneError("CANCELLED", "document_cache", "The request was cancelled");
  }
  if (now >= deadlineAt) {
    throw new GroundlaneError(
      "DEADLINE_EXCEEDED",
      "document_cache",
      "The request deadline was exceeded",
      true,
    );
  }
}

function encodeBody(value: unknown): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength < 1 || encoded.byteLength > DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES) {
    throw new Error("document cache request exceeds the bridge byte limit");
  }
  return encoded;
}

async function decodeBody(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES)) {
    throw new Error("document cache response exceeds the bridge byte limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES) {
    throw new Error("document cache response exceeds the bridge byte limit");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function normalizeMiss(value: {
  cached: false;
  disposition: DocumentCacheLookupMiss["disposition"];
  commitFence?: { bindingRevision: number | null } | undefined;
  degraded?: boolean | undefined;
  cacheError?: string | undefined;
}): DocumentCacheLookupMiss {
  return {
    cached: false,
    disposition: value.disposition,
    ...(value.commitFence === undefined ? {} : { commitFence: value.commitFence }),
    ...(value.degraded === undefined ? {} : { degraded: value.degraded }),
    ...(value.cacheError === undefined ? {} : { cacheError: value.cacheError }),
  };
}

/** Container-side cache port. Parsing remains local; only JSON lookup/commit crosses the bridge. */
export class RemoteDocumentCacheRuntime<T> implements DocumentCacheRuntimePort<T> {
  private readonly fetchRequest: (request: Request) => Promise<Response>;
  private readonly requestId: () => string;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: RemoteDocumentCacheOptions<T>) {
    if (options.signingSecret.length < 16 || options.credentialBinding.length < 1) {
      throw new Error("remote document cache credentials are invalid");
    }
    this.fetchRequest = options.fetch ?? ((request) => fetch(request));
    this.requestId = options.requestId ?? (() => crypto.randomUUID());
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.defaultTimeoutMs) || this.defaultTimeoutMs < 1) {
      throw new Error("remote document cache timeout must be a positive integer");
    }
  }

  async lookup(
    config: CacheConfig,
    identity: DocumentCacheIdentity,
    context?: DocumentCacheOperationContext,
  ): Promise<DocumentCacheLookupResult<T>> {
    void config;
    const deadlineAt = context?.deadlineAt ?? this.options.clock.now() + this.defaultTimeoutMs;
    throwIfCancelledOrExpired(context, deadlineAt, this.options.clock.now());
    try {
      const response = await this.call(DOCUMENT_CACHE_LOOKUP_PATH, {
        version: DOCUMENT_CACHE_BRIDGE_VERSION,
        operation: "lookup",
        deadlineAt,
        identity,
      }, context);
      throwIfCancelledOrExpired(context, deadlineAt, this.options.clock.now());
      if (!response.ok) return { cached: false, disposition: "ordinary", cacheError: CACHE_UNAVAILABLE };
      const parsed = documentCacheLookupBridgeResponseSchema.safeParse(await decodeBody(response));
      if (!parsed.success || !parsed.data.ok) {
        return { cached: false, disposition: "ordinary", cacheError: CACHE_UNAVAILABLE };
      }
      const result = parsed.data.result;
      if (!result.cached) return normalizeMiss(result);
      if (!this.options.validateData(result.data)) {
        return { cached: false, disposition: "ordinary", cacheError: CACHE_UNAVAILABLE };
      }
      return { cached: true, data: result.data, hit: result.hit };
    } catch (error) {
      throwIfCancelledOrExpired(context, deadlineAt, this.options.clock.now());
      void error;
      return { cached: false, disposition: "ordinary", cacheError: CACHE_UNAVAILABLE };
    }
  }

  async revokeAllSourceBindings(params: { sourceIdentity: string; ownershipScope: string; nowMs: number }): Promise<"revoked" | "missing"> {
    if (params.ownershipScope !== this.options.principal.principalId) throw new Error(CACHE_UNAVAILABLE);
    const deadlineAt = this.options.clock.now() + this.defaultTimeoutMs;
    const response = await this.call(DOCUMENT_CACHE_REVOKE_PATH, {
      version: DOCUMENT_CACHE_BRIDGE_VERSION, operation: "revoke", sourceIdentity: params.sourceIdentity, deadlineAt,
    }, { deadlineAt, signal: AbortSignal.timeout(this.defaultTimeoutMs) });
    if (!response.ok) throw new Error(CACHE_UNAVAILABLE);
    const result: unknown = await decodeBody(response);
    if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true || !("result" in result) || (result.result !== "revoked" && result.result !== "missing")) throw new Error(CACHE_UNAVAILABLE);
    return result.result;
  }

  async commit(
    config: CacheConfig,
    identity: DocumentCacheIdentity,
    execution: DocumentCacheExecution<T>,
    decision: DocumentCacheLookupMiss,
    context?: DocumentCacheOperationContext,
  ): Promise<DocumentCacheCommitResult<T>> {
    void config;
    if (decision.cacheError !== undefined) return this.failedCommit(execution);
    const deadlineAt = context?.deadlineAt ?? this.options.clock.now() + this.defaultTimeoutMs;
    throwIfCancelledOrExpired(context, deadlineAt, this.options.clock.now());
    try {
      const response = await this.call(DOCUMENT_CACHE_COMMIT_PATH, {
        version: DOCUMENT_CACHE_BRIDGE_VERSION,
        operation: "commit",
        deadlineAt,
        identity,
        execution,
        decision,
      }, context);
      throwIfCancelledOrExpired(context, deadlineAt, this.options.clock.now());
      if (!response.ok) return this.failedCommit(execution);
      const parsed = documentCacheCommitBridgeResponseSchema.safeParse(await decodeBody(response));
      if (!parsed.success || !parsed.data.ok) {
        return this.failedCommit(execution);
      }
      const result = parsed.data.result;
      const data = result.data;
      if (!this.options.validateData(data)) return this.failedCommit(execution);
      return {
        cached: false,
        data,
        provenance: result.provenance,
        stored: result.stored,
        ...(result.createdAt === undefined ? {} : { createdAt: result.createdAt }),
        ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
        ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
        ...(result.cacheError === undefined ? {} : { cacheError: result.cacheError }),
      };
    } catch (error) {
      throwIfCancelledOrExpired(context, deadlineAt, this.options.clock.now());
      void error;
      return this.failedCommit(execution);
    }
  }

  private async call(
    path: typeof DOCUMENT_CACHE_LOOKUP_PATH | typeof DOCUMENT_CACHE_COMMIT_PATH | typeof DOCUMENT_CACHE_REVOKE_PATH,
    value: unknown,
    context: DocumentCacheOperationContext | undefined,
  ): Promise<Response> {
    const request = await buildDocumentCacheBridgeRequest({
      path,
      body: encodeBody(value),
      signingSecret: this.options.signingSecret,
      requestId: this.requestId(),
      principal: this.options.principal,
      credentialBinding: this.options.credentialBinding,
      subtle: this.options.subtle,
      clock: this.options.clock,
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    });
    return this.fetchRequest(request);
  }

  private failedCommit(execution: DocumentCacheExecution<T>): DocumentCacheCommitResult<T> {
    return {
      cached: false,
      data: execution.data,
      provenance: execution.provenance,
      stored: false,
      cacheError: CACHE_UNAVAILABLE,
    };
  }
}
