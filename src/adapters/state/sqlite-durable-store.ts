import { DatabaseSync } from "node:sqlite";

import {
  validateDurableKey,
  validateDurableWrite,
  type DurableCasResult,
  type DurableCreateResult,
  type DurableDeleteResult,
  type DurableExpiredPage,
  type DurableRecord,
  type DurableRecordStorePort,
  type DurableRecordUpdate,
  type NewDurableRecord,
} from "../../core/durable-store.js";

interface DurableRow {
  key: string;
  value: string;
  revision: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

function decodeRow(row: Record<string, unknown> | undefined): DurableRecord | null {
  if (row === undefined) return null;
  const candidate = row as Partial<DurableRow>;
  if (
    typeof candidate.key !== "string" || typeof candidate.value !== "string" ||
    typeof candidate.revision !== "number" || typeof candidate.created_at !== "number" ||
    typeof candidate.updated_at !== "number" ||
    !(candidate.expires_at === null || typeof candidate.expires_at === "number")
  ) throw new Error("durable metadata row is malformed");
  return {
    key: candidate.key,
    value: candidate.value,
    revision: candidate.revision,
    createdAt: candidate.created_at,
    updatedAt: candidate.updated_at,
    expiresAt: candidate.expires_at,
  };
}

export class SqliteDurableRecordStore implements DurableRecordStorePort {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly namespace: string) {
    validateDurableKey(namespace);
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.database.exec(`CREATE TABLE IF NOT EXISTS durable_records (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (namespace, key)
    ) STRICT;`);
  }

  close(): void {
    this.database.close();
  }

  get(key: string): Promise<DurableRecord | null> {
    validateDurableKey(key);
    const row = this.database.prepare("SELECT key, value, revision, created_at, updated_at, expires_at FROM durable_records WHERE namespace = ? AND key = ?").get(this.namespace, key);
    return Promise.resolve(decodeRow(row));
  }

  async createIfAbsent(input: NewDurableRecord): Promise<DurableCreateResult> {
    validateDurableKey(input.key);
    validateDurableWrite(input);
    const expiresAt = input.expiresAt ?? null;
    const result = this.database.prepare("INSERT OR IGNORE INTO durable_records (namespace, key, value, revision, created_at, updated_at, expires_at) VALUES (?, ?, ?, 1, ?, ?, ?)").run(this.namespace, input.key, input.value, input.nowMs, input.nowMs, expiresAt);
    const record = await this.get(input.key);
    if (record === null) throw new Error("durable metadata create did not produce a record");
    return Number(result.changes) === 1 ? { status: "created", record } : { status: "exists", record };
  }

  async compareAndSwap(key: string, expectedRevision: number, update: DurableRecordUpdate): Promise<DurableCasResult> {
    validateDurableKey(key);
    validateDurableWrite(update);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("expected revision is invalid");
    const result = this.database.prepare("UPDATE durable_records SET value = ?, revision = revision + 1, updated_at = ?, expires_at = ? WHERE namespace = ? AND key = ? AND revision = ?").run(update.value, update.nowMs, update.expiresAt ?? null, this.namespace, key, expectedRevision);
    const record = await this.get(key);
    if (Number(result.changes) === 1) {
      if (record === null) throw new Error("durable metadata update lost its record");
      return { status: "updated", record };
    }
    return record === null ? { status: "missing" } : { status: "conflict", record };
  }

  async deleteIfRevision(key: string, expectedRevision: number): Promise<DurableDeleteResult> {
    validateDurableKey(key);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("expected revision is invalid");
    const result = this.database.prepare("DELETE FROM durable_records WHERE namespace = ? AND key = ? AND revision = ?").run(this.namespace, key, expectedRevision);
    if (Number(result.changes) === 1) return "deleted";
    return await this.get(key) === null ? "missing" : "conflict";
  }

  scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("expiry scan timestamp is invalid");
    if (cursor !== null) validateDurableKey(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("expiry scan limit must be 1..1000");
    const rows = this.database.prepare("SELECT key, value, revision, created_at, updated_at, expires_at FROM durable_records WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ? AND key > ? ORDER BY key LIMIT ?").all(this.namespace, nowMs, cursor ?? "", limit + 1);
    const decoded = rows.map((row) => decodeRow(row)).filter((row): row is DurableRecord => row !== null);
    const hasMore = decoded.length > limit;
    const records = decoded.slice(0, limit);
    return Promise.resolve({ records, nextCursor: hasMore ? (records.at(-1)?.key ?? null) : null });
  }
}
