import assert from "node:assert/strict";
import test from "node:test";

import { D1CorpusDerivedIndex } from "../../src/adapters/state/d1-corpus-index.js";
import type {
  D1BatchResult,
  D1DatabaseLike,
  D1StatementLike,
} from "../../src/worker/d1-managed-store.js";

class SearchStatement implements D1StatementLike {
  bind(...values: unknown[]): D1StatementLike {
    void values;
    return this;
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return Promise.resolve(null);
  }

  all<T = Record<string, unknown>>(): Promise<{ results: readonly T[] }> {
    return Promise.resolve({
      results: [{
        source_id: "source-1",
        content_hash: "hash-1",
        normalized_text: "Groundlane primary session result",
      } as T],
    });
  }

  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    return Promise.resolve({ success: true, meta: { changes: 0 } });
  }
}

class SessionTrackingD1 implements D1DatabaseLike {
  readonly sessionConstraints: string[] = [];

  withSession(constraint: string): D1DatabaseLike {
    this.sessionConstraints.push(constraint);
    return this;
  }

  prepare(query: string): D1StatementLike {
    void query;
    return new SearchStatement();
  }

  batch(statements: readonly D1StatementLike[]): Promise<readonly D1BatchResult[]> {
    void statements;
    return Promise.resolve([]);
  }
}

void test("D1 corpus search reads through a first-primary session", async () => {
  const db = new SessionTrackingD1();
  const index = new D1CorpusDerivedIndex(db, "corpus-index-v1");

  const hits = await index.search("corpus-1", "primary", 5);

  assert.deepEqual(db.sessionConstraints, ["first-primary"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.sourceId, "source-1");
});
