import { createHash } from "node:crypto";

import {
  DEFAULT_CACHE_SCOPE_POLICY,
  cacheConfigForIdentity,
  documentCacheKeyString,
  resolveCacheMode,
  resolveEffectiveTtl,
  validateCacheHit,
  validateCacheScope,
  validateNetworkPolicyRequired,
  validateOwnershipScope,
  type BillingProvenance,
  type CacheConfig,
  type DocumentCacheCommitResult,
  type CacheHitResult,
  type DocumentCacheExecution,
  type DocumentCacheIdentity,
  type DocumentCacheLookupMiss,
  type DocumentCacheLookupResult,
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
const MAX_SOURCE_BINDINGS = 128;

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

interface DurableSourceBindingIndex {
  readonly schemaVersion: typeof DURABLE_CACHE_SCHEMA_VERSION;
  readonly kind: "document-cache-source-index";
  readonly ownershipScope: string;
  readonly sourceIdentity: string;
  readonly bindingKeys: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
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

export interface DurableDocumentCacheSweepPage {
  readonly scanned: number;
  readonly removed: number;
  readonly nextCursor: string | null;
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

function sourceIndexRecordKey(ownershipScope: string, sourceIdentity: string): string {
  return `document-cache.source.${digest(`${ownershipScope}\u0000${sourceIdentity}`)}`;
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

function encode(
  value: DurableCacheCore | DurableSourceBinding | DurableSourceBindingIndex | DurablePayloadCleanup,
): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("durable document cache value is not serializable");
  return encoded;
}

function decodeSourceIndex(record: DurableRecord | null): DurableSourceBindingIndex | null {
  if (record === null) return null;
  const value: unknown = JSON.parse(record.value);
  if (
    !isObject(value) || value.schemaVersion !== DURABLE_CACHE_SCHEMA_VERSION ||
    value.kind !== "document-cache-source-index" || typeof value.ownershipScope !== "string" ||
    typeof value.sourceIdentity !== "string" || !Array.isArray(value.bindingKeys) ||
    value.bindingKeys.length > MAX_SOURCE_BINDINGS ||
    !value.bindingKeys.every((item) => typeof item === "string" && item.startsWith("document-cache.binding.")) ||
    typeof value.createdAt !== "number" || typeof value.updatedAt !== "number" ||
    typeof value.expiresAt !== "number" || typeof value.revoked !== "boolean"
  ) {
    throw new Error("durable document cache source index is malformed");
  }
  return {
    schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
    kind: "document-cache-source-index",
    ownershipScope: value.ownershipScope,
    sourceIdentity: value.sourceIdentity,
    bindingKeys: value.bindingKeys as string[],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    revoked: value.revoked,
  };
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

function validateIdentity(params: DocumentCacheIdentity): void {
  if (params.sourceIdentity.length === 0 || params.sourceIdentity.length > 1024) {
    throw new Error("sourceIdentity must be non-empty and bounded");
  }
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs <= 0) {
    throw new Error("nowMs must be a positive integer");
  }
  if (params.sourceExpiresAt !== undefined &&
      (!Number.isSafeInteger(params.sourceExpiresAt) || params.sourceExpiresAt <= 0)) {
    throw new Error("sourceExpiresAt must be a positive integer");
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
    const { execute, ...identity } = params;
    const lookup = await this.lookup<T>(config, identity);
    if (lookup.cached) return lookup;
    const execution = await execute();
    return this.commit(config, identity, execution, lookup);
  }

  async lookup<T>(
    config: CacheConfig,
    identity: DocumentCacheIdentity,
  ): Promise<DocumentCacheLookupResult<T>> {
    validateIdentity(identity);
    const effectiveConfig = cacheConfigForIdentity(config, identity);
    const resolved = resolveCacheMode(identity.mode, effectiveConfig);
    const excluded = identity.toolName !== undefined &&
      !validateCacheScope(identity.toolName, DEFAULT_CACHE_SCOPE_POLICY).allowed;
    const effectiveMode = excluded ? "bypass" : resolved.effectiveMode;

    if (effectiveMode === "bypass") {
      return resolved.degraded
        ? { cached: false, disposition: "disabled", degraded: true }
        : { cached: false, disposition: "bypass" };
    }
    if (effectiveMode === "refresh") {
      return { cached: false, disposition: "refresh" };
    }

    const keyString = documentCacheKeyString(identity.key);
    const coreKey = coreRecordKey(keyString);
    const bindingKey = bindingRecordKey(keyString, identity.ownershipScope, identity.sourceIdentity);
    const sourceIndexKey = sourceIndexRecordKey(identity.ownershipScope, identity.sourceIdentity);
    try {
      const [coreRecord, bindingRecord, sourceIndexRecord] = await Promise.all([
        this.store.get(coreKey),
        this.store.get(bindingKey),
        this.store.get(sourceIndexKey),
      ]);
      const core = decodeCore(coreRecord);
      const binding = decodeBinding(bindingRecord);
      const sourceIndex = decodeSourceIndex(sourceIndexRecord);
      if (
        core !== null &&
        binding !== null &&
        sourceIndex !== null &&
        !sourceIndex.revoked &&
        sourceIndex.expiresAt > identity.nowMs &&
        sourceIndex.ownershipScope === identity.ownershipScope &&
        sourceIndex.sourceIdentity === identity.sourceIdentity &&
        sourceIndex.bindingKeys.includes(bindingKey) &&
        core.expiresAt > identity.nowMs &&
        binding.expiresAt > identity.nowMs &&
        !binding.revoked &&
        binding.coreRecordKey === coreKey &&
        binding.sourceIdentity === identity.sourceIdentity &&
        binding.sourceVersion === identity.sourceVersion &&
        binding.ownershipScope === identity.ownershipScope &&
        core.keyString === keyString &&
        sameCacheKey(core.key, identity.key)
      ) {
        return { cached: true, data: await this.loadCoreData<T>(core), hit: makeHit(core, identity.nowMs) };
      }
      if (
        core !== null &&
        binding === null &&
        sourceIndex?.revoked !== true &&
        core.expiresAt > identity.nowMs &&
        core.keyString === keyString &&
        sameCacheKey(core.key, identity.key)
      ) {
        const ttlSeconds = resolveEffectiveTtl(identity.requestedTtlSeconds, effectiveConfig);
        if (ttlSeconds > 0) {
          const expiresAt = Math.min(core.expiresAt, identity.nowMs + ttlSeconds * 1000);
          const rebound: DurableSourceBinding = {
            schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
            kind: "document-cache-source-binding",
            coreRecordKey: coreKey,
            sourceIdentity: identity.sourceIdentity,
            sourceVersion: identity.sourceVersion,
            ownershipScope: identity.ownershipScope,
            createdAt: identity.nowMs,
            expiresAt,
            revoked: false,
          };
          const data = await this.loadCoreData<T>(core);
          if (!await this.ensureSourceIndex(
            sourceIndexKey,
            bindingKey,
            identity,
            expiresAt,
          )) return { cached: false, disposition: "revoked" };
          await this.upsertRecord(bindingKey, encode(rebound), identity.nowMs, expiresAt);
          return { cached: true, data, hit: makeHit(core, identity.nowMs) };
        }
      }
      if (binding?.revoked === true || sourceIndex?.revoked === true) {
        return { cached: false, disposition: "revoked" };
      }
      return {
        cached: false,
        disposition: "ordinary",
        commitFence: { bindingRevision: bindingRecord?.revision ?? null },
      };
    } catch (error) {
      return {
        cached: false,
        disposition: "ordinary",
        cacheError: cacheError(error),
      };
    }
  }

  async commit<T>(
    config: CacheConfig,
    identity: DocumentCacheIdentity,
    execution: DocumentCacheExecution<T>,
    decision: DocumentCacheLookupMiss,
  ): Promise<DocumentCacheCommitResult<T>> {
    validateIdentity(identity);
    this.validateCommitDisposition(config, identity, decision);
    if (
      decision.disposition === "bypass" ||
      decision.disposition === "disabled" ||
      decision.disposition === "revoked" ||
      decision.cacheError !== undefined
    ) {
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: false,
        ...(decision.disposition === "disabled" ? { degraded: true } : {}),
        ...(decision.cacheError === undefined ? {} : { cacheError: cacheError(decision.cacheError) }),
      };
    }

    const ttlSeconds = resolveEffectiveTtl(
      identity.requestedTtlSeconds,
      cacheConfigForIdentity(config, identity),
    );
    if (ttlSeconds <= 0) {
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: false,
      };
    }
    const keyString = documentCacheKeyString(identity.key);
    const coreKey = coreRecordKey(keyString);
    const bindingKey = bindingRecordKey(keyString, identity.ownershipScope, identity.sourceIdentity);
    const sourceIndexKey = sourceIndexRecordKey(identity.ownershipScope, identity.sourceIdentity);
    const expiresAt = identity.nowMs + ttlSeconds * 1000;
    try {
      const storedPayload = await this.storePayload(
        identity.ownershipScope,
        keyString,
        coreKey,
        identity.nowMs,
        execution.data,
      );
      const core: DurableCacheCore = {
        schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
        kind: "document-cache-core",
        key: identity.key,
        keyString,
        payloadId: payloadId(keyString),
        ...(storedPayload === undefined ? { data: execution.data } : { payloadBlob: storedPayload.ref }),
        provenance: execution.provenance,
        createdAt: identity.nowMs,
        expiresAt,
      };
      const binding: DurableSourceBinding = {
        schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
        kind: "document-cache-source-binding",
        coreRecordKey: coreKey,
        sourceIdentity: identity.sourceIdentity,
        sourceVersion: identity.sourceVersion,
        ownershipScope: identity.ownershipScope,
        createdAt: identity.nowMs,
        expiresAt,
        revoked: false,
      };
      const storedCore = decision.disposition === "refresh"
        ? await this.replaceRecord(coreKey, encode(core), identity.nowMs, expiresAt)
        : await this.createCoreIfMissing(coreKey, core, identity.nowMs, expiresAt);
      const bindingExpiry = Math.min(storedCore.expiresAt, expiresAt);
      if (!await this.ensureSourceIndex(
        sourceIndexKey,
        bindingKey,
        identity,
        bindingExpiry,
      )) {
        await this.deleteUnusedPayload(core, storedCore);
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
        };
      }
      const storedBinding: DurableSourceBinding = { ...binding, expiresAt: bindingExpiry };
      const bindingStored = decision.disposition === "refresh"
        ? await this.upsertRecord(bindingKey, encode(storedBinding), identity.nowMs, bindingExpiry).then(() => true)
        : await this.upsertRecordFenced(
            bindingKey,
            storedBinding,
            identity.nowMs,
            decision.commitFence?.bindingRevision ?? null,
          );
      if (!bindingStored) {
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
        };
      }
      const sourceIndex = decodeSourceIndex(await this.store.get(sourceIndexKey));
      if (sourceIndex?.revoked === true) {
        await this.revokeBindingRecord(bindingKey, identity.nowMs);
        return {
          cached: false,
          data: execution.data,
          provenance: execution.provenance,
          stored: false,
        };
      }
      if (storedPayload !== undefined) {
        await this.store.deleteIfRevision(storedPayload.cleanupKey, storedPayload.cleanupRevision);
      }
      return {
        cached: false,
        data: execution.data,
        provenance: execution.provenance,
        stored: true,
        createdAt: identity.nowMs,
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

  private validateCommitDisposition(
    config: CacheConfig,
    identity: DocumentCacheIdentity,
    decision: DocumentCacheLookupMiss,
  ): void {
    const resolved = resolveCacheMode(identity.mode, config);
    const excluded = identity.toolName !== undefined &&
      !validateCacheScope(identity.toolName, DEFAULT_CACHE_SCOPE_POLICY).allowed;
    const expected = resolved.degraded
      ? "disabled"
      : excluded || resolved.effectiveMode === "bypass"
        ? "bypass"
        : resolved.effectiveMode;
    const compatible = expected === "use"
      ? decision.disposition === "ordinary" || decision.disposition === "revoked"
      : decision.disposition === expected;
    if (!compatible) throw new Error("document cache disposition does not match the request");
    if (decision.cacheError !== undefined && decision.disposition !== "ordinary") {
      throw new Error("document cache fault is only valid for an ordinary lookup");
    }
    if (
      decision.disposition === "ordinary" &&
      decision.cacheError === undefined &&
      decision.commitFence === undefined
    ) {
      throw new Error("ordinary document cache commit is missing its lookup fence");
    }
  }

  private async ensureSourceIndex(
    key: string,
    bindingKey: string,
    identity: DocumentCacheIdentity,
    expiresAt: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      const current = await this.store.get(key);
      const index = decodeSourceIndex(current);
      if (current === null || index === null) {
        const created = await this.store.createIfAbsent({
          key,
          value: encode({
            schemaVersion: DURABLE_CACHE_SCHEMA_VERSION,
            kind: "document-cache-source-index",
            ownershipScope: identity.ownershipScope,
            sourceIdentity: identity.sourceIdentity,
            bindingKeys: [bindingKey],
            createdAt: identity.nowMs,
            updatedAt: identity.nowMs,
            expiresAt,
            revoked: false,
          }),
          nowMs: identity.nowMs,
          expiresAt,
        });
        if (created.status === "created") return true;
        continue;
      }
      if (index.ownershipScope !== identity.ownershipScope ||
          index.sourceIdentity !== identity.sourceIdentity) {
        throw new Error("durable document cache source index binding mismatch");
      }
      if (index.revoked) return false;
      const bindingKeys = index.bindingKeys.includes(bindingKey)
        ? index.bindingKeys
        : [...index.bindingKeys, bindingKey];
      if (bindingKeys.length > MAX_SOURCE_BINDINGS) {
        throw new Error("durable document cache source binding limit exceeded");
      }
      const nextExpiry = Math.max(index.expiresAt, expiresAt);
      if (bindingKeys === index.bindingKeys && nextExpiry === index.expiresAt) return true;
      const updated = await this.store.compareAndSwap(key, current.revision, {
        value: encode({
          ...index,
          bindingKeys,
          updatedAt: identity.nowMs,
          expiresAt: nextExpiry,
        }),
        nowMs: identity.nowMs,
        expiresAt: nextExpiry,
      });
      if (updated.status === "updated") return true;
      if (updated.status === "missing") continue;
    }
    throw new Error("durable document cache source index CAS retry limit exceeded");
  }

  private async revokeBindingRecord(
    key: string,
    nowMs: number,
  ): Promise<"revoked" | "missing"> {
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      const record = await this.store.get(key);
      const binding = decodeBinding(record);
      if (record === null || binding === null) return "missing";
      if (binding.revoked) return "revoked";
      const expiresAt = Math.max(binding.expiresAt, nowMs + 1);
      const result = await this.store.compareAndSwap(key, record.revision, {
        value: encode({ ...binding, revoked: true, expiresAt }),
        nowMs,
        expiresAt,
      });
      if (result.status === "updated") return "revoked";
      if (result.status === "missing") return "missing";
    }
    throw new Error("durable document cache source binding CAS retry limit exceeded");
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
    const all = await this.revokeAllSourceBindings({
      sourceIdentity: params.sourceIdentity,
      ownershipScope: params.ownershipScope,
      nowMs: params.nowMs,
    });
    if (all !== "missing") return "revoked";
    const keyString = documentCacheKeyString(params.key);
    const key = bindingRecordKey(keyString, params.ownershipScope, params.sourceIdentity);
    return this.revokeBindingRecord(key, params.nowMs);
  }

  /** Immediately revokes every parser-option binding registered for one source. */
  async revokeAllSourceBindings(params: {
    readonly sourceIdentity: string;
    readonly ownershipScope: string;
    readonly nowMs: number;
  }): Promise<"revoked" | "missing"> {
    if (params.sourceIdentity.length === 0 || params.sourceIdentity.length > 1024 ||
        params.ownershipScope.length === 0 || params.ownershipScope.length > 2048) {
      throw new Error("source cache binding identity is invalid");
    }
    if (!Number.isSafeInteger(params.nowMs) || params.nowMs <= 0) {
      throw new Error("nowMs must be a positive integer");
    }
    const key = sourceIndexRecordKey(params.ownershipScope, params.sourceIdentity);
    let revokedIndex: DurableSourceBindingIndex | null = null;
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      const record = await this.store.get(key);
      const index = decodeSourceIndex(record);
      if (record === null || index === null) return "missing";
      if (index.ownershipScope !== params.ownershipScope || index.sourceIdentity !== params.sourceIdentity) {
        throw new Error("durable document cache source index binding mismatch");
      }
      if (index.revoked) {
        revokedIndex = index;
        break;
      }
      const expiresAt = Math.max(index.expiresAt, params.nowMs + 1);
      const result = await this.store.compareAndSwap(key, record.revision, {
        value: encode({ ...index, revoked: true, updatedAt: params.nowMs, expiresAt }),
        nowMs: params.nowMs,
        expiresAt,
      });
      if (result.status === "updated") {
        revokedIndex = decodeSourceIndex(result.record);
        break;
      }
      if (result.status === "missing") return "missing";
    }
    if (revokedIndex === null) {
      throw new Error("durable document cache source index CAS retry limit exceeded");
    }
    await Promise.all(revokedIndex.bindingKeys.map((bindingKey) =>
      this.revokeBindingRecord(bindingKey, params.nowMs)));
    return "revoked";
  }

  async sweepExpired(nowMs: number, limit = 100): Promise<number> {
    let removed = 0;
    let cursor: string | null = null;
    do {
      const page = await this.sweepExpiredPage(nowMs, cursor, limit);
      removed += page.removed;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return removed;
  }

  /** One bounded cleanup page for scheduled runtimes. Blob deletion precedes metadata CAS. */
  async sweepExpiredPage(
    nowMs: number,
    cursor: string | null,
    limit = 100,
  ): Promise<DurableDocumentCacheSweepPage> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("durable document cache sweep bounds are invalid");
    }
    const page = await this.store.scanExpired(nowMs, cursor, limit);
    let removed = 0;
    for (const record of page.records) {
      const cleanup = decodeCleanup(record);
      if (cleanup !== null) {
        const core = decodeCore(await this.store.get(cleanup.coreRecordKey));
        if (core?.payloadBlob?.blobKey !== cleanup.blobKey) {
          const deleted = await this.payloads?.deleteIfOwner(cleanup.blobKey, cleanup.ownerId);
          if (deleted === undefined || deleted === "owner_mismatch") continue;
        }
        if (await this.store.deleteIfRevision(record.key, record.revision) === "deleted") removed += 1;
        continue;
      }
      let core: DurableCacheCore | null = null;
      try {
        core = decodeCore(record);
      } catch {
        // Expired malformed metadata has no trusted blob coordinate.
      }
      if (core?.payloadBlob !== undefined) {
        const deleted = await this.payloads?.deleteIfOwner(
          core.payloadBlob.blobKey,
          core.key.ownershipScope,
        );
        if (deleted === undefined || deleted === "owner_mismatch") continue;
      }
      if (await this.store.deleteIfRevision(record.key, record.revision) === "deleted") removed += 1;
    }
    return { scanned: page.records.length, removed, nextCursor: page.nextCursor };
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

  private async upsertRecordFenced(
    key: string,
    binding: DurableSourceBinding,
    nowMs: number,
    expectedRevision: number | null,
  ): Promise<boolean> {
    if (expectedRevision === null) {
      const created = await this.store.createIfAbsent({
        key,
        value: encode(binding),
        nowMs,
        expiresAt: binding.expiresAt,
      });
      if (created.status === "created") return true;
      return this.isEquivalentLiveBinding(created.record, binding, nowMs);
    }
    const updated = await this.store.compareAndSwap(key, expectedRevision, {
      value: encode(binding),
      nowMs,
      expiresAt: binding.expiresAt,
    });
    if (updated.status === "updated") return true;
    if (updated.status === "missing") return false;
    return this.isEquivalentLiveBinding(updated.record, binding, nowMs);
  }

  private isEquivalentLiveBinding(
    record: DurableRecord,
    expected: DurableSourceBinding,
    nowMs: number,
  ): boolean {
    const current = decodeBinding(record);
    return current !== null &&
      !current.revoked &&
      current.expiresAt > nowMs &&
      current.coreRecordKey === expected.coreRecordKey &&
      current.sourceIdentity === expected.sourceIdentity &&
      current.sourceVersion === expected.sourceVersion &&
      current.ownershipScope === expected.ownershipScope;
  }
}

export function processDurableDocumentCache<T>(
  repository: DurableDocumentCacheRepository,
  config: CacheConfig,
  params: AsyncDocumentCacheProcessParams<T>,
): Promise<DocumentCacheProcessResult<T>> {
  return repository.process(config, params);
}
