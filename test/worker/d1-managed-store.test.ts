import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import {
  D1ManagedTokenStore,
  type D1BatchResult,
  type D1DatabaseLike,
  type D1StatementLike,
} from "../../src/worker/d1-managed-store.js";
import {
  authenticateManagedToken,
  computeVerifier,
  FakeClock,
  formatManagedToken,
  ManagedTokenError,
  type ManagedCredentialRecord,
} from "../../src/worker/managed-tokens.js";

const subtle: TimingSafeSubtleCrypto = {
  digest(algorithm, data) {
    return crypto.subtle.digest(algorithm, data);
  },
  timingSafeEqual(left, right) {
    return timingSafeEqual(
      left instanceof ArrayBuffer
        ? new Uint8Array(left)
        : new Uint8Array(left.buffer, left.byteOffset, left.byteLength),
      right instanceof ArrayBuffer
        ? new Uint8Array(right)
        : new Uint8Array(right.buffer, right.byteOffset, right.byteLength),
    );
  },
};

// Minimal fake D1: rows stored snake_case like the real table. Batch executes
// sequentially over a snapshot and restores it on throw, mirroring D1's
// transactional batch semantics (abort rolls back the whole sequence).
class FakeD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly sessionConstraints: string[] = [];
  failAll = false;

  withSession(constraint: string): D1DatabaseLike {
    this.sessionConstraints.push(constraint);
    return this;
  }

  prepare(query: string): D1StatementLike {
    return new FakeStatement(this, query);
  }

  assertAvailable(): void {
    if (this.failAll) throw new Error("d1 down");
  }

  async batch(statements: readonly D1StatementLike[]): Promise<readonly D1BatchResult[]> {
    this.assertAvailable();
    const snapshot = new Map(
      [...this.rows.entries()].map(([id, row]) => [id, { ...row }]),
    );
    const results: D1BatchResult[] = [];
    try {
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.rows.clear();
      for (const [id, row] of snapshot) this.rows.set(id, row);
      throw error;
    }
  }

  execute(
    query: string,
    bound: readonly unknown[],
  ): { success: boolean; meta: { changes: number } } {
    if (query.includes("WHERE EXISTS")) {
      const oldId = String(bound[bound.length - 1]);
      const old = this.rows.get(oldId);
      if (
        old === undefined ||
        old.status !== "active" ||
        old.rotated_to !== null
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      const id = String(bound[0]);
      if (this.rows.has(id)) throw new Error("UNIQUE constraint failed: id");
      this.rows.set(id, rowFromInsert(bound.slice(0, 13)));
      return { success: true, meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO managed_credentials (id,")) {
      const id = String(bound[0]);
      if (this.rows.has(id)) throw new Error("UNIQUE constraint failed: id");
      this.rows.set(id, rowFromInsert(bound));
      return { success: true, meta: { changes: 1 } };
    }
    if (query.startsWith("UPDATE managed_credentials SET status = ?, valid_until")) {
      const [status, validUntil, rotatedTo, updatedAt, id] = bound as [
        string,
        number,
        string,
        number,
        string,
      ];
      const row = this.rows.get(id);
      if (row === undefined || row.status !== "active" || row.rotated_to !== null) {
        return { success: true, meta: { changes: 0 } };
      }
      this.rows.set(id, {
        ...row,
        status,
        valid_until: validUntil,
        rotated_to: rotatedTo,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (query.includes("COALESCE(revoked_at")) {
      const [now, updatedAt, id] = bound as [number, number, string];
      const row = this.rows.get(id);
      if (row === undefined || row.status === "revoked") {
        return { success: true, meta: { changes: 0 } };
      }
      this.rows.set(id, {
        ...row,
        status: "revoked",
        revoked_at: row.revoked_at ?? now,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 0 } };
    }
    if (query.includes("expires_at = CASE")) {
      const [now, again, updatedAt, id] = bound as [number, number, number, string];
      void again;
      const row = this.rows.get(id);
      if (row === undefined) return { success: true, meta: { changes: 0 } };
      this.rows.set(id, {
        ...row,
        expires_at: Math.min(Number(row.expires_at), now),
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  }
}

class FakeStatement implements D1StatementLike {
  private bound: readonly unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    this.bound = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    this.db.assertAvailable();
    const row = this.db.rows.get(String(this.bound[0]));
    return Promise.resolve(
      (row === undefined ? null : { ...row }) as unknown as T | null,
    );
  }

  all<T>(): Promise<{ results: readonly T[] }> {
    this.db.assertAvailable();
    const rows = [...this.db.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => Number(a.created_at) - Number(b.created_at))
      .slice(0, 500);
    return Promise.resolve({ results: rows as unknown as readonly T[] });
  }

  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    this.db.assertAvailable();
    return Promise.resolve(this.db.execute(this.query, this.bound));
  }
}

function rowFromInsert(bound: readonly unknown[]): Record<string, unknown> {
  const keys = [
    "id",
    "verifier",
    "principal_id",
    "scopes",
    "label",
    "status",
    "created_at",
    "updated_at",
    "expires_at",
    "valid_until",
    "rotated_to",
    "rotated_from",
    "revoked_at",
  ];
  return Object.fromEntries(keys.map((key, index) => [key, bound[index]]));
}

function testRecord(id: string, verifier: string): ManagedCredentialRecord {
  return {
    id,
    verifier,
    principalId: "owner",
    scopes: ["mcp"],
    label: "test",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 9_999_999_999_999,
  };
}

void test("D1 store insert/get round trip reads through a first-primary session", async () => {
  const db = new FakeD1();
  const store = new D1ManagedTokenStore(db);
  await store.insert(testRecord("a", "v"));
  const row = await store.getById("a");
  assert.equal(row?.id, "a");
  assert.equal(row?.verifier, "v");
  assert.deepEqual(row?.scopes, ["mcp"]);
  // Writes go direct (D1 routes writes to primary); authorization reads use
  // a first-primary session.
  assert.deepEqual(db.sessionConstraints, ["first-primary"]);
  assert.equal(await store.getById("missing"), null);
});

void test("D1 store insert duplicate surfaces duplicate_id, outage fails closed", async () => {
  const db = new FakeD1();
  const store = new D1ManagedTokenStore(db);
  await store.insert(testRecord("a", "v"));
  await assert.rejects(store.insert(testRecord("a", "v")), (error: unknown) => {
    assert.ok(error instanceof ManagedTokenError);
    assert.equal(error.code, "duplicate_id");
    return true;
  });
  db.failAll = true;
  await assert.rejects(store.getById("a"), (error: unknown) => {
    assert.ok(error instanceof ManagedTokenError);
    assert.equal(error.code, "storage_unavailable");
    return true;
  });
  await assert.rejects(store.scan(), (error: unknown) => {
    assert.ok(error instanceof ManagedTokenError);
    assert.equal(error.code, "storage_unavailable");
    return true;
  });
});

void test("D1 store rotate commits atomically; second rotate conflicts", async () => {
  const db = new FakeD1();
  const store = new D1ManagedTokenStore(db);
  await store.insert(testRecord("old", "v"));
  const next = { ...testRecord("new", "v2"), rotatedFrom: "old" };
  const first = await store.tryRotate(
    "old",
    { status: "rotating", validUntil: 5_000, rotatedTo: "new", updatedAt: 2_000 },
    next,
  );
  assert.deepEqual(first, { ok: true });
  const second = await store.tryRotate(
    "old",
    { status: "rotating", validUntil: 6_000, rotatedTo: "new2", updatedAt: 3_000 },
    { ...testRecord("new2", "v3"), rotatedFrom: "old" },
  );
  // Mirrors FakeManagedTokenStore: status is evaluated before rotatedTo,
  // so the loser sees a stable status conflict.
  assert.deepEqual(second, { ok: false, reason: "status:rotating" });
  // No partial successor from the losing attempt.
  assert.equal(await store.getById("new2"), null);
  const old = await store.getById("old");
  assert.equal(old?.status, "rotating");
  assert.equal(old?.rotatedTo, "new");
});

void test("D1 store rotate maps lineage mismatch and id collision without damage", async () => {
  const db = new FakeD1();
  const store = new D1ManagedTokenStore(db);
  await store.insert(testRecord("old", "v"));
  await store.insert(testRecord("taken", "v"));
  const mismatch = await store.tryRotate(
    "old",
    { status: "rotating", validUntil: 5_000, rotatedTo: "wrong", updatedAt: 2_000 },
    { ...testRecord("new", "v2"), rotatedFrom: "someone-else" },
  );
  assert.deepEqual(mismatch, { ok: false, reason: "lineage_mismatch" });
  const collision = await store.tryRotate(
    "old",
    { status: "rotating", validUntil: 5_000, rotatedTo: "taken", updatedAt: 2_000 },
    { ...testRecord("taken", "v2"), rotatedFrom: "old" },
  );
  assert.deepEqual(collision, { ok: false, reason: "id_collision" });
  // Old row untouched by either failed attempt.
  const old = await store.getById("old");
  assert.equal(old?.status, "active");
  assert.equal(old?.rotatedTo, undefined);
});

void test("D1 store revoke is idempotent with first revoked_at winning", async () => {
  const db = new FakeD1();
  const store = new D1ManagedTokenStore(db);
  await store.insert(testRecord("a", "v"));
  const first = await store.revokeById("a", 5_000);
  assert.equal(first?.status, "revoked");
  assert.equal(first?.revokedAt, 5_000);
  const second = await store.revokeById("a", 9_000);
  assert.equal(second?.revokedAt, 5_000);
  assert.equal(await store.revokeById("missing", 5_000), null);
});

void test("D1 store expire clamps and scan orders without leaking shape", async () => {
  const db = new FakeD1();
  const store = new D1ManagedTokenStore(db);
  await store.insert({ ...testRecord("b", "v"), createdAt: 2_000, updatedAt: 2_000 });
  await store.insert({ ...testRecord("a", "v"), createdAt: 1_000, updatedAt: 1_000 });
  const expired = await store.expireById("a", 5_000);
  assert.equal(expired?.expiresAt, 5_000);
  const rows = await store.scan();
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
});

void test("D1 store rejects malformed rows fail-closed", async () => {
  const db = new FakeD1();
  db.rows.set("bad", { id: "bad", verifier: "", principal_id: "owner" });
  const store = new D1ManagedTokenStore(db);
  await assert.rejects(store.getById("bad"), (error: unknown) => {
    assert.ok(error instanceof ManagedTokenError);
    assert.equal(error.code, "storage_unavailable");
    return true;
  });
});

void test("managed token authenticates end to end against the D1 store", async () => {
  const db = new FakeD1();
  const store = new D1ManagedTokenStore(db);
  const clock = new FakeClock(10_000);
  const secret = "s".repeat(64);
  const verifier = await computeVerifier(secret, subtle);
  await store.insert({
    ...testRecord("cred_live000000001", verifier),
    expiresAt: clock.now() + 3_600_000,
  });
  const principal = await authenticateManagedToken(
    formatManagedToken("cred_live000000001", secret),
    store,
    subtle,
    clock,
  );
  assert.equal(principal?.principalId, "owner");
  // After revoke, the next primary-session read rejects the same token.
  await store.revokeById("cred_live000000001", clock.now());
  assert.equal(
    await authenticateManagedToken(
      formatManagedToken("cred_live000000001", secret),
      store,
      subtle,
      clock,
    ),
    null,
  );
});
