import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import { handleWorkerRequest, type WorkerEnv } from "../../src/worker/handler.js";
import {
  BoundedAuditLog,
  createManagedCredential,
  FakeClock,
  FakeManagedTokenStore,
  RotateIdempotencyStore,
} from "../../src/worker/managed-tokens.js";
import { createFakeExecutionContext, createFakeKvNamespace } from "./fakes.js";

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

const ctx = createFakeExecutionContext();
const START = Date.parse("2026-02-01T00:00:00.000Z");
const LEGACY = "legacy-token-0123456789abcdef-xyzzy";
const ADMIN = "admin-token-0123456789abcdef-qqqq";
const PASSPHRASE = "owner-passphrase-0123456789abcdef";

type TestEnv = WorkerEnv & {
  GROUNDLANE_ADMIN_TOKEN?: string;
  GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
  GROUNDLANE_AUTH_MODE?: string;
  __MANAGED_STORE__?: FakeManagedTokenStore | null;
  __MANAGED_CLOCK__?: FakeClock;
  __ADMIN_AUDIT__?: BoundedAuditLog;
  __ADMIN_IDEMPOTENCY__?: RotateIdempotencyStore;
};

function mockEnv(overrides: Partial<TestEnv> = {}): { env: TestEnv; containerCalls: Request[] } {
  const containerCalls: Request[] = [];
  const env: TestEnv = {
    GROUNDLANE_AUTH_TOKEN: LEGACY,
    GROUNDLANE_ADMIN_TOKEN: ADMIN,
    OAUTH_KV: createFakeKvNamespace(),
    OAUTH_OWNER_PASSPHRASE: PASSPHRASE,
    GROUNDLANE_CONTAINER: {
      getByName() {
        return {
          running: true,
          fetch: (request: Request) => {
            containerCalls.push(request);
            return Promise.resolve(Response.json({ ok: true }));
          },
        };
      },
    },
    __MANAGED_STORE__: null,
    __MANAGED_CLOCK__: new FakeClock(START),
    __ADMIN_AUDIT__: new BoundedAuditLog(),
    __ADMIN_IDEMPOTENCY__: new RotateIdempotencyStore(),
    ...overrides,
  };
  return { env, containerCalls };
}

async function setupManaged(): Promise<{ store: FakeManagedTokenStore; clock: FakeClock; rawToken: string; id: string }> {
  const store = new FakeManagedTokenStore();
  const clock = new FakeClock(START);
  let counter = 100;
  const random = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = (counter + i) & 255;
    counter += n + 13;
    return out;
  };
  const created = await createManagedCredential(store, subtle, clock, { expiresAt: START + 3_600_000 }, random);
  return { store, clock, rawToken: created.rawToken, id: created.record.id };
}

async function fetchOAuthAccessToken(env: TestEnv): Promise<string> {
  const { buildOAuthProvider } = await import("../../src/worker/oauth.js");
  const provider = buildOAuthProvider(subtle);
  const redirectUri = "https://client.example/callback";
  const register = await provider.fetch(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    }),
    env,
    ctx,
  );
  assert.equal(register.status, 201);
  const registerBody: unknown = await register.json();
  const { client_id: clientId } = registerBody as { client_id: string };
  const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
  const verifier = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = toB64(challengeBytes);
  const authUrl = new URL("https://groundlane.test/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const approve = await provider.fetch(
    new Request(authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passphrase: PASSPHRASE }),
    }),
    env,
    ctx,
  );
  assert.equal(approve.status, 302);
  const location = new URL(approve.headers.get("location") as string);
  const code = location.searchParams.get("code") as string;
  const tokenRes = await provider.fetch(
    new Request("https://groundlane.test/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    }),
    env,
    ctx,
  );
  assert.equal(tokenRes.status, 200);
  const tokenBody: unknown = await tokenRes.json();
  const { access_token: accessToken } = tokenBody as { access_token: string };
  return accessToken;
}

// PRD 695/712: admin is rejected on data-plane routes.
void test("712 admin bearer is rejected on mcp readyz oauth register", async () => {
  const { env } = mockEnv();
  for (const path of ["/mcp", "/readyz", "/authorize", "/token", "/register", "/.well-known/oauth-authorization-server"]) {
    const method = path === "/mcp" || path === "/register" || path === "/token" ? "POST" : "GET";
    const response = await handleWorkerRequest(
      new Request(`https://groundlane.test${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
      env,
      subtle,
      ctx,
    );
    assert.equal(response.status, 403, path);
  }
});

// PRD 695/709: data-plane tokens are 403 on admin, missing is 401.
void test("712 data-plane tokens are forbidden on admin, missing is unauthorized", async () => {
  const managed = await setupManaged();
  const { env } = mockEnv({ __MANAGED_STORE__: managed.store, __MANAGED_CLOCK__: managed.clock });
  const oauth = await fetchOAuthAccessToken(env);
  const cases: Array<{ name: string; headers?: HeadersInit | undefined; expected: number }> = [
    { name: "legacy", headers: { authorization: `Bearer ${LEGACY}` }, expected: 403 },
    { name: "managed", headers: { authorization: `Bearer ${managed.rawToken}` }, expected: 403 },
    { name: "oauth", headers: { authorization: `Bearer ${oauth}` }, expected: 403 },
    { name: "missing", expected: 401 },
  ];
  for (const entry of cases) {
    const response = await handleWorkerRequest(
      new Request(
        "https://groundlane.test/admin/credentials",
        entry.headers === undefined ? {} : { headers: entry.headers },
      ),
      env,
      subtle,
      ctx,
    );
    assert.equal(response.status, entry.expected, entry.name);
  }
});

// PRD 712: legacy matrix.
void test("712 legacy bearer matrix", async () => {
  const { env, containerCalls } = mockEnv();
  const mcp = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST", headers: { authorization: `Bearer ${LEGACY}` }, body: "{}" }),
    env,
    subtle,
    ctx,
  );
  assert.equal(mcp.status, 200);
  assert.equal(containerCalls.length, 1);
  const readyz = await handleWorkerRequest(
    new Request("https://groundlane.test/readyz", { headers: { authorization: `Bearer ${LEGACY}` } }),
    env,
    subtle,
    ctx,
  );
  assert.equal(readyz.status, 200);
  // /register with legacy reaches OAuth DCR (anti-abuse compat, not admin auth).
  const register = await handleWorkerRequest(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { authorization: `Bearer ${LEGACY}`, "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }),
    }),
    env,
    subtle,
    ctx,
  );
  assert.equal(register.status, 201);
});

// PRD 712: managed matrix (valid managed reaches data-plane, never admin).
void test("712 managed bearer matrix", async () => {
  const managed = await setupManaged();
  const { env } = mockEnv({ __MANAGED_STORE__: managed.store, __MANAGED_CLOCK__: managed.clock });
  const mcp = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST", headers: { authorization: `Bearer ${managed.rawToken}` }, body: "{}" }),
    env,
    subtle,
    ctx,
  );
  assert.equal(mcp.status, 200);
  const readyz = await handleWorkerRequest(
    new Request("https://groundlane.test/readyz", { headers: { authorization: `Bearer ${managed.rawToken}` } }),
    env,
    subtle,
    ctx,
  );
  assert.equal(readyz.status, 200);
  // Managed must not unlock DCR register.
  const register = await handleWorkerRequest(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { authorization: `Bearer ${managed.rawToken}`, "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }),
    }),
    env,
    subtle,
    ctx,
  );
  assert.equal(register.status, 401);
});

// PRD 712: OAuth matrix.
void test("712 oauth bearer matrix", async () => {
  const { env } = mockEnv();
  const oauth = await fetchOAuthAccessToken(env);
  const mcp = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST", headers: { authorization: `Bearer ${oauth}`, "content-type": "application/json" }, body: "{}" }),
    env,
    subtle,
    ctx,
  );
  assert.equal(mcp.status, 200);
  const readyz = await handleWorkerRequest(
    new Request("https://groundlane.test/readyz", { headers: { authorization: `Bearer ${oauth}` } }),
    env,
    subtle,
    ctx,
  );
  // /readyz is data-plane static/managed only; OAuth is not accepted there.
  assert.equal(readyz.status, 401);
  const register = await handleWorkerRequest(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { authorization: `Bearer ${oauth}`, "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }),
    }),
    env,
    subtle,
    ctx,
  );
  assert.equal(register.status, 401);
});

// PRD 712: missing credential matrix.
void test("712 missing credential matrix", async () => {
  const { env } = mockEnv();
  assert.equal((await handleWorkerRequest(new Request("https://groundlane.test/mcp", { method: "POST" }), env, subtle, ctx)).status, 401);
  assert.equal((await handleWorkerRequest(new Request("https://groundlane.test/readyz"), env, subtle, ctx)).status, 401);
  assert.equal(
    (
      await handleWorkerRequest(
        new Request("https://groundlane.test/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
        env,
        subtle,
        ctx,
      )
    ).status,
    401,
  );
  // OAuth discovery stays public.
  assert.equal((await handleWorkerRequest(new Request("https://groundlane.test/.well-known/oauth-authorization-server"), env, subtle, ctx)).status, 200);
});

// PRD 710: missing admin fails closed, data-plane continues.
void test("710 missing admin token fails closed for admin but data-plane continues", async () => {
  const { env } = mockEnv({ GROUNDLANE_ADMIN_TOKEN: "" });
  const admin = await handleWorkerRequest(new Request("https://groundlane.test/admin/credentials"), env, subtle, ctx);
  assert.equal(admin.status, 503);
  const mcp = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST", headers: { authorization: `Bearer ${LEGACY}` }, body: "{}" }),
    env,
    subtle,
    ctx,
  );
  assert.equal(mcp.status, 200);
});

// PRD 713: managed-unavailable is explicit, no silent multi-static fallback.
void test("713 managed presented without D1 reports unavailable", async () => {
  const managed = await setupManaged();
  const { env } = mockEnv({ __MANAGED_STORE__: null, __MANAGED_CLOCK__: managed.clock });
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST", headers: { authorization: `Bearer ${managed.rawToken}` }, body: "{}" }),
    env,
    subtle,
    ctx,
  );
  assert.equal(response.status, 503);
  const body: unknown = await response.json();
  const { error } = body as { error: { code: string } };
  assert.equal(error.code, "managed_unavailable");
  // Static still works in the same deployment.
  const legacy = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST", headers: { authorization: `Bearer ${LEGACY}` }, body: "{}" }),
    env,
    subtle,
    ctx,
  );
  assert.equal(legacy.status, 200);
});

// PRD 693: caller override headers cannot escalate to admin or impersonate.
void test("693 caller override headers cannot gain admin or change decision", async () => {
  const { env } = mockEnv();
  const forged = await handleWorkerRequest(
    new Request("https://groundlane.test/admin/credentials", {
      headers: { "x-principal-id": "owner", "x-tenant-id": "t", "x-groundlane-policy": "admin" },
    }),
    env,
    subtle,
    ctx,
  );
  assert.equal(forged.status, 401);
  const mcp = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${LEGACY}`, "x-principal-id": "attacker" },
    }),
    env,
    subtle,
    ctx,
  );
  assert.equal(mcp.status, 200);
});

// PRD 707: worker strips caller internal headers before proxying.
void test("707 worker strips caller internal headers before container", async () => {
  const { env, containerCalls } = mockEnv();
  const { INTERNAL_CONTEXT_HEADER } = await import("../../src/worker/internal-context.js");
  await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${LEGACY}`,
        [INTERNAL_CONTEXT_HEADER]: "forged",
        "x-groundlane-internal-auth": "forged",
        "x-principal-id": "attacker",
      },
      body: "{}",
    }),
    env,
    subtle,
    ctx,
  );
  assert.equal(containerCalls.length, 1);
  const forwarded = containerCalls[0] as Request;
  assert.equal(forwarded.headers.get(INTERNAL_CONTEXT_HEADER), null);
  assert.equal(forwarded.headers.get("x-groundlane-internal-auth"), null);
  assert.equal(forwarded.headers.get("x-principal-id"), null);
});

void test("Worker and Container select signed-context mode from the same signing-secret boundary", async () => {
  const { INTERNAL_CONTEXT_HEADER } = await import("../../src/worker/internal-context.js");
  const { env, containerCalls } = mockEnv({
    GROUNDLANE_INTERNAL_SIGNING_SECRET: "internal-signing-secret-0123456789abcdef",
    // This is deliberately an unrecognized Worker-only injection. Production
    // mode is derived from the signing-secret binding and cannot drift from
    // GroundlaneContainer.envVars.
    GROUNDLANE_AUTH_MODE: "local_static",
  });
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${LEGACY}` },
      body: "{}",
    }),
    env,
    subtle,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(containerCalls.length, 1);
  const forwarded = containerCalls[0] as Request;
  assert.ok((forwarded.headers.get(INTERNAL_CONTEXT_HEADER) ?? "").length > 0);
  assert.equal(forwarded.headers.get("authorization"), null);
});
