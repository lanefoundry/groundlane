import {
  validateDurableKey,
  validateDurableValue,
  validateDurableWrite,
  type DurableCasResult,
  type DurableCreateResult,
  type DurableDeleteResult,
  type DurableExpiredPage,
  type DurableRecord,
  type DurableRecordStorePort,
  type DurableRecordUpdate,
  type NewDurableRecord,
} from "../core/durable-store.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";

const FIRST_PRIMARY = "first-primary";
const RECORD_COLUMNS = "key, value, revision, created_at, updated_at, expires_at";

function storageUnavailable(cause?: unknown): Error {
  return new Error("durable metadata store unavailable", { cause });
}

function decodeRecord(row: Record<string, unknown> | null): DurableRecord | null {
  if (row === null) return null;
  const { key, value, revision, created_at: createdAt, updated_at: updatedAt, expires_at: expiresAt } = row;
  if (
    typeof key !== "string" || typeof value !== "string" ||
    !Number.isSafeInteger(revision) || Number(revision) < 1 ||
    !Number.isSafeInteger(createdAt) || Number(createdAt) < 0 ||
    !Number.isSafeInteger(updatedAt) || Number(updatedAt) < Number(createdAt) ||
    !(expiresAt === null || (Number.isSafeInteger(expiresAt) && Number(expiresAt) > Number(createdAt)))
  ) {
    throw storageUnavailable();
  }
  try {
    validateDurableKey(key);
    validateDurableValue(value);
  } catch (error) {
    throw storageUnavailable(error);
  }
  return {
    key,
    value,
    revision: Number(revision),
    createdAt: Number(createdAt),
    updatedAt: Number(updatedAt),
    expiresAt: expiresAt === null ? null : Number(expiresAt),
  };
}

/** Cloudflare D1 adapter for bounded metadata; large bytes remain in R2. */
export class D1DurableRecordStore implements DurableRecordStorePort {
  constructor(private readonly db: D1DatabaseLike, private readonly namespace: string) {
    validateDurableKey(namespace);
  }

  private readDb(): D1DatabaseLike {
    return typeof this.db.withSession === "function" ? this.db.withSession(FIRST_PRIMARY) : this.db;
  }

  private async select(key: string): Promise<DurableRecord | null> {
    try {
      const row = await this.readDb()
        .prepare(`SELECT ${RECORD_COLUMNS} FROM durable_records WHERE namespace = ? AND key = ? LIMIT 1`)
        .bind(this.namespace, key)
        .first<Record<string, unknown>>();
      return decodeRecord(row);
    } catch (error) {
      if (error instanceof Error && error.message === "durable metadata store unavailable") throw error;
      throw storageUnavailable(error);
    }
  }

  get(key: string): Promise<DurableRecord | null> {
    validateDurableKey(key);
    return this.select(key);
  }

  async createIfAbsent(input: NewDurableRecord): Promise<DurableCreateResult> {
    validateDurableKey(input.key);
    validateDurableWrite(input);
    let changes: number;
    try {
      const result = await this.db.prepare(
        "INSERT INTO durable_records (namespace, key, value, revision, created_at, updated_at, expires_at) " +
        "VALUES (?, ?, ?, 1, ?, ?, ?) ON CONFLICT(namespace, key) DO NOTHING",
      ).bind(this.namespace, input.key, input.value, input.nowMs, input.nowMs, input.expiresAt ?? null).run();
      if (!result.success) throw storageUnavailable();
      changes = result.meta.changes;
    } catch (error) {
      if (error instanceof Error && error.message === "durable metadata store unavailable") throw error;
      throw storageUnavailable(error);
    }
    const record = await this.select(input.key);
    if (record === null) throw storageUnavailable();
    return changes === 1 ? { status: "created", record } : { status: "exists", record };
  }

  async compareAndSwap(key: string, expectedRevision: number, update: DurableRecordUpdate): Promise<DurableCasResult> {
    validateDurableKey(key);
    validateDurableWrite(update);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("expected revision is invalid");
    let changes: number;
    try {
      const result = await this.db.prepare(
        "UPDATE durable_records SET value = ?, revision = revision + 1, updated_at = ?, expires_at = ? " +
        "WHERE namespace = ? AND key = ? AND revision = ?",
      ).bind(update.value, update.nowMs, update.expiresAt ?? null, this.namespace, key, expectedRevision).run();
      if (!result.success) throw storageUnavailable();
      changes = result.meta.changes;
    } catch (error) {
      if (error instanceof Error && error.message === "durable metadata store unavailable") throw error;
      throw storageUnavailable(error);
    }
    const record = await this.select(key);
    if (changes === 1) {
      if (record === null) throw storageUnavailable();
      return { status: "updated", record };
    }
    return record === null ? { status: "missing" } : { status: "conflict", record };
  }

  async deleteIfRevision(key: string, expectedRevision: number): Promise<DurableDeleteResult> {
    validateDurableKey(key);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("expected revision is invalid");
    let changes: number;
    try {
      const result = await this.db.prepare(
        "DELETE FROM durable_records WHERE namespace = ? AND key = ? AND revision = ?",
      ).bind(this.namespace, key, expectedRevision).run();
      if (!result.success) throw storageUnavailable();
      changes = result.meta.changes;
    } catch (error) {
      if (error instanceof Error && error.message === "durable metadata store unavailable") throw error;
      throw storageUnavailable(error);
    }
    if (changes === 1) return "deleted";
    return await this.select(key) === null ? "missing" : "conflict";
  }

  async scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("expiry scan timestamp is invalid");
    if (cursor !== null) validateDurableKey(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("expiry scan limit must be 1..1000");
    try {
      const result = await this.readDb().prepare(
        `SELECT ${RECORD_COLUMNS} FROM durable_records ` +
        "WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ? AND key > ? ORDER BY key LIMIT ?",
      ).bind(this.namespace, nowMs, cursor ?? "", limit + 1).all<Record<string, unknown>>();
      const decoded = result.results.map((row) => decodeRecord(row));
      if (decoded.some((row) => row === null)) throw storageUnavailable();
      const records = decoded.filter((row): row is DurableRecord => row !== null).slice(0, limit);
      return { records, nextCursor: decoded.length > limit ? (records.at(-1)?.key ?? null) : null };
    } catch (error) {
      if (error instanceof Error && error.message === "durable metadata store unavailable") throw error;
      throw storageUnavailable(error);
    }
  }
}

/** Compile-time guard that the generated Cloudflare D1 binding satisfies the adapter surface. */
export function createD1DurableRecordStore(db: D1Database, namespace: string): D1DurableRecordStore {
  return new D1DurableRecordStore(db, namespace);
}
