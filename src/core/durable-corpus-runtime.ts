import { createHash, randomUUID } from "node:crypto";

import type {
  CorpusManifest,
  CorpusSourceManifestEntry,
  DeletionStatus,
  SearchResultProvenance,
} from "./corpus-contract.js";
import type {
  CorpusDerivedIndexPort,
  CorpusIndexDocument,
  CorpusIndexHit,
} from "../adapters/state/sqlite-corpus-index.js";
import type { ImmutableBlobPort } from "./immutable-blob.js";
import {
  DurableCorpusRepository,
  type DurableCorpusBinding,
  type DurableCorpusView,
} from "./durable-corpora.js";
import type {
  CorpusStatusView,
  CorpusView,
  ScopedCorpusSearchResponse,
} from "./corpus-runtime.js";

const MAX_SOURCE_BYTES_DEFAULT = 1_000_000;
const MAX_MANIFEST_SOURCES = 500;

export function corpusDocumentCacheSource(corpusId: string, sourceId: string, contentHash: string, tenantId: string) {
  return { kind: "corpus" as const, tenantId, corpusId, sourceId, contentHash };
}

export interface DurableCorpusCaller extends DurableCorpusBinding {
  readonly roles: readonly string[];
}

export interface CorpusSourceArtifactPort {
  put(input: {
    readonly corpusId: string;
    readonly sourceId: string;
    readonly contentHash: string;
    readonly bytes: Uint8Array;
    readonly binding: DurableCorpusBinding;
  }): Promise<"created" | "exists">;
  read(input: {
    readonly corpusId: string;
    readonly sourceId: string;
    readonly contentHash: string;
    readonly binding: DurableCorpusBinding;
    readonly maxBytes: number;
  }): Promise<Uint8Array>;
  delete(input: {
    readonly corpusId: string;
    readonly sourceId: string;
    readonly contentHash: string;
    readonly binding: DurableCorpusBinding;
  }): Promise<boolean>;
}

export interface CorpusCacheInvalidationPort {
  revoke(input: {
    readonly corpusId: string;
    readonly sourceId: string;
    readonly contentHash: string;
    readonly binding: DurableCorpusBinding;
  }): Promise<void>;
}

export class ImmutableBlobCorpusSourceArtifacts implements CorpusSourceArtifactPort {
  constructor(private readonly blobs: ImmutableBlobPort) {}

  async put(input: {
    readonly corpusId: string;
    readonly sourceId: string;
    readonly contentHash: string;
    readonly bytes: Uint8Array;
    readonly binding: DurableCorpusBinding;
  }): Promise<"created" | "exists"> {
    const result = await this.blobs.putIfAbsent({
      blobKey: artifactBlobKey(input),
      ownerId: artifactOwner(input.binding),
      digest: input.contentHash,
      bytes: input.bytes,
    });
    if (result.status === "conflict") throw new Error("corpus source artifact conflicts with durable storage");
    return result.status;
  }

  async read(input: {
    readonly corpusId: string;
    readonly sourceId: string;
    readonly contentHash: string;
    readonly binding: DurableCorpusBinding;
    readonly maxBytes: number;
  }): Promise<Uint8Array> {
    let bytes = await this.blobs.get({
      blobKey: artifactBlobKey(input),
      ownerId: artifactOwner(input.binding),
      digest: input.contentHash,
      maxBytes: input.maxBytes,
    });
    // Compatibility with pre-canonical local records that serialized the caller's roles.
    if (bytes === null) {
      bytes = await this.blobs.get({
        blobKey: artifactBlobKey(input, true), ownerId: artifactOwner(input.binding, true),
        digest: input.contentHash, maxBytes: input.maxBytes,
      });
      if (bytes !== null) {
        await this.put({ ...input, bytes });
        await this.blobs.deleteIfOwner(artifactBlobKey(input, true), artifactOwner(input.binding, true));
      }
    }
    if (bytes === null) throw new Error("corpus source artifact is unavailable");
    return bytes;
  }

  async delete(input: {
    readonly corpusId: string;
    readonly sourceId: string;
    readonly contentHash: string;
    readonly binding: DurableCorpusBinding;
  }): Promise<boolean> {
    const result = await this.blobs.deleteIfOwner(artifactBlobKey(input), artifactOwner(input.binding));
    if (result === "owner_mismatch") throw new Error("corpus source artifact binding mismatch");
    const legacy = await this.blobs.deleteIfOwner(artifactBlobKey(input, true), artifactOwner(input.binding, true));
    if (legacy === "owner_mismatch") throw new Error("corpus source artifact binding mismatch");
    return result === "deleted" || result === "missing";
  }
}

function artifactOwner(binding: DurableCorpusBinding, legacy = false): string {
  return `corpus-${createHash("sha256").update(JSON.stringify(legacy ? binding : { tenantId: binding.tenantId, ownerId: binding.ownerId, credentialBinding: binding.credentialBinding })).digest("hex")}`;
}

function artifactBlobKey(input: {
  readonly corpusId: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly binding: DurableCorpusBinding;
}, legacy = false): string {
  const digest = createHash("sha256").update(JSON.stringify({
    corpusId: input.corpusId,
    sourceId: input.sourceId,
    contentHash: input.contentHash,
    binding: legacy ? input.binding : { tenantId: input.binding.tenantId, ownerId: input.binding.ownerId, credentialBinding: input.binding.credentialBinding },
  })).digest("hex");
  return `blobs/${digest}`;
}

export interface DurableCorpusRuntimeOptions {
  readonly repository: DurableCorpusRepository;
  readonly index: CorpusDerivedIndexPort;
  readonly artifacts: CorpusSourceArtifactPort;
  readonly cache?: CorpusCacheInvalidationPort;
  readonly maxSourceBytes?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface DurableCorpusEnrollInput {
  readonly content: string;
  readonly sourceId?: string;
  readonly contentHash?: string;
  readonly acl: readonly string[];
  readonly retentionPolicy: string;
  readonly deletionPolicy: string;
  readonly citationProvenance: string;
  readonly callerExpiresAt: string | null;
}

export interface DurableCorpusUpdateInput {
  readonly content?: string;
  readonly contentHash?: string;
  readonly acl?: readonly string[];
  readonly deletionPolicy?: string;
  readonly citationProvenance?: string;
}

export interface DurableCorpusEnrollmentView {
  readonly corpusId: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly enrolledAt: string;
  readonly expiresAt: string | null;
  readonly lifecycle: "enrolled";
  readonly state: "active" | "degraded";
}

export interface DurableCorpusRemovalView {
  readonly sourceId: string;
  readonly lifecycle: "removed";
  readonly cleanupComplete: boolean;
}

function normalizeContent(content: string, maxBytes: number): { text: string; bytes: Uint8Array; hash: string } {
  const text = content.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (!text) throw new Error("corpus source content is empty");
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) throw new Error("corpus source content exceeds the configured byte limit");
  return {
    text,
    bytes,
    hash: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function viewFromDurable(view: DurableCorpusView): CorpusView {
  return {
    corpusId: view.record.corpusId,
    displayName: view.record.displayName,
    state: view.record.state,
    sourceCount: view.record.manifest.sources.length,
    updatedAt: new Date(view.record.updatedAt).toISOString(),
    expiresAt: view.record.expiresAt === null ? null : new Date(view.record.expiresAt).toISOString(),
  };
}

function sourceExpiry(entry: CorpusSourceManifestEntry): number | null {
  if (entry.retentionPolicy === "persistent") return null;
  const timestamp = Date.parse(entry.retentionPolicy);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function canRead(entry: CorpusSourceManifestEntry, caller: DurableCorpusCaller): boolean {
  return caller.roles.some((role) => entry.acl.includes(role));
}

function activeSources(manifest: CorpusManifest, nowMs: number): readonly CorpusSourceManifestEntry[] {
  return manifest.sources.filter((source) => {
    if (source.lifecycleProvenance.startsWith("revoked:")) return false;
    const expiry = sourceExpiry(source);
    return expiry === null || expiry > nowMs;
  });
}

export class DurableCorpusRuntime {
  private readonly maxSourceBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(private readonly options: DurableCorpusRuntimeOptions) {
    this.maxSourceBytes = options.maxSourceBytes ?? MAX_SOURCE_BYTES_DEFAULT;
    if (!Number.isInteger(this.maxSourceBytes) || this.maxSourceBytes < 1 || this.maxSourceBytes > 32 * 1024 * 1024) {
      throw new Error("corpus source byte limit is invalid");
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async readSource(corpusId: string, sourceId: string, caller: DurableCorpusCaller) {
    const nowMs = this.now().getTime();
    const current = await this.require(corpusId, caller, nowMs);
    const source = activeSources(current.record.manifest, nowMs).find((entry) => entry.sourceId === sourceId);
    if (source === undefined || !canRead(source, caller)) throw new Error("corpus source is unavailable");
    const bytes = await this.options.artifacts.read({ corpusId, sourceId, contentHash: source.contentHash, binding: caller, maxBytes: this.maxSourceBytes });
    if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== source.contentHash) throw new Error("corpus source integrity check failed");
    const latest = await this.require(corpusId, caller, this.now().getTime());
    if (latest.revision !== current.revision || !activeSources(latest.record.manifest, this.now().getTime()).some((entry) => entry.sourceId === sourceId)) throw new Error("corpus source changed or expired during read");
    const expiries = [sourceExpiry(source), current.record.expiresAt].filter((value): value is number => value !== null);
    return { bytes, contentHash: source.contentHash, mimeType: "text/plain", filename: "corpus-source.txt",
      cacheBindingIdentity: corpusDocumentCacheSource(corpusId, sourceId, source.contentHash, caller.tenantId),
      ...(expiries.length === 0 ? {} : { expiresAt: Math.min(...expiries) }) };
  }

  async createCorpus(input: {
    readonly displayName: string;
    readonly callerExpiresAt: string | null;
  }, caller: DurableCorpusCaller): Promise<CorpusView> {
    const nowMs = this.now().getTime();
    const corpusId = `gl-corpus-${this.idFactory().replace(/[^A-Za-z0-9]/gu, "").slice(0, 32)}`;
    const manifest: CorpusManifest = { corpusId, sources: [], updatedAt: new Date(nowMs).toISOString() };
    const expiresAt = input.callerExpiresAt === null ? null : Date.parse(input.callerExpiresAt);
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs)) {
      throw new Error("corpus expiry is invalid");
    }
    const created = await this.options.repository.create({
      corpusId,
      displayName: input.displayName,
      tenantId: caller.tenantId,
      ownerId: caller.ownerId,
      credentialBinding: caller.credentialBinding,
      manifest,
      nowMs,
      expiresAt,
    });
    if (created.status === "exists") {
      throw new Error("generated corpus identity collision");
    }
    try {
      await this.options.index.replaceFromManifest(corpusId, []);
      return viewFromDurable(created.view);
    } catch {
      const degraded = await this.options.repository.update(corpusId, caller, created.view.revision, {
        manifest,
        state: "degraded",
        deletion: created.view.record.deletion,
        nowMs,
      });
      return viewFromDurable(degraded);
    }
  }

  async enrollSource(
    corpusId: string,
    input: DurableCorpusEnrollInput,
    caller: DurableCorpusCaller,
  ): Promise<DurableCorpusEnrollmentView> {
    const normalized = normalizeContent(input.content, this.maxSourceBytes);
    if (input.contentHash !== undefined && input.contentHash !== normalized.hash) {
      throw new Error("caller content hash does not match normalized source bytes");
    }
    const nowMs = this.now().getTime();
    const current = await this.require(corpusId, caller, nowMs);
    if (input.acl.length < 1 || input.acl.length > 64 || input.acl.some((entry) => !entry || entry.length > 160)) {
      throw new Error("corpus source ACL is invalid");
    }
    const sourceId = input.sourceId === undefined
      ? `gl-source-${this.idFactory().replace(/[^A-Za-z0-9]/gu, "").slice(0, 32)}`
      : `gl-source-${createHash("sha256").update(JSON.stringify({
          corpusId,
          enrollmentKey: input.sourceId,
          credentialBinding: caller.credentialBinding,
        })).digest("hex").slice(0, 32)}`;
    const existing = current.record.manifest.sources.find((source) => source.sourceId === sourceId);
    if (existing === undefined && current.record.manifest.sources.length >= MAX_MANIFEST_SOURCES) {
      throw new Error("corpus source count exceeds the supported bound");
    }
    if (existing !== undefined && existing.contentHash !== normalized.hash) {
      throw new Error("re-enrollment cannot replace source content; use corpus_update");
    }
    const expiry = this.resolveSourceExpiry(input.callerExpiresAt, current.record.expiresAt, nowMs);
    await this.options.artifacts.put({
      corpusId,
      sourceId,
      contentHash: normalized.hash,
      bytes: normalized.bytes,
      binding: caller,
    });
    const timestamp = new Date(nowMs).toISOString();
    const source: CorpusSourceManifestEntry = {
      sourceId,
      contentHash: normalized.hash,
      acl: [...input.acl],
      retentionPolicy: expiry === null ? "persistent" : new Date(expiry).toISOString(),
      deletionPolicy: input.deletionPolicy,
      lifecycleProvenance: `corpus-owned-artifact:${sourceId}`,
      citationProvenance: input.citationProvenance,
      backendProvenance: "sqlite-derived-v1",
    };
    const manifest: CorpusManifest = {
      corpusId,
      updatedAt: timestamp,
      sources: [...current.record.manifest.sources.filter((entry) => entry.sourceId !== sourceId), source]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    };
    const persisted = await this.options.repository.update(corpusId, caller, current.revision, {
      manifest,
      state: "syncing",
      deletion: current.record.deletion,
      nowMs,
    });
    let state: "active" | "degraded" = current.record.state === "degraded" ? "degraded" : "active";
    try {
      await this.options.index.upsert(corpusId, {
        sourceId,
        contentHash: normalized.hash,
        text: normalized.text,
      });
    } catch {
      state = "degraded";
    }
    await this.setState(persisted, caller, state, nowMs);
    return {
      corpusId,
      sourceId,
      contentHash: normalized.hash,
      enrolledAt: timestamp,
      expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
      lifecycle: "enrolled",
      state,
    };
  }

  async updateSource(
    corpusId: string,
    sourceId: string,
    input: DurableCorpusUpdateInput,
    caller: DurableCorpusCaller,
  ): Promise<DurableCorpusEnrollmentView> {
    const nowMs = this.now().getTime();
    const current = await this.require(corpusId, caller, nowMs);
    const existing = current.record.manifest.sources.find((source) => source.sourceId === sourceId);
    if (existing === undefined) throw new Error("corpus source is not enrolled");
    if (input.content === undefined && input.contentHash !== undefined) {
      throw new Error("contentHash cannot be updated without normalized source content");
    }
    const normalized = input.content === undefined ? null : normalizeContent(input.content, this.maxSourceBytes);
    if (normalized !== null && input.contentHash !== undefined && input.contentHash !== normalized.hash) {
      throw new Error("caller content hash does not match normalized source bytes");
    }
    if (normalized !== null) {
      await this.options.artifacts.put({
        corpusId,
        sourceId,
        contentHash: normalized.hash,
        bytes: normalized.bytes,
        binding: caller,
      });
    }
    const nextHash = normalized?.hash ?? existing.contentHash;
    const previousAcl = new Set(existing.acl);
    const nextAcl = new Set(input.acl ?? existing.acl);
    const aclChanged = previousAcl.size !== nextAcl.size ||
      [...previousAcl].some((entry) => !nextAcl.has(entry));
    const nextSource: CorpusSourceManifestEntry = {
      ...existing,
      contentHash: nextHash,
      ...(input.acl === undefined ? {} : { acl: [...input.acl] }),
      ...(input.deletionPolicy === undefined ? {} : { deletionPolicy: input.deletionPolicy }),
      ...(input.citationProvenance === undefined ? {} : { citationProvenance: input.citationProvenance }),
    };
    const manifest: CorpusManifest = {
      corpusId,
      updatedAt: new Date(nowMs).toISOString(),
      sources: current.record.manifest.sources.map((source) => source.sourceId === sourceId ? nextSource : source),
    };
    const persisted = await this.options.repository.update(corpusId, caller, current.revision, {
      manifest,
      state: normalized === null ? current.record.state : "syncing",
      deletion: current.record.deletion,
      nowMs,
    });
    let state: "active" | "degraded" = current.record.state === "degraded" ? "degraded" : "active";
    if (existing.contentHash !== nextHash || aclChanged) {
      try {
        await this.options.cache?.revoke({
          corpusId, sourceId, contentHash: existing.contentHash, binding: caller,
        });
      } catch {
        // Manifest truth is already committed; retain the update and expose
        // failed derived-state invalidation through the durable degraded state.
        state = "degraded";
      }
    }
    if (normalized !== null) {
      try {
        await this.options.index.upsert(corpusId, { sourceId, contentHash: nextHash, text: normalized.text });
        if (existing.contentHash !== nextHash) {
          await this.options.artifacts.delete({ corpusId, sourceId, contentHash: existing.contentHash, binding: caller });
        }
      } catch {
        state = "degraded";
      }
    }
    await this.setState(persisted, caller, state, nowMs);
    return {
      corpusId,
      sourceId,
      contentHash: nextHash,
      enrolledAt: new Date(current.record.createdAt).toISOString(),
      expiresAt: sourceExpiry(nextSource) === null ? null : nextSource.retentionPolicy,
      lifecycle: "enrolled",
      state,
    };
  }

  async rebuildDerivedIndex(corpusId: string, caller: DurableCorpusCaller): Promise<CorpusManifest> {
    const nowMs = this.now().getTime();
    const current = await this.require(corpusId, caller, nowMs);
    const documents: CorpusIndexDocument[] = [];
    try {
      for (const source of activeSources(current.record.manifest, nowMs)) {
        const bytes = await this.options.artifacts.read({
          corpusId,
          sourceId: source.sourceId,
          contentHash: source.contentHash,
          binding: caller,
          maxBytes: this.maxSourceBytes,
        });
        documents.push({
          sourceId: source.sourceId,
          contentHash: source.contentHash,
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        });
      }
      await this.options.index.replaceFromManifest(corpusId, documents);
      await this.setState(current, caller, "active", nowMs);
    } catch (error) {
      await this.setState(current, caller, "degraded", nowMs);
      throw error;
    }
    return current.record.manifest;
  }

  async removeSource(
    corpusId: string,
    sourceId: string,
    caller: DurableCorpusCaller,
  ): Promise<DurableCorpusRemovalView> {
    const nowMs = this.now().getTime();
    const current = await this.require(corpusId, caller, nowMs);
    const source = current.record.manifest.sources.find((entry) => entry.sourceId === sourceId);
    if (source === undefined) throw new Error("corpus source is not enrolled");
    let revoked = current;
    if (!source.lifecycleProvenance.startsWith("revoked:")) {
      const manifest: CorpusManifest = {
        corpusId,
        updatedAt: new Date(nowMs).toISOString(),
        sources: current.record.manifest.sources.map((entry) => entry.sourceId === sourceId
          ? { ...entry, lifecycleProvenance: `revoked:cleanup-pending:${entry.sourceId}` }
          : entry),
      };
      revoked = await this.options.repository.update(corpusId, caller, current.revision, {
        manifest,
        state: "syncing",
        deletion: current.record.deletion,
        nowMs,
      });
    }
    let cleanupComplete = true;
    try {
      await this.options.cache?.revoke({ corpusId, sourceId, contentHash: source.contentHash, binding: caller });
      await this.options.index.remove(corpusId, sourceId);
      cleanupComplete = await this.options.artifacts.delete({
        corpusId,
        sourceId,
        contentHash: source.contentHash,
        binding: caller,
      });
    } catch {
      cleanupComplete = false;
    }
    if (cleanupComplete) {
      const manifest: CorpusManifest = {
        corpusId,
        updatedAt: new Date(nowMs).toISOString(),
        sources: revoked.record.manifest.sources.filter((entry) => entry.sourceId !== sourceId),
      };
      await this.options.repository.update(corpusId, caller, revoked.revision, {
        manifest,
        state: "active",
        deletion: revoked.record.deletion,
        nowMs,
      });
    } else {
      await this.setState(revoked, caller, "degraded", nowMs);
    }
    return { sourceId, lifecycle: "removed", cleanupComplete };
  }

  async corpusStatus(corpusId: string, caller: DurableCorpusCaller): Promise<CorpusStatusView> {
    const current = await this.options.repository.get(corpusId, caller, this.now().getTime(), true);
    if (current === null) throw new Error("durable corpus is missing");
    return {
      ...viewFromDurable(current),
      sourceCount: activeSources(current.record.manifest, this.now().getTime()).length,
      enrolledCount: activeSources(current.record.manifest, this.now().getTime()).length,
      manifest: current.record.manifest,
      deletion: current.record.deletion,
      warnings: current.record.state === "degraded" ? ["Corpus derived index is degraded; rebuild is required."] : [],
    };
  }

  async searchCorpus(
    corpusId: string,
    query: string,
    caller: DurableCorpusCaller,
    maxResults = 10,
  ): Promise<ScopedCorpusSearchResponse> {
    const now = this.now();
    const current = await this.require(corpusId, caller, now.getTime());
    const live = new Map(activeSources(current.record.manifest, now.getTime()).map((source) => [source.sourceId, source]));
    const hits = await this.options.index.search(corpusId, query, maxResults);
    const results = hits.flatMap((hit: CorpusIndexHit) => {
      const source = live.get(hit.sourceId);
      if (source === undefined || source.contentHash !== hit.contentHash || !canRead(source, caller)) return [];
      const provenance: SearchResultProvenance = {
        sourceKind: "corpus",
        provider: "internal",
        backend: "sqlite-derived-v1",
        corpusBoundary: corpusId,
        freshnessTimestamp: now.toISOString(),
      };
      return [{
        sourceId: hit.sourceId,
        contentHash: hit.contentHash,
        snippet: hit.snippet,
        score: hit.score,
        provenance,
      }];
    }).slice(0, maxResults);
    return {
      toolFamily: "corpus_search",
      corpusId,
      query,
      results,
      warnings: current.record.state === "degraded" ? ["Corpus derived index is degraded; results may be stale."] : [],
    };
  }

  async deleteCorpus(corpusId: string, caller: DurableCorpusCaller): Promise<DeletionStatus> {
    const nowMs = this.now().getTime();
    let current = await this.options.repository.get(corpusId, caller, nowMs, true);
    if (current === null) throw new Error("durable corpus is missing");
    if (current.record.state === "deleted") return current.record.deletion;
    if (current.record.state !== "deleting") {
      current = await this.options.repository.update(corpusId, caller, current.revision, {
        manifest: current.record.manifest,
        state: "deleting",
        deletion: current.record.deletion,
        nowMs,
      });
    }
    let derivedIndexDeleted = current.record.deletion.derivedIndexDeleted;
    let artifactDeleted = current.record.deletion.artifactDeleted;
    if (!derivedIndexDeleted) {
      try {
        await this.options.index.delete(corpusId);
        derivedIndexDeleted = true;
      } catch {
        derivedIndexDeleted = false;
      }
    }
    if (!artifactDeleted) {
      artifactDeleted = true;
      for (const source of current.record.manifest.sources) {
        try {
          await this.options.cache?.revoke({ corpusId, sourceId: source.sourceId, contentHash: source.contentHash, binding: caller });
          const deleted = await this.options.artifacts.delete({
            corpusId,
            sourceId: source.sourceId,
            contentHash: source.contentHash,
            binding: caller,
          });
          artifactDeleted &&= deleted;
        } catch {
          artifactDeleted = false;
        }
      }
    }
    const deletion = {
      derivedIndexDeleted,
      artifactDeleted,
      isComplete: derivedIndexDeleted && artifactDeleted,
    };
    const updated = await this.options.repository.update(corpusId, caller, current.revision, {
      manifest: current.record.manifest,
      state: deletion.isComplete ? "deleted" : "deleting",
      deletion,
      nowMs,
    });
    return updated.record.deletion;
  }

  private async require(corpusId: string, caller: DurableCorpusCaller, nowMs: number): Promise<DurableCorpusView> {
    const view = await this.options.repository.get(corpusId, caller, nowMs);
    if (view === null) throw new Error("durable corpus is missing");
    return view;
  }

  private async setState(
    current: DurableCorpusView,
    caller: DurableCorpusCaller,
    state: "active" | "degraded",
    nowMs: number,
  ): Promise<DurableCorpusView> {
    return await this.options.repository.update(current.record.corpusId, caller, current.revision, {
      manifest: current.record.manifest,
      state,
      deletion: current.record.deletion,
      nowMs,
    });
  }

  private resolveSourceExpiry(requested: string | null, corpusExpiresAt: number | null, nowMs: number): number | null {
    const requestedMs = requested === null ? null : Date.parse(requested);
    if (requestedMs !== null && (!Number.isSafeInteger(requestedMs) || requestedMs <= nowMs)) {
      throw new Error("corpus source expiry is invalid");
    }
    if (requestedMs === null) return corpusExpiresAt;
    if (corpusExpiresAt === null) return requestedMs;
    return Math.min(requestedMs, corpusExpiresAt);
  }
}
