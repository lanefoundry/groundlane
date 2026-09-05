import assert from "node:assert/strict";
import test from "node:test";

import type { D1DatabaseLike, D1StatementLike } from "../../src/worker/d1-managed-store.js";
import { D1DurableRecordStore } from "../../src/worker/d1-durable-store.js";

class FakeDurableD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly sessionConstraints: string[] = [];
  failAll = false;

  prepare(query: string): D1StatementLike {
    return new FakeDurableStatement(this, query);
  }

  batch(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  withSession(constraint: string): D1DatabaseLike {
    this.sessionConstraints.push(constraint);
    return this;
  }

  assertAvailable(): void {
    if (this.failAll) throw new Error("D1 unavailable");
  }

  rowKey(namespace: unknown, key: unknown): string {
    return `${String(namespace)}\u0000${String(key)}`;
  }
}

class FakeDurableStatement implements D1StatementLike {
  private bound: readonly unknown[] = [];

  constructor(private readonly db: FakeDurableD1, private readonly query: string) {}

  bind(...values: unknown[]): D1StatementLike {
    this.bound = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    this.db.assertAvailable();
    const row = this.db.rows.get(this.db.rowKey(this.bound[0], this.bound[1]));
    return Promise.resolve((row === undefined ? null : { ...row }) as T | null);
  }

  all<T>(): Promise<{ results: readonly T[] }> {
    this.db.assertAvailable();
    const [namespace, nowMs, cursor, limit] = this.bound as [string, number, string, number];
    const rows = [...this.db.rows.values()]
      .filter((row) => row.namespace === namespace && typeof row.expires_at === "number" && row.expires_at <= nowMs && String(row.key) > cursor)
      .sort((left, right) => String(left.key).localeCompare(String(right.key)))
      .slice(0, limit)
      .map(({ namespace: ignored, ...row }) => { void ignored; return { ...row }; });
    return Promise.resolve({ results: rows as unknown as readonly T[] });
  }

  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    this.db.assertAvailable();
    if (this.query.startsWith("INSERT INTO durable_records")) {
      const [namespace, key, value, createdAt, updatedAt, expiresAt] = this.bound;
      const id = this.db.rowKey(namespace, key);
      if (this.db.rows.has(id)) return Promise.resolve({ success: true, meta: { changes: 0 } });
      this.db.rows.set(id, { namespace, key, value, revision: 1, created_at: createdAt, updated_at: updatedAt, expires_at: expiresAt });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith("UPDATE durable_records")) {
      const [value, updatedAt, expiresAt, namespace, key, expectedRevision] = this.bound;
      const id = this.db.rowKey(namespace, key);
      const row = this.db.rows.get(id);
      if (row === undefined || row.revision !== expectedRevision) return Promise.resolve({ success: true, meta: { changes: 0 } });
      this.db.rows.set(id, { ...row, value, revision: Number(row.revision) + 1, updated_at: updatedAt, expires_at: expiresAt });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith("DELETE FROM durable_records")) {
      const [namespace, key, expectedRevision] = this.bound;
      const id = this.db.rowKey(namespace, key);
      const row = this.db.rows.get(id);
      if (row === undefined || row.revision !== expectedRevision) return Promise.resolve({ success: true, meta: { changes: 0 } });
      this.db.rows.delete(id);
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    throw new Error(`unexpected query: ${this.query}`);
  }
}

void test("D1 durable store creates once and fences stale writers", async () => {
  const db = new FakeDurableD1();
  const left = new D1DurableRecordStore(db, "jobs");
  const right = new D1DurableRecordStore(db, "jobs");
  const results = await Promise.all([
    left.createIfAbsent({ key: "job:one", value: "left", nowMs: 10 }),
    right.createIfAbsent({ key: "job:one", value: "right", nowMs: 10 }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["created", "exists"]);
  const updated = await left.compareAndSwap("job:one", 1, { value: "done", nowMs: 20 });
  assert.equal(updated.status, "updated");
  const stale = await right.compareAndSwap("job:one", 1, { value: "stale", nowMs: 30 });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.status === "conflict" ? stale.record.value : "", "done");
  assert.equal(await right.deleteIfRevision("job:one", 1), "conflict");
  assert.equal(await left.deleteIfRevision("job:one", 2), "deleted");
  assert.equal(await left.deleteIfRevision("job:one", 2), "missing");
  assert.ok(db.sessionConstraints.every((constraint) => constraint === "first-primary"));
});

void test("D1 durable store expiry scan is bounded and namespace isolated", async () => {
  const db = new FakeDurableD1();
  const jobs = new D1DurableRecordStore(db, "jobs");
  const cache = new D1DurableRecordStore(db, "cache");
  for (const key of ["job:a", "job:b", "job:c"]) {
    await jobs.createIfAbsent({ key, value: key, nowMs: 10, expiresAt: 20 });
  }
  await cache.createIfAbsent({ key: "job:a", value: "cache", nowMs: 10, expiresAt: 20 });
  const first = await jobs.scanExpired(30, null, 2);
  assert.deepEqual(first.records.map((record) => record.key), ["job:a", "job:b"]);
  assert.equal(first.nextCursor, "job:b");
  const second = await jobs.scanExpired(30, first.nextCursor, 2);
  assert.deepEqual(second.records.map((record) => record.key), ["job:c"]);
  assert.equal(second.nextCursor, null);
});

void test("D1 durable store fails closed on outage and malformed rows", async () => {
  const db = new FakeDurableD1();
  const store = new D1DurableRecordStore(db, "jobs");
  db.rows.set(db.rowKey("jobs", "job:bad"), {
    namespace: "jobs", key: "job:bad", value: "x", revision: 0,
    created_at: 10, updated_at: 10, expires_at: null,
  });
  await assert.rejects(store.get("job:bad"), /store unavailable/u);
  db.failAll = true;
  await assert.rejects(store.get("job:any"), /store unavailable/u);
  await assert.rejects(store.createIfAbsent({ key: "job:new", value: "x", nowMs: 10 }), /store unavailable/u);
});
