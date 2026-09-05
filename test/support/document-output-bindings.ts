import assert from "node:assert/strict";
import type { D1DatabaseLike, D1StatementLike } from "../../src/worker/d1-managed-store.js";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike } from "../../src/worker/r2-immutable-blob.js";

export class FakeD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly sessions: string[] = [];
  prepare(query: string): D1StatementLike { return new Statement(this, query); }
  batch(): Promise<readonly []> { return Promise.resolve([]); }
  withSession(constraint: string): D1DatabaseLike { this.sessions.push(constraint); return this; }
}

class Statement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private db: FakeD1, private query: string) {}
  bind(...values: unknown[]): D1StatementLike { this.values = values; return this; }
  first<T>(): Promise<T | null> {
    return Promise.resolve((this.db.rows.get(`${String(this.values[0])}:${String(this.values[1])}`) as T | undefined) ?? null);
  }
  all<T>(): Promise<{ results: readonly T[] }> {
    const [namespace, time, cursor, limit] = this.values;
    const rows = [...this.db.rows.values()].filter(row => row.namespace === namespace &&
      typeof row.expires_at === "number" && row.expires_at <= Number(time) && String(row.key) > String(cursor))
      .sort((a, b) => String(a.key).localeCompare(String(b.key))).slice(0, Number(limit));
    return Promise.resolve({ results: rows.map(row => ({ ...row }) as T) });
  }
  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    let changes = 0;
    if (this.query.startsWith("INSERT")) {
      const [namespace, key, value, created_at, updated_at, expires_at] = this.values;
      const id = `${String(namespace)}:${String(key)}`;
      if (!this.db.rows.has(id)) {
        this.db.rows.set(id, { namespace, key, value, created_at, updated_at, expires_at, revision: 1 });
        changes = 1;
      }
    } else if (this.query.startsWith("UPDATE")) {
      const [value, updated_at, expires_at, namespace, key, revision] = this.values;
      const id = `${String(namespace)}:${String(key)}`;
      const row = this.db.rows.get(id);
      if (row?.revision === revision) {
        this.db.rows.set(id, { ...row, value, updated_at, expires_at, revision: Number(revision) + 1 });
        changes = 1;
      }
    } else if (this.query.startsWith("DELETE")) {
      const [namespace, key, revision] = this.values;
      const id = `${String(namespace)}:${String(key)}`;
      if (this.db.rows.get(id)?.revision === revision) { this.db.rows.delete(id); changes = 1; }
    } else throw new Error("Unexpected query");
    return Promise.resolve({ success: true, meta: { changes } });
  }
}

export class FakeR2 implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  failDelete = false;
  head(key: string): Promise<R2ObjectLike | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : { size: object.bytes.length, customMetadata: object.metadata });
  }
  get(key: string): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : {
      size: object.bytes.length, customMetadata: object.metadata, bytes: () => Promise.resolve(object.bytes.slice()),
    });
  }
  put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string> }): Promise<R2ObjectLike | null> {
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.objects.has(key)) return Promise.resolve(null);
    this.objects.set(key, { bytes: bytes.slice(), metadata: { ...options.customMetadata } });
    return this.head(key);
  }
  delete(key: string): Promise<void> {
    if (this.failDelete) return Promise.reject(new Error("private upstream response"));
    this.objects.delete(key);
    return Promise.resolve();
  }
}
