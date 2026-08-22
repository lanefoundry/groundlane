import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import { buildOAuthProvider } from "../../src/worker/oauth.js";
import type { WorkerEnv } from "../../src/worker/proxy.js";
import { createFakeExecutionContext, createFakeKvNamespace } from "./fakes.js";

const subtle: TimingSafeSubtleCrypto = {
  digest(algorithm, data) {
    return crypto.subtle.digest(algorithm, data);
  },
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ) {
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

const OWNER_PASSPHRASE = "owner-passphrase-0123456789abcdef";
const ctx = createFakeExecutionContext();

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

async function readJson<T>(response: Response): Promise<T> {
  const body: T = await response.json();
  return body;
}

function makeEnv(containerFetch: (request: Request) => Promise<Response>): {
  env: WorkerEnv;
} {
  return {
    env: {
      GROUNDLANE_AUTH_TOKEN: "unused-in-oauth-path",
      OAUTH_KV: createFakeKvNamespace(),
      OAUTH_OWNER_PASSPHRASE: OWNER_PASSPHRASE,
      GROUNDLANE_CONTAINER: {
        getByName() {
          return { fetch: containerFetch };
        },
      },
    },
  };
}

void test("DCR register -> authorize (passphrase) -> token -> authenticated /mcp round trip", async () => {
  const { env } = makeEnv(() =>
    Promise.resolve(Response.json({ ok: true, via: "container" }, { status: 200 })),
  );
  const provider = buildOAuthProvider(subtle);
  const redirectUri = "https://client.example/callback";

  const registerResponse = await provider.fetch(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        client_name: "Integration Test Client",
      }),
    }),
    env,
    ctx,
  );
  const registerBody = await registerResponse.text();
  assert.equal(registerResponse.status, 201, registerBody);
  const registered = JSON.parse(registerBody) as { client_id: string };
  assert.ok(registered.client_id.length > 0);

  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));

  const authorizeUrl = new URL("https://groundlane.test/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", registered.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "test-state");
  authorizeUrl.searchParams.set("scope", "mcp");

  const authorizeGet = await provider.fetch(new Request(authorizeUrl), env, ctx);
  assert.equal(authorizeGet.status, 200);
  assert.match(await authorizeGet.text(), /Integration Test Client/u);

  const approvePost = await provider.fetch(
    new Request(authorizeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passphrase: OWNER_PASSPHRASE }),
    }),
    env,
    ctx,
  );
  assert.equal(approvePost.status, 302);
  const location = new URL(approvePost.headers.get("location") ?? "");
  assert.equal(location.origin + location.pathname, redirectUri);
  assert.equal(location.searchParams.get("state"), "test-state");
  const code = location.searchParams.get("code");
  assert.ok(code !== null && code.length > 0);

  const tokenResponse = await provider.fetch(
    new Request("https://groundlane.test/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: redirectUri,
        client_id: registered.client_id,
        code_verifier: codeVerifier,
      }),
    }),
    env,
    ctx,
  );
  const tokenBody = await tokenResponse.text();
  assert.equal(tokenResponse.status, 200, tokenBody);
  const token = JSON.parse(tokenBody) as { access_token: string; token_type: string };
  assert.equal(token.token_type, "bearer");
  assert.ok(token.access_token.length > 0);

  const mcpResponse = await provider.fetch(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
      body: "{}",
    }),
    env,
    ctx,
  );
  const mcpBody = await mcpResponse.text();
  assert.equal(mcpResponse.status, 200, mcpBody);
  assert.deepEqual(JSON.parse(mcpBody), { ok: true, via: "container" });
});

void test("unauthenticated /mcp is rejected by the provider without reaching the container", async () => {
  const { env } = makeEnv(() => Promise.resolve(new Response("should not be called")));
  const provider = buildOAuthProvider(subtle);

  const response = await provider.fetch(
    new Request("https://groundlane.test/mcp", { method: "POST" }),
    env,
    ctx,
  );

  assert.equal(response.status, 401);
});

void test("wrong passphrase does not mint a usable authorization code", async () => {
  const { env } = makeEnv(() => Promise.resolve(new Response("unused")));
  const provider = buildOAuthProvider(subtle);
  const redirectUri = "https://client.example/callback";

  const registerResponse = await provider.fetch(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    ctx,
  );
  const registered = await readJson<{ client_id: string }>(registerResponse);

  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  const authorizeUrl = new URL("https://groundlane.test/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", registered.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const response = await provider.fetch(
    new Request(authorizeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passphrase: "definitely-wrong" }),
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Incorrect passphrase/u);
});
