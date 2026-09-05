import {
  validateCorpusIdentity,
  validateDeletionStatus,
  type CorpusManifest,
  type CorpusSourceManifestEntry,
  type CorpusState,
  type DeletionStatus,
} from "./corpus-contract.js";
import type { DurableRecord, DurableRecordStorePort } from "./durable-store.js";

const CORPUS_STATES: readonly CorpusState[] = ["active", "syncing", "degraded", "deleting", "deleted"];
const MAX_ID_CHARS = 160;
const MAX_DISPLAY_NAME_CHARS = 200;
const MAX_MANIFEST_SOURCES = 500;
const MAX_FIELD_CHARS = 500;

export interface DurableCorpusBinding {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
}

export interface DurableCorpusRecord extends DurableCorpusBinding {
  readonly schemaVersion: "1";
  readonly corpusId: string;
  readonly displayName: string;
  readonly state: CorpusState;
  readonly manifest: CorpusManifest;
  readonly deletion: DeletionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
}

export interface DurableCorpusView {
  readonly record: DurableCorpusRecord;
  readonly revision: number;
}

export interface CreateDurableCorpusInput extends DurableCorpusBinding {
  readonly corpusId: string;
  readonly displayName: string;
  readonly manifest: CorpusManifest;
  readonly nowMs: number;
  readonly expiresAt?: number | null;
}

export interface UpdateDurableCorpusInput {
  readonly manifest: CorpusManifest;
  readonly state: CorpusState;
  readonly deletion: DeletionStatus;
  readonly nowMs: number;
}

function assertBoundedText(value: string, label: string, max = MAX_FIELD_CHARS): void {
  if (!value || value.length > max) throw new Error(`${label} is invalid`);
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function validateSource(entry: CorpusSourceManifestEntry): void {
  assertBoundedText(entry.sourceId, "corpus source ID", MAX_ID_CHARS);
  assertBoundedText(entry.contentHash, "corpus content hash", MAX_ID_CHARS);
  if (entry.acl.length > 64) throw new Error("corpus source ACL is invalid");
  for (const acl of entry.acl) assertBoundedText(acl, "corpus source ACL entry", MAX_ID_CHARS);
  assertBoundedText(entry.retentionPolicy, "corpus retention policy");
  assertBoundedText(entry.deletionPolicy, "corpus deletion policy");
  assertBoundedText(entry.lifecycleProvenance, "corpus lifecycle provenance");
  assertBoundedText(entry.citationProvenance, "corpus citation provenance");
  assertBoundedText(entry.backendProvenance, "corpus backend provenance");
}

function validateManifest(manifest: CorpusManifest, corpusId: string): void {
  if (manifest.corpusId !== corpusId || manifest.sources.length > MAX_MANIFEST_SOURCES) {
    throw new Error("corpus manifest is invalid");
  }
  if (Number.isNaN(Date.parse(manifest.updatedAt))) throw new Error("corpus manifest updatedAt is invalid");
  const ids = new Set<string>();
  for (const source of manifest.sources) {
    validateSource(source);
    if (ids.has(source.sourceId)) throw new Error("corpus manifest has duplicate source IDs");
    ids.add(source.sourceId);
  }
}

function validateRecord(record: DurableCorpusRecord): void {
  if (record.schemaVersion !== "1") throw new Error("durable corpus schema version is invalid");
  assertBoundedText(record.corpusId, "corpus ID", MAX_ID_CHARS);
  assertBoundedText(record.displayName, "corpus display name", MAX_DISPLAY_NAME_CHARS);
  assertBoundedText(record.tenantId, "corpus tenant ID", MAX_ID_CHARS);
  assertBoundedText(record.ownerId, "corpus owner ID", MAX_ID_CHARS);
  assertBoundedText(record.credentialBinding, "corpus credential binding", MAX_ID_CHARS);
  validateCorpusIdentity({ corpusId: record.corpusId, displayName: record.displayName });
  if (!(CORPUS_STATES as readonly string[]).includes(record.state)) throw new Error("durable corpus state is invalid");
  validateManifest(record.manifest, record.corpusId);
  validateDeletionStatus(record.deletion);
  assertTimestamp(record.createdAt, "corpus createdAt");
  assertTimestamp(record.updatedAt, "corpus updatedAt");
  if (record.updatedAt < record.createdAt) throw new Error("corpus updatedAt precedes createdAt");
  if (record.expiresAt !== null && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt)) {
    throw new Error("corpus expiresAt is invalid");
  }
  if (record.state === "deleted" && !record.deletion.isComplete) throw new Error("deleted corpus requires completed deletion");
}

function encode(record: DurableCorpusRecord): string {
  validateRecord(record);
  return JSON.stringify(record);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("durable corpus record is malformed");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("durable corpus record is malformed");
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new Error("durable corpus record is malformed");
  return value;
}

function decodeSource(value: unknown): CorpusSourceManifestEntry {
  const source = objectValue(value);
  if (!Array.isArray(source.acl) || !source.acl.every((entry) => typeof entry === "string")) {
    throw new Error("durable corpus record is malformed");
  }
  return {
    sourceId: stringValue(source.sourceId),
    contentHash: stringValue(source.contentHash),
    acl: source.acl,
    retentionPolicy: stringValue(source.retentionPolicy),
    deletionPolicy: stringValue(source.deletionPolicy),
    lifecycleProvenance: stringValue(source.lifecycleProvenance),
    citationProvenance: stringValue(source.citationProvenance),
    backendProvenance: stringValue(source.backendProvenance),
  };
}

function decodeManifest(value: unknown): CorpusManifest {
  const manifest = objectValue(value);
  if (!Array.isArray(manifest.sources)) throw new Error("durable corpus record is malformed");
  return {
    corpusId: stringValue(manifest.corpusId),
    updatedAt: stringValue(manifest.updatedAt),
    sources: manifest.sources.map((source) => decodeSource(source)),
  };
}

function decodeDeletion(value: unknown): DeletionStatus {
  const deletion = objectValue(value);
  if (
    typeof deletion.derivedIndexDeleted !== "boolean" || typeof deletion.artifactDeleted !== "boolean" ||
    typeof deletion.isComplete !== "boolean"
  ) throw new Error("durable corpus record is malformed");
  return {
    derivedIndexDeleted: deletion.derivedIndexDeleted,
    artifactDeleted: deletion.artifactDeleted,
    isComplete: deletion.isComplete,
  };
}

function decodeState(value: unknown): CorpusState {
  if (typeof value !== "string" || !(CORPUS_STATES as readonly string[]).includes(value)) {
    throw new Error("durable corpus record is malformed");
  }
  return value as CorpusState;
}

function decode(stored: DurableRecord): DurableCorpusRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.value) as unknown;
  } catch {
    throw new Error("durable corpus record is malformed");
  }
  const item = objectValue(parsed);
  if (item.schemaVersion !== "1" || !(item.expiresAt === null || typeof item.expiresAt === "number")) {
    throw new Error("durable corpus record is malformed");
  }
  const record: DurableCorpusRecord = {
    schemaVersion: "1",
    corpusId: stringValue(item.corpusId),
    displayName: stringValue(item.displayName),
    tenantId: stringValue(item.tenantId),
    ownerId: stringValue(item.ownerId),
    credentialBinding: stringValue(item.credentialBinding),
    state: decodeState(item.state),
    manifest: decodeManifest(item.manifest),
    deletion: decodeDeletion(item.deletion),
    createdAt: numberValue(item.createdAt),
    updatedAt: numberValue(item.updatedAt),
    expiresAt: item.expiresAt,
  };
  try {
    validateRecord(record);
  } catch (error) {
    throw new Error("durable corpus record is malformed", { cause: error });
  }
  if (stored.expiresAt !== record.expiresAt) throw new Error("durable corpus expiry metadata is inconsistent");
  return record;
}

function keyFor(corpusId: string): string {
  assertBoundedText(corpusId, "corpus ID", MAX_ID_CHARS);
  if (!/^[A-Za-z0-9._-]+$/u.test(corpusId)) throw new Error("corpus ID is invalid");
  return `corpus:${corpusId}`;
}

function assertBinding(record: DurableCorpusRecord, binding: DurableCorpusBinding): void {
  if (
    record.tenantId !== binding.tenantId || record.ownerId !== binding.ownerId ||
    record.credentialBinding !== binding.credentialBinding
  ) throw new Error("corpus ownership or credential binding mismatch");
}

export class DurableCorpusRepository {
  constructor(private readonly store: DurableRecordStorePort) {}

  async create(input: CreateDurableCorpusInput): Promise<{ status: "created" | "exists"; view: DurableCorpusView }> {
    const record: DurableCorpusRecord = {
      schemaVersion: "1",
      corpusId: input.corpusId,
      displayName: input.displayName,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      credentialBinding: input.credentialBinding,
      state: "active",
      manifest: input.manifest,
      deletion: { derivedIndexDeleted: false, artifactDeleted: false, isComplete: false },
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
      expiresAt: input.expiresAt ?? null,
    };
    const result = await this.store.createIfAbsent({
      key: keyFor(input.corpusId), value: encode(record), nowMs: input.nowMs, expiresAt: record.expiresAt,
    });
    const decoded = decode(result.record);
    assertBinding(decoded, input);
    return { status: result.status, view: { record: decoded, revision: result.record.revision } };
  }

  async get(corpusId: string, binding: DurableCorpusBinding, nowMs: number, includeRevoked = false): Promise<DurableCorpusView | null> {
    assertTimestamp(nowMs, "corpus read time");
    const stored = await this.store.get(keyFor(corpusId));
    if (stored === null) return null;
    const record = decode(stored);
    assertBinding(record, binding);
    if (record.expiresAt !== null && record.expiresAt <= nowMs) throw new Error("corpus has expired");
    if (!includeRevoked && (record.state === "deleting" || record.state === "deleted")) throw new Error("corpus access is revoked");
    return { record, revision: stored.revision };
  }

  async update(
    corpusId: string,
    binding: DurableCorpusBinding,
    expectedRevision: number,
    input: UpdateDurableCorpusInput,
  ): Promise<DurableCorpusView> {
    const current = await this.get(corpusId, binding, input.nowMs, true);
    if (current === null) throw new Error("durable corpus is missing");
    if (current.revision !== expectedRevision) throw new Error("durable corpus revision conflict");
    if (current.record.state === "deleted") throw new Error("deleted corpus is terminal");
    const next: DurableCorpusRecord = {
      ...current.record,
      state: input.state,
      manifest: input.manifest,
      deletion: input.deletion,
      updatedAt: input.nowMs,
    };
    const result = await this.store.compareAndSwap(keyFor(corpusId), expectedRevision, {
      value: encode(next), nowMs: input.nowMs, expiresAt: next.expiresAt,
    });
    if (result.status !== "updated") throw new Error("durable corpus revision conflict");
    return { record: decode(result.record), revision: result.record.revision };
  }

  scanExpired(nowMs: number, cursor: string | null, limit: number): ReturnType<DurableRecordStorePort["scanExpired"]> {
    return this.store.scanExpired(nowMs, cursor, limit);
  }
}
