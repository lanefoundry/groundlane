import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  MAX_IMMUTABLE_BLOB_BYTES,
  validateBlobIdentity,
  validateInternalBlobKey,
  type ImmutableBlobPort,
  type ImmutableBlobPutResult,
  type ImmutableBlobStat,
} from "../../core/immutable-blob.js";

interface BlobRow {
  readonly blob_key: string;
  readonly owner_id: string;
  readonly digest: string;
  readonly byte_size: number;
  readonly bytes?: Uint8Array;
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMMUTABLE_BLOB_BYTES) {
    throw new Error("immutable blob size is outside the supported bounds");
  }
}

function decodeStat(row: Record<string, unknown> | undefined): ImmutableBlobStat | null {
  if (row === undefined) return null;
  const candidate = row as Partial<BlobRow>;
  if (
    typeof candidate.blob_key !== "string" || typeof candidate.owner_id !== "string" ||
    typeof candidate.digest !== "string" || typeof candidate.byte_size !== "number"
  ) throw new Error("SQLite immutable blob row is malformed");
  validateInternalBlobKey(candidate.blob_key);
  validateBlobIdentity(candidate.owner_id, candidate.digest);
  validateSize(candidate.byte_size);
  return {
    blobKey: candidate.blob_key,
    ownerId: candidate.owner_id,
    digest: candidate.digest,
    byteSize: candidate.byte_size,
  };
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Local/self-hosted immutable payload storage; metadata stays in DurableRecordStorePort. */
export class SqliteImmutableBlobStore implements ImmutableBlobPort {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly namespace: string) {
    if (!namespace || namespace.length > 120 || !/^[A-Za-z0-9._:-]+$/u.test(namespace)) {
      throw new Error("immutable blob namespace is invalid");
    }
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.database.exec(`CREATE TABLE IF NOT EXISTS immutable_blobs (
      namespace TEXT NOT NULL,
      blob_key TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (namespace, blob_key)
    ) STRICT;`);
  }

  close(): void {
    this.database.close();
  }

  /** Bounded operational/test diagnostic; payload contents are never returned. */
  count(): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM immutable_blobs WHERE namespace = ?",
    ).get(this.namespace) as { count?: unknown } | undefined;
    if (typeof row?.count !== "number") throw new Error("immutable blob count is malformed");
    return row.count;
  }

  async putIfAbsent(input: {
    blobKey: string;
    ownerId: string;
    digest: string;
    bytes: Uint8Array;
  }): Promise<ImmutableBlobPutResult> {
    validateInternalBlobKey(input.blobKey);
    validateBlobIdentity(input.ownerId, input.digest);
    validateSize(input.bytes.byteLength);
    if (digestBytes(input.bytes) !== input.digest) throw new Error("immutable blob digest mismatch");
    const result = this.database.prepare(
      "INSERT OR IGNORE INTO immutable_blobs (namespace, blob_key, owner_id, digest, byte_size, bytes) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(this.namespace, input.blobKey, input.ownerId, input.digest, input.bytes.byteLength, input.bytes);
    const stat = await this.stat(input.blobKey);
    if (Number(result.changes) === 1) {
      if (stat === null) throw new Error("immutable blob create did not produce a row");
      return { status: "created", stat };
    }
    return stat !== null && stat.ownerId === input.ownerId && stat.digest === input.digest &&
        stat.byteSize === input.bytes.byteLength
      ? { status: "exists", stat }
      : { status: "conflict", stat };
  }

  stat(blobKey: string): Promise<ImmutableBlobStat | null> {
    validateInternalBlobKey(blobKey);
    const row = this.database.prepare(
      "SELECT blob_key, owner_id, digest, byte_size FROM immutable_blobs WHERE namespace = ? AND blob_key = ?",
    ).get(this.namespace, blobKey);
    return Promise.resolve(decodeStat(row));
  }

  get(input: {
    blobKey: string;
    ownerId: string;
    digest: string;
    maxBytes: number;
  }): Promise<Uint8Array | null> {
    validateInternalBlobKey(input.blobKey);
    validateBlobIdentity(input.ownerId, input.digest);
    validateSize(input.maxBytes);
    const row = this.database.prepare(
      "SELECT blob_key, owner_id, digest, byte_size, bytes FROM immutable_blobs WHERE namespace = ? AND blob_key = ?",
    ).get(this.namespace, input.blobKey) as Record<string, unknown> | undefined;
    const stat = decodeStat(row);
    if (row === undefined || stat === null) return Promise.resolve(null);
    if (stat.ownerId !== input.ownerId || stat.digest !== input.digest) {
      throw new Error("immutable blob owner or digest mismatch");
    }
    if (stat.byteSize > input.maxBytes) throw new Error("immutable blob exceeds the read limit");
    const bytes = row.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== stat.byteSize || digestBytes(bytes) !== stat.digest) {
      throw new Error("immutable blob integrity check failed");
    }
    return Promise.resolve(bytes.slice());
  }

  async deleteIfOwner(blobKey: string, ownerId: string): Promise<"deleted" | "missing" | "owner_mismatch"> {
    validateInternalBlobKey(blobKey);
    const stat = await this.stat(blobKey);
    if (stat === null) return "missing";
    if (stat.ownerId !== ownerId) return "owner_mismatch";
    const result = this.database.prepare(
      "DELETE FROM immutable_blobs WHERE namespace = ? AND blob_key = ? AND owner_id = ?",
    ).run(this.namespace, blobKey, ownerId);
    return Number(result.changes) === 1 ? "deleted" : "missing";
  }
}
