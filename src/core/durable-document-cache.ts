import { createHash } from "node:crypto";

import {
  DEFAULT_CACHE_SCOPE_POLICY,
  documentCacheKeyString,
  resolveCacheMode,
  resolveEffectiveTtl,
  validateCacheHit,
  validateCacheScope,
  validateNetworkPolicyRequired,
  validateOwnershipScope,
  type BillingProvenance,
  type CacheConfig,
  type CacheHitResult,
  type DocumentCacheExecution,
  type DocumentCacheProcessParams,
  type DocumentCacheProcessResult,
  type ParsedPayloadCacheKey,
} from "./document-cache-contract.js";
import type { DurableRecord, DurableRecordStorePort } from "./durable-store.js";
import {
  MAX_IMMUTABLE_BLOB_BYTES,
  type ImmutableBlobPort,
} from "./immutable-blob.js";

const DURABLE_CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CAS_ATTEMPTS = 8;

interface DurableCacheCore {
  readonly schemaVersion: typeof DURABLE_CACHE_SCHEMA_VERSION;
  readonly kind: "document-cache-core";
  readonly key: ParsedPayloadCacheKey;
  readonly keyString: string;
  readonly payloadId: string;
  readonly data?: unknown;
  readonly payloadBlob?: {
    readonly blobKey: string;
    readonly digest: string;
    readonly byteSize: number;
  };
  readonly provenance: BillingProvenance;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface DurableSourceBinding {
  readonly schemaVersion: typeof DURABLE_CACHE_SCHEMA_VERSION;
  readonly kind: "document-cache-source-binding";
  readonly coreRecordKey: string;
  readonly sourceIdentity: string;
  readonly sourceVersion: string;
  readonly ownershipScope: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

interface DurablePayloadCleanup {
  readonly schemaVersion: typeof DURABLE_CACHE_SCHEMA_VERSION;
  readonly kind: "document-cache-payload-cleanup";
  readonly coreRecordKey: string;
  readonly blobKey: string;
  readonly ownerId: string;
  readonly digest: string;
}

interface StoredPayload {
  readonly ref: NonNullable<DurableCacheCore["payloadBlob"]>;
  readonly cleanupKey: string;
  readonly cleanupRevision: number;
}

export type AsyncDocumentCacheProcessParams<T> = Omit<DocumentCacheProcessParams<T>, "execute"> & {
  readonly execute: () => Promise<DocumentCacheExecution<T>> | DocumentCacheExecution<T>;
};

export interface DurableDocumentCacheOptions {
  readonly maxCasAttempts?: number;
  readonly payloads?: ImmutableBlobPort;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function payloadId(keyString: string): string {
  return digest(keyString).slice(0, 32);
}

function coreRecordKey(keyString: string): string {
  return `document-cache.core.${digest(keyString)}`;
}

function bindingRecordKey(keyString: string, ownershipScope: string, sourceIdentity: string): string {
  return `document-cache.binding.${digest(`${keyString}\u0000${ownershipScope}\u0000${sourceIdentity}`)}`;
}

/** Stable opaque durable keys; exposed for adapters, cleanup, and diagnostics. */
export function durableDocumentCacheRecordKeys(
  key: ParsedPayloadCacheKey,
  ownershipScope: string,
  sourceIdentity: string,
): { readonly core: string; readonly binding: string } {
  validateOwnershipScope(ownershipScope, key.ownershipScope);
  const keyString = documentCacheKeyString(key);
  return {
    core: coreRecordKey(keyString),
    binding: bindingRecordKey(keyString, ownershipScope, sourceIdentity),
  };
}

function cacheError(error: unknown): string {
  void error;
  return "Document cache unavailable";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBillingProvenance(value: unknown): value is BillingProvenance {
  return isObject(value) &&
    typeof value.isOriginal === "boolean" &&
    typeof value.originalCost === "number" &&
    typeof value.engine === "string" &&
    typeof value.model === "string";
}

function isParsedPayloadCacheKey(value: unknown): value is ParsedPayloadCacheKey {
  if (!isObject(value)) return false;
  return [
    "ownershipScope",
    "contentHash",
    "engineId",
    "engineVersion",
    "modelId",
    "modelVersion",
    "normalizedOptions",
    "schemaVersion",
    "policyVersion",
  ].every((field) => typeof value[field] === "string");
}

function decodeCore(record: DurableRecord | null): DurableCacheCore | null {
  if (record === null) return null;
  const value: unknown = JSON.parse(record.value);
  if (
    !isObject(value) ||
    value.schemaVersion !== DURABLE_CACHE_SCHEMA_VERSION ||
    value.kind !== "document-cache-core" ||
    !isParsedPayloadCacheKey(value.key) ||
    typeof value.keyString !== "string" ||
    typeof value.payloadId !== "string" ||
    !isBillingProvenance(value.provenance) ||
    typeof value.createdAt !== "number" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new Error("durable document cache core is malformed");
  }
  const hasInlineData = Object.hasOwn(value, "data");
  const payloadBlob = value.payloadBlob;
  const hasPayloadBlob = isObject(payloadBlob) &&
    typeof payloadBlob.blobKey === "string" && typeof payloadBlob.digest === "string" &&
    typeof payloadBlob.byteSize === "number";
  if (hasInlineData === hasPayloadBlob) {
    throw new Error("durable document cache core is malformed");
  }
  return {
    schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
    kind: "document-cache-core",
    key: value.key,
    keyString: value.keyString,
    payloadId: value.payloadId,
    ...(hasInlineData ? { data: value.data } : {}),
    ...(hasPayloadBlob
      ? {
          payloadBlob: {
            blobKey: payloadBlob.blobKey as string,
            digest: payloadBlob.digest as string,
            byteSize: payloadBlob.byteSize as number,
          },
        }
      : {}),
    provenance: value.provenance,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function decodeBinding(record: DurableRecord | null): DurableSourceBinding | null {
  if (record === null) return null;
  const value: unknown = JSON.parse(record.value);
  if (
    !isObject(value) ||
    value.schemaVersion !== DURABLE_CACHE_SCHEMA_VERSION ||
    value.kind !== "document-cache-source-binding" ||
    typeof value.coreRecordKey !== "string" ||
    typeof value.sourceIdentity !== "string" ||
    typeof value.sourceVersion !== "string" ||
    typeof value.ownershipScope !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    typeof value.revoked !== "boolean"
  ) {
    throw new Error("durable document cache source binding is malformed");
  }
  return {
    schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
    kind: "document-cache-source-binding",
    coreRecordKey: value.coreRecordKey,
    sourceIdentity: value.sourceIdentity,
    sourceVersion: value.sourceVersion,
    ownershipScope: value.ownershipScope,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    revoked: value.revoked,
  };
}

function encode(value: DurableCacheCore | DurableSourceBinding | DurablePayloadCleanup): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("durable document cache value is not serializable");
  return encoded;
}

function decodeCleanup(record: DurableRecord): DurablePayloadCleanup | null {
  const value: unknown = JSON.parse(record.value);
  if (!isObject(value) || value.kind !== "document-cache-payload-cleanup") return null;
  if (
    value.schemaVersion !== DURABLE_CACHE_SCHEMA_VERSION || typeof value.coreRecordKey !== "string" ||
    typeof value.blobKey !== "string" || typeof value.ownerId !== "string" || typeof value.digest !== "string"
  ) throw new Error("durable document cache cleanup marker is malformed");
  return {
    schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
    kind: "document-cache-payload-cleanup",
    coreRecordKey: value.coreRecordKey,
    blobKey: value.blobKey,
    ownerId: value.ownerId,
    digest: value.digest,
  };
}

function sameCacheKey(left: ParsedPayloadCacheKey, right: ParsedPayloadCacheKey): boolean {
  return documentCacheKeyString(left) === documentCacheKeyString(right);
}

function makeHit(core: DurableCacheCore, nowMs: number): CacheHitResult {
  const hit: CacheHitResult = {
    cached: true,
    createdAt: core.createdAt,
    expiresAt: core.expiresAt,
    ageSeconds: Math.max(0, Math.floor((nowMs - core.createdAt) / 1000)),
    sourceHash: core.key.contentHash,
    engineVersion: core.key.engineVersion,
    modelVersion: core.key.modelVersion,
    billingProvenance: core.provenance,
  };
  validateCacheHit(hit);
  return hit;
}

function validateParams<T>(params: AsyncDocumentCacheProcessParams<T>): void {
  if (params.sourceIdentity.length === 0 || params.sourceIdentity.length > 1024) {
    throw new Error("sourceIdentity must be non-empty and bounded");
  }
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs <= 0) {
    throw new Error("nowMs must be a positive integer");
  }
  validateOwnershipScope(params.ownershipScope, params.key.ownershipScope);
  if (params.networkPolicyChecked === false) {
    validateNetworkPolicyRequired(DEFAULT_CACHE_SCOPE_POLICY, false);
  }
  documentCacheKeyString(params.key);
}

export class DurableDocumentCacheRepository {
  private readonly maxCasAttempts: number;
  private readonly payloads: ImmutableBlobPort | undefined;

  constructor(
    private readonly store: DurableRecordStorePort,
    options: DurableDocumentCacheOptions = {},
  ) {
    this.maxCasAttempts = options.maxCasAttempts ?? DEFAULT_CAS_ATTEMPTS;
    this.payloads = options.payloads;
    if (!Number.isInteger(this.maxCasAttempts) || this.maxCasAttempts < 1) {
      throw new Error("maxCasAttempts must be a positive integer");
    }
  }

  async process<T>(
    config: CacheConfig,
    params: AsyncDocumentCacheProcessParams<T>,
  ): Promise<DocumentCacheProcessResult<T>> {
    validateParams(params);
    const resolved = resolveCacheMode(params.mode, config);
    const excluded = params.toolName !== undefined &&
      !validateCacheScope(params.toolName, DEFAULT_CACHE_SCOPE_POLICY).allowed;
    const effectiveMode = excluded ? "bypass" : resolved.effectiveMode;

    if (effectiveMode === "bypass") {
      const execution = await params.execute();
      return resolved.degraded
        ? {
            cached: false,
            data: execution.data,
            provenance: execution.provenance,
            stored: false,
            degraded: true,
          }
        : {
            cached: false,
            data: execution.data,
            provenance: execution.provenance,
            stored: false,
          };
    }

    const keyString = documentCacheKeyString(params.key);
    const coreKey = coreRecordKey(keyString);
    const bindingKey = bindingRecordKey(keyString, params.ownershipScope, params.sourceIdentity);

    if (effectiveMode === "use") {
      try {
        const [coreRecord, bindingRecord] = await Promise.all([
          this.store.get(coreKey),
          this.store.get(bindingKey),
        ]);
        const core = decodeCore(coreRecord);
        const binding = decodeBinding(bindingRecord);
        if (
          core !== null &&
          binding !== null &&
          core.expiresAt > params.nowMs &&
          binding.expiresAt > params.nowMs &&
          !binding.revoked &&
          binding.coreRecordKey === coreKey &&
          binding.sourceIdentity === params.sourceIdentity &&
          binding.sourceVersion === params.sourceVersion &&
          binding.ownershipScope === params.ownershipScope &&
          core.keyString === keyString &&
          sameCacheKey(core.key, params.key)
        ) {
          return { cached: true, data: await this.loadCoreData<T>(core), hit: makeHit(core, params.nowMs) };
        }
        if (
          core !== null &&
          binding === null &&
          core.expiresAt > params.nowMs &&
          core.keyString === keyString &&
          sameCacheKey(core.key, params.key)
        ) {
          const ttlSeconds = resolveEffectiveTtl(params.requestedTtlSeconds, config);
          if (ttlSeconds > 0) {
            const expiresAt = Math.min(core.expiresAt, params.nowMs + ttlSeconds * 1000);
            const rebound: DurableSourceBinding = {
              schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
              kind: "document-cache-source-binding",
              coreRecordKey: coreKey,
              sourceIdentity: params.sourceIdentity,
              sourceVersion: params.sourceVersion,
              ownershipScope: params.ownershipScope,
              createdAt: params.nowMs,
              expiresAt,
              revoked: false,
            };
            const data = await this.loadCoreData<T>(core);
            await this.upsertRecord(bindingKey, encode(rebound), params.nowMs, expiresAt);
            return { cached: true, data, hit: makeHit(core, params.nowMs) };
          }
        }
        if (binding?.revoked === true) {
          const execution = await params.execute();
          return {
            cached: false,
            data: execution.data,
            provenance: execution.provenance,
            stored: false,
          };
        }
      } catch (error) {
        const execution = await params.execute();
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
          cacheError: cacheError(error),
        };
      }
    }

    const execution = await params.execute();
    const ttlSeconds = resolveEffectiveTtl(params.requestedTtlSeconds, config);
    if (ttlSeconds <= 0) {
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: false,
      };
    }
    const expiresAt = params.nowMs + ttlSeconds * 1000;
    try {
      const storedPayload = await this.storePayload(
        params.ownershipScope,
        keyString,
        coreKey,
        params.nowMs,
        execution.data,
      );
      const core: DurableCacheCore = {
        schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
        kind: "document-cache-core",
        key: params.key,
        keyString,
        payloadId: payloadId(keyString),
        ...(storedPayload === undefined ? { data: execution.data } : { payloadBlob: storedPayload.ref }),
        provenance: execution.provenance,
        createdAt: params.nowMs,
        expiresAt,
      };
      const binding: DurableSourceBinding = {
        schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
        kind: "document-cache-source-binding",
        coreRecordKey: coreKey,
        sourceIdentity: params.sourceIdentity,
        sourceVersion: params.sourceVersion,
        ownershipScope: params.ownershipScope,
        createdAt: params.nowMs,
        expiresAt,
        revoked: false,
      };
      const storedCore = effectiveMode === "refresh"
        ? await this.replaceRecord(coreKey, encode(core), params.nowMs, expiresAt)
        : await this.createCoreIfMissing(coreKey, core, params.nowMs, expiresAt);
      const bindingExpiry = Math.min(storedCore.expiresAt, expiresAt);
      const storedBinding: DurableSourceBinding = { ...binding, expiresAt: bindingExpiry };
      await this.upsertRecord(bindingKey, encode(storedBinding), params.nowMs, bindingExpiry);
      if (storedPayload !== undefined) {
        await this.store.deleteIfRevision(storedPayload.cleanupKey, storedPayload.cleanupRevision);
      }
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: true,
        createdAt: params.nowMs,
        expiresAt: storedBinding.expiresAt,
      };
    } catch (error) {
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: false,
        cacheError: cacheError(error),
      };
    }
  }

  async revokeSourceBinding(params: {
    readonly key: ParsedPayloadCacheKey;
    readonly sourceIdentity: string;
    readonly ownershipScope: string;
    readonly nowMs: number;
  }): Promise<"revoked" | "missing"> {
    validateOwnershipScope(params.ownershipScope, params.key.ownershipScope);
    if (params.sourceIdentity.length === 0 || params.sourceIdentity.length > 1024) {
      throw new Error("sourceIdentity must be non-empty and bounded");
    }
    if (!Number.isSafeInteger(params.nowMs) || params.nowMs <= 0) {
      throw new Error("nowMs must be a positive integer");
    }
    const keyString = documentCacheKeyString(params.key);
    const key = bindingRecordKey(keyString, params.ownershipScope, params.sourceIdentity);
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      const record = await this.store.get(key);
      const binding = decodeBinding(record);
      if (record === null || binding === null) return "missing";
      if (binding.revoked) return "revoked";
      const expiresAt = Math.max(binding.expiresAt, params.nowMs + 1);
      const result = await this.store.compareAndSwap(key, record.revision, {
        value: encode({ ...binding, revoked: true, expiresAt }),
        nowMs: params.nowMs,
        expiresAt,
      });
      if (result.status === "updated") return "revoked";
      if (result.status === "missing") return "missing";
    }
    throw new Error("durable document cache source binding CAS retry limit exceeded");
  }

  async sweepExpired(nowMs: number, limit = 100): Promise<number> {
    let removed = 0;
    let cursor: string | null = null;
    do {
      const page = await this.store.scanExpired(nowMs, cursor, limit);
      for (const record of page.records) {
        const cleanup = decodeCleanup(record);
        if (cleanup !== null) {
          const core = decodeCore(await this.store.get(cleanup.coreRecordKey));
          if (core?.payloadBlob?.blobKey !== cleanup.blobKey) {
            const deleted = await this.payloads?.deleteIfOwner(cleanup.blobKey, cleanup.ownerId);
            if (deleted === undefined) continue;
          }
          if (await this.store.deleteIfRevision(record.key, record.revision) === "deleted") removed += 1;
          continue;
        }
        let core: DurableCacheCore | null = null;
        try {
          core = decodeCore(record);
        } catch {
          // Expired malformed metadata is safe to remove, but has no trusted
          // blob coordinate that cleanup may follow.
        }
        if (await this.store.deleteIfRevision(record.key, record.revision) === "deleted") {
          removed += 1;
          if (core?.payloadBlob !== undefined) {
            await this.payloads?.deleteIfOwner(core.payloadBlob.blobKey, core.key.ownershipScope);
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return removed;
  }

  private async createCoreIfMissing(
    key: string,
    core: DurableCacheCore,
    nowMs: number,
    expiresAt: number,
  ): Promise<DurableCacheCore> {
    const result = await this.store.createIfAbsent({ key, value: encode(core), nowMs, expiresAt });
    if (result.status === "created") return core;
    const existing = decodeCore(result.record);
    if (existing === null) throw new Error("durable document cache core disappeared");
    if (existing.expiresAt > nowMs && existing.keyString === core.keyString) {
      await this.deleteUnusedPayload(core, existing);
      return existing;
    }
    await this.replaceRecord(key, encode(core), nowMs, expiresAt);
    return core;
  }

  private async replaceRecord(key: string, value: string, nowMs: number, expiresAt: number): Promise<DurableCacheCore> {
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      const current = await this.store.get(key);
      if (current === null) {
        const created = await this.store.createIfAbsent({ key, value, nowMs, expiresAt });
        if (created.status === "created") {
          const decoded = decodeCore(created.record);
          if (decoded === null) throw new Error("durable document cache core disappeared");
          return decoded;
        }
        continue;
      }
      const updated = await this.store.compareAndSwap(key, current.revision, { value, nowMs, expiresAt });
      if (updated.status === "updated") {
        const decoded = decodeCore(updated.record);
        if (decoded === null) throw new Error("durable document cache core disappeared");
        await this.deleteUnusedPayload(decodeCore(current), decoded);
        return decoded;
      }
    }
    throw new Error("durable document cache core CAS retry limit exceeded");
  }

  private async storePayload<T>(
    ownerId: string,
    keyString: string,
    coreKey: string,
    nowMs: number,
    data: T,
  ): Promise<StoredPayload | undefined> {
    if (this.payloads === undefined) return undefined;
    const encoded = JSON.stringify(data);
    if (encoded === undefined) throw new Error("document cache payload is not serializable");
    const bytes = new TextEncoder().encode(encoded);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMMUTABLE_BLOB_BYTES) {
      throw new Error("document cache payload exceeds the immutable blob limit");
    }
    const payloadDigest = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    const blobKey = `blobs/${digest(`${ownerId}\u0000${keyString}\u0000${payloadDigest}`)}`;
    const cleanupKey = `document-cache.cleanup.${digest(blobKey)}`;
    const cleanup = await this.store.createIfAbsent({
      key: cleanupKey,
      value: encode({
        schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
        kind: "document-cache-payload-cleanup",
        coreRecordKey: coreKey,
        blobKey,
        ownerId,
        digest: payloadDigest,
      }),
      nowMs,
      expiresAt: nowMs + 3_600_000,
    });
    const result = await this.payloads.putIfAbsent({
      blobKey,
      ownerId,
      digest: payloadDigest,
      bytes,
    });
    if (result.status === "conflict") throw new Error("document cache payload blob conflict");
    return {
      ref: { blobKey, digest: payloadDigest, byteSize: bytes.byteLength },
      cleanupKey,
      cleanupRevision: cleanup.record.revision,
    };
  }

  private async loadCoreData<T>(core: DurableCacheCore): Promise<T> {
    if (core.payloadBlob === undefined) return core.data as T;
    if (this.payloads === undefined) throw new Error("document cache payload storage is unavailable");
    const bytes = await this.payloads.get({
      blobKey: core.payloadBlob.blobKey,
      ownerId: core.key.ownershipScope,
      digest: core.payloadBlob.digest,
      maxBytes: MAX_IMMUTABLE_BLOB_BYTES,
    });
    if (bytes === null || bytes.byteLength !== core.payloadBlob.byteSize) {
      throw new Error("document cache payload blob is missing");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  }

  private async deleteUnusedPayload(
    candidate: DurableCacheCore | null,
    winner: DurableCacheCore,
  ): Promise<void> {
    if (
      candidate?.payloadBlob !== undefined &&
      candidate.payloadBlob.blobKey !== winner.payloadBlob?.blobKey
    ) {
      await this.payloads?.deleteIfOwner(
        candidate.payloadBlob.blobKey,
        candidate.key.ownershipScope,
      );
    }
  }

  private async upsertRecord(key: string, value: string, nowMs: number, expiresAt: number): Promise<void> {
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      const current = await this.store.get(key);
      if (current === null) {
        const created = await this.store.createIfAbsent({ key, value, nowMs, expiresAt });
        if (created.status === "created") return;
        continue;
      }
      const updated = await this.store.compareAndSwap(key, current.revision, { value, nowMs, expiresAt });
      if (updated.status === "updated") return;
    }
    throw new Error("durable document cache binding CAS retry limit exceeded");
  }
}

export function processDurableDocumentCache<T>(
  repository: DurableDocumentCacheRepository,
  config: CacheConfig,
  params: AsyncDocumentCacheProcessParams<T>,
): Promise<DocumentCacheProcessResult<T>> {
  return repository.process(config, params);
}
