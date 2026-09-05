import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import {
  CALLER_PRINCIPAL_OVERRIDE_HEADERS,
  createManagedPrincipal,
  createOAuthPrincipal,
  createStaticPrincipal,
  findSecretReuse,
  isBearerEqualToSecret,
  sanitizeCallerPrincipalHeaders,
} from "../../src/worker/auth.js";
import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import {
  buildCredentialsCliArgs,
  handleAdminCredentialsRequest,
  redactCredentialDisplay,
} from "../../src/worker/admin-credentials.js";
import {
  BoundedAuditLog,
  computeVerifier,
  createManagedCredential,
  DEFAULT_OVERLAP_SECONDS,
  FakeClock,
  FakeManagedTokenStore,
  fingerprintForAudit,
  formatManagedToken,
  getEffectiveStatus,
  isManagedTokenFormat,
  listManagedMetadata,
  authenticateManagedToken,
  ManagedTokenError,
  parseManagedToken,
  parseOverlapSeconds,
  RotateIdempotencyStore,
  rotateManagedCredential,
  revokeManagedCredential,
  toMetadata,
} from "../../src/worker/managed-tokens.js";
import {
  buildContainerRequestWithInternalContext,
  INTERNAL_CONTEXT_HEADER,
  mintInternalContext,
  stripCallerInternalHeaders,
  verifyContainerAuth,
  verifyInternalContext,
} from "../../src/worker/internal-context.js";

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

const START = Date.parse("2026-01-01T00:00:00.000Z");

function deterministicRandom(): (n: number) => Uint8Array {
  let counter = 1;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = (counter + i) & 255;
    counter += n + 7;
    return out;
  };
}

function recordingRandom(seen: number[]): (n: number) => Uint8Array {
  const inner = deterministicRandom();
  return (n: number) => {
    seen.push(n);
    return inner(n);
  };
}

// PRD 693: unified principal contract.
void test("693 unified principal uses owner and attribution-only clientId", () => {
  const s = createStaticPrincipal();
  const m = createManagedPrincipal("cred_x", ["mcp"]);
  const o = createOAuthPrincipal("client-1", ["mcp"]);
  assert.equal(s.principalId, "owner");
  assert.equal(m.principalId, "owner");
  assert.equal(o.principalId, "owner");
  assert.equal(o.clientId, "client-1");
  assert.equal(s.authMethod, "static_bearer");
  assert.equal(m.authMethod, "managed_token");
  assert.equal(o.authMethod, "oauth");
});

void test("693 caller principal override headers are stripped and never read", () => {
  const headers = new Headers({
    authorization: "Bearer x",
    "x-principal-id": "attacker",
    "x-tenant-id": "t",
    "x-groundlane-policy": "admin",
  });
  const sanitized = sanitizeCallerPrincipalHeaders(headers);
  for (const name of CALLER_PRINCIPAL_OVERRIDE_HEADERS) {
    assert.equal(sanitized.has(name), false);
  }
  assert.equal(sanitized.get("authorization"), "Bearer x");
  const stripped = stripCallerInternalHeaders(
    new Request("https://w.test/mcp", { headers }),
  );
  assert.equal(stripped.headers.get("x-principal-id"), null);
});

// PRD 694: secret separation pinned by tests.
void test("694 admin legacy passphrase signing provider secrets must differ", () => {
  assert.deepEqual(
    findSecretReuse({
      adminToken: "a",
      legacyToken: "b",
      passphrase: "c",
      signingSecret: "d",
      providerSecrets: ["e"],
    }),
    [],
  );
  const reuse = findSecretReuse({
    adminToken: "same",
    legacyToken: "same",
    passphrase: "c",
    signingSecret: "d",
  });
  assert.ok(reuse.length > 0);
  const cross = findSecretReuse({
    adminToken: "x",
    legacyToken: "y",
    passphrase: "z",
    signingSecret: "y",
  });
  assert.ok(cross.some((entry) => entry.includes("GROUNDLANE_INTERNAL_SIGNING_SECRET")));
});

void test("695 exact-secret guard fails closed on empty expected", async () => {
  assert.equal(await isBearerEqualToSecret("Bearer anything", "", subtle), false);
  assert.equal(await isBearerEqualToSecret(null, "secret", subtle), false);
});

// PRD 696: create stores verifier only, raw returned once.
void test("696 create mints >=256-bit secret and stores verifier only", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const seen: number[] = [];
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 3_600_000 },
    recordingRandom(seen),
  );
  assert.ok(seen.includes(32), `expected 32-byte entropy, saw ${seen.join(",")}`);
  assert.ok(isManagedTokenFormat(created.rawToken));
  const firstTokenPart: unknown = created.rawToken.split(" ")[0];
  const parsed = parseManagedToken(firstTokenPart as string);
  assert.ok(parsed !== null);
  assert.equal(parsed.secret.length >= 43, true);
  const stored = await store.getById(created.record.id);
  assert.ok(stored !== null);
  assert.equal(stored.verifier.length, 64);
  assert.ok(!JSON.stringify(stored).includes(parsed.secret));
  const expectedVerifier = await computeVerifier(parsed.secret, subtle);
  assert.equal(stored.verifier, expectedVerifier);
  // list/metadata never leaks verifier or raw.
  const listed = await listManagedMetadata(store, clock, {});
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes("verifier"));
  assert.ok(!serialized.includes(parsed.secret));
  assert.ok(!serialized.toLowerCase().includes("authorization"));
});

void test("token separator survives underscores in id and secret", async () => {
  // Regression: the old `_` separator misparsed any secret containing `_`
  // to the wrong credential id (401 for ~63% of random secrets). `.` is in
  // neither alphabet, so exactly one split point exists.
  const id = "cred_ab_cdEfGh012345";
  const secret = `xy_zQ${"9".repeat(58)}`;
  const token = formatManagedToken(id, secret);
  const parsed = parseManagedToken(token);
  assert.ok(parsed !== null);
  assert.equal(parsed.id, id);
  assert.equal(parsed.secret, secret);
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const verifier = await computeVerifier(secret, subtle);
  await store.insert({
    id,
    verifier,
    principalId: "owner",
    scopes: ["mcp"],
    label: "regression",
    status: "active",
    createdAt: START,
    updatedAt: START,
    expiresAt: START + 3_600_000,
  });
  const principal = await authenticateManagedToken(token, store, subtle, clock);
  assert.ok(principal !== null);
  assert.equal(principal.credentialId, id);
});

void test("696 lookup uses indexed single-row then constant-time compare", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 3_600_000 },
    deterministicRandom(),
  );
  store.getByIdCalls = 0;
  store.scanCalls = 0;
  const principal = await authenticateManagedToken(created.rawToken, store, subtle, clock);
  assert.ok(principal !== null);
  assert.equal(principal.credentialId, created.record.id);
  assert.equal(store.getByIdCalls, 1);
  assert.equal(store.scanCalls, 0);
  // Wrong secret still does single-row + compare, then null.
  const bad = `${created.rawToken.slice(0, -1)}${created.rawToken.endsWith("A") ? "B" : "A"}`;
  assert.equal(await authenticateManagedToken(bad, store, subtle, clock), null);
  // Malformed/unknown rejected without throw.
  assert.equal(await authenticateManagedToken("not-a-token", store, subtle, clock), null);
  assert.equal(
    await authenticateManagedToken("glmt_short_x", store, subtle, clock),
    null,
  );
});

// PRD 697: overlap validation.
void test("697 overlap defaults 3600 and rejects non-integers/out-of-range", () => {
  assert.equal(parseOverlapSeconds(0), 0);
  assert.equal(parseOverlapSeconds(3600), 3600);
  assert.equal(parseOverlapSeconds(86400), 86400);
  for (const bad of [-1, -0.5, 1.5, Number.NaN, 86401, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseOverlapSeconds(bad), ManagedTokenError);
  }
  for (const bad of ["3600", null, undefined, {}, [], true]) {
    assert.throws(() => parseOverlapSeconds(bad), ManagedTokenError);
  }
});

void test("697 rotate creates new id with one-to-one lineage atomically", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 86_400_000, scopes: ["mcp"], label: "a" },
    deterministicRandom(),
  );
  const rotated = await rotateManagedCredential(
    store,
    subtle,
    clock,
    { oldId: created.record.id, overlapSeconds: 60 },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  assert.notEqual(rotated.newId, created.record.id);
  const old = await store.getById(created.record.id);
  const next = await store.getById(rotated.newId);
  assert.ok(old !== null && next !== null);
  assert.equal(old.status, "rotating");
  assert.equal(old.rotatedTo, rotated.newId);
  assert.equal(next.rotatedFrom, created.record.id);
  assert.equal(next.status, "active");
  // Old verifier not overwritten or deleted.
  assert.equal(old.verifier, created.record.verifier);
  // No cycle.
  assert.notEqual(next.rotatedTo, created.record.id);
});

// PRD 698: inheritance, no privilege/expiry extension, time windows.
void test("698 rotate inherits scopes and absolute expiry without extension", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const expiresAt = START + 10_000;
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt, scopes: ["mcp"] },
    deterministicRandom(),
  );
  const rotated = await rotateManagedCredential(
    store,
    subtle,
    clock,
    { oldId: created.record.id, overlapSeconds: 3600 },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  const next = await store.getById(rotated.newId);
  assert.ok(next !== null);
  assert.deepEqual([...next.scopes], ["mcp"]);
  assert.equal(next.expiresAt, expiresAt);
  assert.equal(next.principalId, "owner");
});

void test("698 auth windows honor active and rotating min(validUntil,expiresAt)", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 10_000 },
    deterministicRandom(),
  );
  // Active usable before expiry, rejected at exact expiry boundary.
  assert.ok((await authenticateManagedToken(created.rawToken, store, subtle, clock)) !== null);
  clock.set(START + 10_000);
  assert.equal(await authenticateManagedToken(created.rawToken, store, subtle, clock), null);

  // Rotating window.
  clock.set(START);
  const store2 = new FakeManagedTokenStore();
  const c2 = await createManagedCredential(
    store2,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  const r2 = await rotateManagedCredential(
    store2,
    subtle,
    clock,
    { oldId: c2.record.id, overlapSeconds: 10 },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  const oldToken = c2.rawToken;
  const newToken = r2.rawToken as string;
  // Both usable inside overlap.
  clock.set(START + 5_000);
  assert.ok((await authenticateManagedToken(oldToken, store2, subtle, clock)) !== null);
  assert.ok((await authenticateManagedToken(newToken, store2, subtle, clock)) !== null);
  // Old rejected at exact validUntil boundary; new still usable.
  clock.set(START + 10_000);
  assert.equal(await authenticateManagedToken(oldToken, store2, subtle, clock), null);
  assert.ok((await authenticateManagedToken(newToken, store2, subtle, clock)) !== null);

  // Zero overlap: old immediately unusable.
  clock.set(START);
  const store3 = new FakeManagedTokenStore();
  const c3 = await createManagedCredential(
    store3,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  await rotateManagedCredential(
    store3,
    subtle,
    clock,
    { oldId: c3.record.id, overlapSeconds: 0 },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  assert.equal(await authenticateManagedToken(c3.rawToken, store3, subtle, clock), null);

  // Max overlap capped by absolute expiry.
  clock.set(START);
  const store4 = new FakeManagedTokenStore();
  const c4 = await createManagedCredential(
    store4,
    subtle,
    clock,
    { expiresAt: START + 5_000 },
    deterministicRandom(),
  );
  await rotateManagedCredential(
    store4,
    subtle,
    clock,
    { oldId: c4.record.id, overlapSeconds: 86400 },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  clock.set(START + 5_000);
  assert.equal(await authenticateManagedToken(c4.rawToken, store4, subtle, clock), null);
});

void test("698 revoked and disabled rejected first", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  await revokeManagedCredential(store, clock, created.record.id);
  assert.equal(await authenticateManagedToken(created.rawToken, store, subtle, clock), null);
  // Disabled row rejected.
  const c2 = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  const current = await store.getById(c2.record.id);
  assert.ok(current !== null);
  store.seed({ ...current, status: "disabled" });
  assert.equal(await authenticateManagedToken(c2.rawToken, store, subtle, clock), null);
});

// PRD 699: no scheduler, derived effective status.
void test("699 stored rotating past validUntil is rejected with derived status", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  await rotateManagedCredential(
    store,
    subtle,
    clock,
    { oldId: created.record.id, overlapSeconds: 10 },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  clock.set(START + 20_000);
  assert.equal(await authenticateManagedToken(created.rawToken, store, subtle, clock), null);
  const stored = await store.getById(created.record.id);
  assert.ok(stored !== null);
  assert.equal(stored.status, "rotating");
  const meta = toMetadata(stored, clock.now());
  assert.equal(meta.status, "rotating");
  assert.equal(meta.effectiveStatus, "rotation_expired");
  assert.equal(meta.usable, false);
  const listed = await listManagedMetadata(store, clock, {});
  const item = listed.items.find((entry) => entry.id === created.record.id);
  assert.ok(item !== undefined);
  assert.equal(item.status, "rotating");
  assert.equal(item.usable, false);
});

// PRD 700: revoke semantics.
void test("700 revoke is immediate, idempotent, and scoped to one id", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  const rotated = await rotateManagedCredential(
    store,
    subtle,
    clock,
    { oldId: created.record.id, overlapSeconds: 3600 },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  clock.advance(1000);
  const first = await revokeManagedCredential(store, clock, created.record.id);
  assert.equal(first.status, "revoked");
  assert.ok(first.revokedAt !== undefined);
  const firstAt = first.revokedAt;
  clock.advance(1000);
  const second = await revokeManagedCredential(store, clock, created.record.id);
  assert.equal(second.revokedAt, firstAt);
  // Successor unaffected; old rejected.
  assert.equal(await authenticateManagedToken(created.rawToken, store, subtle, clock), null);
  assert.ok(
    (await authenticateManagedToken(rotated.rawToken as string, store, subtle, clock)) !== null,
  );
  const successor = await store.getById(rotated.newId);
  assert.ok(successor !== null && successor.status === "active");
});

// PRD 701: storage failure fails closed.
void test("701 D1 unavailable fails closed without static fallback", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  store.setUnavailable(true);
  await assert.rejects(authenticateManagedToken(created.rawToken, store, subtle, clock), ManagedTokenError);
  await assert.rejects(listManagedMetadata(store, clock, {}), ManagedTokenError);
});

void test("701 duplicate malformed unknown disabled paths are deterministic", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000, id: "cred_duplicate_01" },
    deterministicRandom(),
  );
  assert.equal(created.record.id, "cred_duplicate_01");
  await assert.rejects(
    createManagedCredential(store, subtle, clock, {
      expiresAt: START + 100_000,
      id: "cred_duplicate_01",
    }),
    (error: unknown) => error instanceof ManagedTokenError && error.code === "duplicate_id",
  );
  assert.equal(parseManagedToken("Bearer nope"), null);
  assert.equal(await authenticateManagedToken(formatManagedToken("cred_unknown_99", "x".repeat(43)), store, subtle, clock), null);
});

// PRD 702: concurrent rotate single winner.
void test("702 concurrent rotates admit exactly one successor", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  const idem = new RotateIdempotencyStore();
  const attempts = await Promise.allSettled(
    [0, 1, 2].map(() =>
      rotateManagedCredential(
        store,
        subtle,
        clock,
        { oldId: created.record.id, overlapSeconds: 60 },
        idem,
        deterministicRandom(),
      ),
    ),
  );
  const fulfilled = attempts.filter((entry) => entry.status === "fulfilled");
  const rejected = attempts.filter((entry) => entry.status === "rejected");
  // Single-threaded fake serializes check-and-write; at least one succeeds and
  // losers conflict without a second successor. Timing may let a loser read
  // the already-rotated row, so assert exactly one stored successor.
  assert.ok(fulfilled.length >= 1);
  assert.ok(rejected.length >= 1);
  const rows = await store.scan();
  assert.equal(rows.length, 2);
  const old = await store.getById(created.record.id);
  assert.ok(old !== null && old.rotatedTo !== undefined);
  // Only the active successor may rotate again.
  await assert.rejects(
    rotateManagedCredential(store, subtle, clock, { oldId: created.record.id }, new RotateIdempotencyStore(), deterministicRandom()),
    (error: unknown) => error instanceof ManagedTokenError && error.code === "conflict",
  );
  const successorId: string = old.rotatedTo;
  const second = await rotateManagedCredential(
    store,
    subtle,
    clock,
    { oldId: successorId },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  assert.ok(second.newId !== successorId);
});

void test("702 id collision uses bounded retry without harming old row", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  // Force collision on explicit newId.
  const colliding = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  await assert.rejects(
    rotateManagedCredential(
      store,
      subtle,
      clock,
      { oldId: created.record.id, newId: colliding.record.id },
      new RotateIdempotencyStore(),
      deterministicRandom(),
    ),
    (error: unknown) => error instanceof ManagedTokenError && error.code === "conflict",
  );
  const old = await store.getById(created.record.id);
  assert.equal(old?.status, "active");
});

// PRD 703: rotate/revoke race decided by conditional write.
void test("703 revoke-first makes rotate conflict; rotate-first scopes revoke to old", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const first = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  await revokeManagedCredential(store, clock, first.record.id);
  await assert.rejects(
    rotateManagedCredential(store, subtle, clock, { oldId: first.record.id }, new RotateIdempotencyStore(), deterministicRandom()),
    (error: unknown) => error instanceof ManagedTokenError && error.code === "conflict",
  );

  const store2 = new FakeManagedTokenStore();
  const c2 = await createManagedCredential(
    store2,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  const r2 = await rotateManagedCredential(
    store2,
    subtle,
    clock,
    { oldId: c2.record.id },
    new RotateIdempotencyStore(),
    deterministicRandom(),
  );
  await revokeManagedCredential(store2, clock, c2.record.id);
  const oldRow = await store2.getById(c2.record.id);
  const newRow = await store2.getById(r2.newId);
  assert.equal(oldRow?.status, "revoked");
  assert.equal(newRow?.status, "active");
  assert.ok((await authenticateManagedToken(r2.rawToken as string, store2, subtle, clock)) !== null);
});

// PRD 704: bounded idempotency key replay.
void test("704 same idempotency key replays id without raw or second successor", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  const idem = new RotateIdempotencyStore();
  const first = await rotateManagedCredential(
    store,
    subtle,
    clock,
    { oldId: created.record.id, idempotencyKey: "key_123" },
    idem,
    deterministicRandom(),
  );
  assert.equal(first.secretAvailable, true);
  assert.ok(first.rawToken !== undefined);
  const replay = await rotateManagedCredential(
    store,
    subtle,
    clock,
    { oldId: created.record.id, idempotencyKey: "key_123" },
    idem,
    deterministicRandom(),
  );
  assert.equal(replay.isReplay, true);
  assert.equal(replay.secretAvailable, false);
  assert.equal(replay.newId, first.newId);
  assert.equal(replay.rawToken, undefined);
  const rows = await store.scan();
  assert.equal(rows.length, 2);
});

// PRD 705: audit metadata-only, pagination, no hard delete.
void test("705 audit is bounded metadata-only with pagination", async () => {
  const audit = new BoundedAuditLog(3);
  const fp = await fingerprintForAudit("admin-token", subtle);
  assert.ok(!fp.includes("admin-token"));
  audit.append({ opId: "op_1", adminFingerprint: fp, kind: "create", newId: "a", commitTime: 1, result: "ok" });
  audit.append({ opId: "op_2", adminFingerprint: fp, kind: "rotate", oldId: "a", newId: "b", overlapSeconds: 60, commitTime: 2, result: "ok" });
  audit.append({ opId: "op_3", adminFingerprint: fp, kind: "revoke", oldId: "a", commitTime: 3, result: "ok" });
  audit.append({ opId: "op_4", adminFingerprint: fp, kind: "revoke", oldId: "b", commitTime: 4, result: "ok" });
  assert.equal(audit.size, 3);
  const page = audit.list({ limit: 2 });
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor !== undefined);
  const serialized = JSON.stringify(audit.list({}));
  assert.ok(!serialized.includes("verifier"));
  assert.ok(!serialized.toLowerCase().includes("raw"));
});

void test("705 revoked records are retained, not hard deleted", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  await revokeManagedCredential(store, clock, created.record.id);
  const listed = await listManagedMetadata(store, clock, {});
  assert.ok(listed.items.some((entry) => entry.id === created.record.id && entry.status === "revoked"));
});

// PRD 706: primary/latest read, no replica, KV not truth.
void test("706 revoke is visible to the next primary lookup", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const created = await createManagedCredential(
    store,
    subtle,
    clock,
    { expiresAt: START + 100_000 },
    deterministicRandom(),
  );
  assert.ok((await authenticateManagedToken(created.rawToken, store, subtle, clock)) !== null);
  await revokeManagedCredential(store, clock, created.record.id);
  // Next request on the same primary/latest session is rejected.
  assert.equal(await authenticateManagedToken(created.rawToken, store, subtle, clock), null);
});

// PRD 707/708: internal context mint/verify/strip.
void test("707 internal context mints bounded short-lived verifiable context", async () => {
  const clock = new FakeClock(START);
  const token = await mintInternalContext(
    { signingSecret: "signing-secret-0123456789abcdef", audience: "groundlane-mcp", method: "POST", path: "/mcp", requestId: "req-1", principal: { principalId: "owner", authMethod: "static_bearer", scopes: ["mcp"] }, credentialBinding: "static:legacy" },
    subtle,
    clock,
  );
  const verified = await verifyInternalContext(
    token,
    { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "groundlane-mcp", expectedMethod: "POST", expectedPath: "/mcp", expectedRequestId: "req-1" },
    subtle,
    clock,
  );
  assert.equal(verified.ok, true);
  // Forged / wrong audience / method / path / binding / expired all rejected.
  assert.equal((await verifyInternalContext(`${token}x`, { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "groundlane-mcp", expectedMethod: "POST", expectedPath: "/mcp" }, subtle, clock)).ok, false);
  assert.equal((await verifyInternalContext(token, { signingSecret: "wrong", expectedAudience: "groundlane-mcp", expectedMethod: "POST", expectedPath: "/mcp" }, subtle, clock)).ok, false);
  assert.equal((await verifyInternalContext(token, { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "other", expectedMethod: "POST", expectedPath: "/mcp" }, subtle, clock)).ok, false);
  assert.equal((await verifyInternalContext(token, { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "groundlane-mcp", expectedMethod: "GET", expectedPath: "/mcp" }, subtle, clock)).ok, false);
  assert.equal((await verifyInternalContext(token, { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "groundlane-mcp", expectedMethod: "POST", expectedPath: "/other" }, subtle, clock)).ok, false);
  assert.equal((await verifyInternalContext(token, { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "groundlane-mcp", expectedMethod: "POST", expectedPath: "/mcp", expectedRequestId: "other" }, subtle, clock)).ok, false);
  assert.equal((await verifyInternalContext(null, { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "groundlane-mcp", expectedMethod: "POST", expectedPath: "/mcp" }, subtle, clock)).ok, false);
  clock.advance(61_000);
  assert.equal((await verifyInternalContext(token, { signingSecret: "signing-secret-0123456789abcdef", expectedAudience: "groundlane-mcp", expectedMethod: "POST", expectedPath: "/mcp" }, subtle, clock)).ok, false);
});

void test("707 worker strips caller internal headers and raw never crosses boundary", async () => {
  const clock = new FakeClock(START);
  const original = new Request("https://w.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer raw-caller-credential",
      [INTERNAL_CONTEXT_HEADER]: "forged",
      "x-principal-id": "attacker",
    },
  });
  const stripped = stripCallerInternalHeaders(original);
  assert.equal(stripped.headers.get(INTERNAL_CONTEXT_HEADER), null);
  assert.equal(stripped.headers.get("x-principal-id"), null);
  const token = await mintInternalContext(
    { signingSecret: "s", audience: "groundlane-mcp", method: "POST", path: "/mcp", requestId: "r", principal: { principalId: "owner", authMethod: "static_bearer", scopes: ["mcp"] }, credentialBinding: "static:legacy" },
    subtle,
    clock,
  );
  const forContainer = buildContainerRequestWithInternalContext(original, token, "r");
  assert.equal(forContainer.headers.get("authorization"), null);
  assert.equal(forContainer.headers.get(INTERNAL_CONTEXT_HEADER), token);
});

void test("708 container rejects raw bearer in internal mode and accepts legacy in static", async () => {
  const clock = new FakeClock(START);
  const raw = new Request("https://c.test/mcp", { headers: { authorization: "Bearer legacy" } });
  const internalRejected = await verifyContainerAuth(
    raw,
    "worker_internal_context",
    { expectedAudience: "groundlane-mcp", expectedMethod: "GET", expectedPath: "/mcp", signingSecret: "s" },
    subtle,
    clock,
  );
  assert.equal(internalRejected.ok, false);
  const legacyOk = await verifyContainerAuth(
    raw,
    "local_static",
    { legacyToken: "legacy", expectedAudience: "groundlane-mcp", expectedMethod: "GET", expectedPath: "/mcp" },
    subtle,
    clock,
  );
  assert.equal(legacyOk.ok, true);
});

// PRD 709/711: admin API contract, bounds, sanitized errors, CLI builder.
void test("709 admin create/list/rotate/revoke/expire round trip is metadata-only", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const deps = {
    env: { GROUNDLANE_ADMIN_TOKEN: "admin-0123456789abcdef-xyz" },
    store,
    audit: new BoundedAuditLog(),
    idempotency: new RotateIdempotencyStore(),
    subtle,
    clock,
  };
  const adminHeaders = { authorization: "Bearer admin-0123456789abcdef-xyz" };
  const createdRes = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ label: "t", expiresAt: START + 60_000 }),
    }),
    deps,
  );
  assert.equal(createdRes.status, 201);
  const createdBody: unknown = await createdRes.json();
  const created = createdBody as { id: string; token: string; secretAvailable: boolean };
  assert.ok(created.token.startsWith("glmt_"));
  const listedRes = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials", { headers: adminHeaders }),
    deps,
  );
  const listedBody: unknown = await listedRes.json();
  const listed = listedBody as { credentials: Array<Record<string, unknown>> };
  assert.equal(listed.credentials.length, 1);
  assert.ok(!JSON.stringify(listed).includes("verifier"));
  assert.ok(!JSON.stringify(listed).includes(created.token));
  const rotatedRes = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials/rotate", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ id: created.id, overlapSeconds: 60, idempotencyKey: "k1" }),
    }),
    deps,
  );
  assert.equal(rotatedRes.status, 200);
  const revokedRes = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials/revoke", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ id: created.id }),
    }),
    deps,
  );
  assert.equal(revokedRes.status, 200);
  const expiredRes = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials/expire", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ id: created.id }),
    }),
    deps,
  );
  assert.equal(expiredRes.status, 200);
  // Audit holds metadata only.
  const auditRes = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials/audit", { headers: adminHeaders }),
    deps,
  );
  const auditBody = await auditRes.text();
  assert.ok(!auditBody.includes("verifier"));
  assert.ok(!auditBody.includes(created.token));
});

void test("709 admin API rejects cookies and sanitizes body errors", async () => {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  const deps = {
    env: { GROUNDLANE_ADMIN_TOKEN: "admin-0123456789abcdef-xyz" },
    store,
    audit: new BoundedAuditLog(),
    idempotency: new RotateIdempotencyStore(),
    subtle,
    clock,
  };
  const malformed = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials", {
      method: "POST",
      headers: { authorization: "Bearer admin-0123456789abcdef-xyz", "content-type": "application/json", cookie: "session=abc" },
      body: "not-json",
    }),
    deps,
  );
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes("admin-0123456789abcdef-xyz"));
  const tooLarge = await handleAdminCredentialsRequest(
    new Request("https://w.test/admin/credentials", {
      method: "POST",
      headers: { authorization: "Bearer admin-0123456789abcdef-xyz", "content-type": "application/json" },
      body: JSON.stringify({ label: "x".repeat(9000), expiresAt: START + 1000 }),
    }),
    deps,
  );
  assert.equal(tooLarge.status, 400);
});

void test("711 CLI builder is pure and redaction drops secrets", () => {
  const args = buildCredentialsCliArgs("rotate", { id: "cred_1", overlapSeconds: 60, idempotencyKey: "k" });
  assert.deepEqual(args, ["groundlane", "credentials", "rotate", "--id", "cred_1", "--overlap-seconds", "60", "--idempotency-key", "k"]);
  assert.ok(!args.join(" ").includes("admin"));
  const redacted = redactCredentialDisplay({ id: "a", token: "raw", verifier: "v", authorization: "h", label: "ok" });
  assert.deepEqual(redacted, { id: "a", label: "ok" });
  assert.equal(getEffectiveStatus({ status: "active", expiresAt: 10 }, 9).usable, true);
});

void test("overlap default is 3600", () => {
  assert.equal(DEFAULT_OVERLAP_SECONDS, 3600);
});
