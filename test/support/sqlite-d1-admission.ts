import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { D1BatchResult, D1DatabaseLike, D1StatementLike } from "../../src/worker/d1-managed-store.js";

class Statement implements D1StatementLike {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: SQLInputValue[] = []) {}
  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map((value) => {
      if (value === null || typeof value === "string" || typeof value === "number") return value;
      throw new Error("Unsupported fixture binding");
    }));
  }
  first<T>(): Promise<T | null> { return Promise.resolve((this.db.prepare(this.sql).get(...this.values) ?? null) as T | null); }
  all<T>(): Promise<{ results: readonly T[] }> { return Promise.resolve({ results: this.db.prepare(this.sql).all(...this.values) as T[] }); }
  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    return Promise.resolve({ success: true, meta: { changes: Number(this.db.prepare(this.sql).run(...this.values).changes) } });
  }
}

export class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");
  sessions = 0;
  beforeBatch: (() => void) | undefined;
  failAt: number | undefined;
  constructor() {
    this.db.exec("CREATE TABLE durable_records(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER,PRIMARY KEY(namespace,key)) STRICT");
  }
  prepare(query: string): Statement { return new Statement(this.db, query); }
  withSession(constraint: string): this { assert.equal(constraint, "first-primary"); this.sessions++; return this; }
  batch(statements: readonly D1StatementLike[]): Promise<readonly D1BatchResult[]> {
    this.beforeBatch?.();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failAt) throw new Error("private backend SQL details");
        if (!(statement instanceof Statement)) throw new Error("Invalid fixture statement");
        return { success: true, meta: { changes: Number(this.db.prepare(statement.sql).run(...statement.values).changes) } };
      });
      this.db.exec("COMMIT"); return Promise.resolve(results);
    } catch (error) { this.db.exec("ROLLBACK"); return Promise.reject(error instanceof Error ? error : new Error("Fixture transaction failed")); }
  }
}
