import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import { createAuthorizeHandler } from "../../src/worker/authorize.js";
import type { WorkerEnv } from "../../src/worker/proxy.js";

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

const baseAuthRequest: AuthRequest = {
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: ["mcp"],
  state: "xyz",
};

const baseClient: ClientInfo = {
  clientId: "client-123",
  clientName: "Test Client",
  redirectUris: [baseAuthRequest.redirectUri],
  tokenEndpointAuthMethod: "none",
};

function fakeHelpers(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
  return {
    parseAuthRequest: () => Promise.resolve(baseAuthRequest),
    lookupClient: () => Promise.resolve(baseClient),
    completeAuthorization: () =>
      Promise.resolve({ redirectTo: "https://client.example/callback?code=abc&state=xyz" }),
    createClient: () => Promise.reject(new Error("not implemented")),
    listClients: () => Promise.resolve({ items: [] }),
    updateClient: () => Promise.resolve(null),
    deleteClient: () => Promise.resolve(),
    listUserGrants: () => Promise.resolve({ items: [] }),
    revokeGrant: () => Promise.resolve(),
    unwrapToken: () => Promise.resolve(null),
    exchangeToken: () => Promise.reject(new Error("not implemented")),
    purgeExpiredData: () =>
      Promise.resolve({
        grantsChecked: 0,
        grantsPurged: 0,
        tokensChecked: 0,
        tokensPurged: 0,
        done: true,
      }),
    ...overrides,
  };
}

function makeEnv(overrides: Partial<OAuthHelpers> = {}): WorkerEnv {
  return {
    GROUNDLANE_AUTH_TOKEN: "unused",
    OAUTH_KV: {} as unknown as KVNamespace,
    OAUTH_OWNER_PASSPHRASE: OWNER_PASSPHRASE,
    OAUTH_PROVIDER: fakeHelpers(overrides),
    GROUNDLANE_CONTAINER: {
      getByName() {
        throw new Error("the container must not be reached from /authorize");
      },
    },
  };
}

const ctx = {} as ExecutionContext;

void test("GET /authorize renders the passphrase form for a known client", async () => {
  const handler = createAuthorizeHandler(subtle);
  const response = await handler.fetch(
    new Request("https://groundlane.test/authorize?client_id=client-123&response_type=code"),
    makeEnv(),
    ctx,
  );

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Test Client/u);
  assert.match(body, /name="passphrase"/u);
});

void test("POST /authorize with the correct passphrase completes authorization and redirects", async () => {
  const handler = createAuthorizeHandler(subtle);
  const form = new URLSearchParams({ passphrase: OWNER_PASSPHRASE });
  const response = await handler.fetch(
    new Request("https://groundlane.test/authorize?client_id=client-123&response_type=code", {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    makeEnv(),
    ctx,
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://client.example/callback?code=abc&state=xyz",
  );
});

void test("POST /authorize with the wrong passphrase re-renders the form without completing authorization", async () => {
  const handler = createAuthorizeHandler(subtle);
  let completed = false;
  const env = makeEnv({
    completeAuthorization: () => {
      completed = true;
      return Promise.resolve({ redirectTo: "https://client.example/callback?code=abc" });
    },
  });
  const form = new URLSearchParams({ passphrase: "wrong" });
  const response = await handler.fetch(
    new Request("https://groundlane.test/authorize?client_id=client-123&response_type=code", {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Incorrect passphrase/u);
  assert.equal(completed, false);
});

void test("GET /authorize for an unknown client returns 400 without a redirect", async () => {
  const handler = createAuthorizeHandler(subtle);
  const env = makeEnv({ lookupClient: () => Promise.resolve(null) });
  const response = await handler.fetch(
    new Request("https://groundlane.test/authorize?client_id=unknown&response_type=code"),
    env,
    ctx,
  );

  assert.equal(response.status, 400);
});

void test("an invalid authorization request with a known redirect URI bounces back with an OAuth error", async () => {
  const handler = createAuthorizeHandler(subtle);
  const env = makeEnv({
    parseAuthRequest: () =>
      Promise.reject(
        new AuthorizationError("invalid_scope", {
          description: "requested scope is not supported",
          redirectUri: "https://client.example/callback",
          state: "xyz",
        }),
      ),
  });
  const response = await handler.fetch(
    new Request("https://groundlane.test/authorize?client_id=client-123"),
    env,
    ctx,
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("error"), "invalid_scope");
  assert.equal(location.searchParams.get("state"), "xyz");
});

void test("an invalid authorization request with no redirect URI is rendered locally, not redirected", async () => {
  const handler = createAuthorizeHandler(subtle);
  const env = makeEnv({
    parseAuthRequest: () =>
      Promise.reject(
        new AuthorizationError("invalid_request", { description: "unknown client_id" }),
      ),
  });
  const response = await handler.fetch(
    new Request("https://groundlane.test/authorize?client_id=unknown"),
    env,
    ctx,
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.has("location"), false);
});

void test("unrelated routes fall through to a plain 404", async () => {
  const handler = createAuthorizeHandler(subtle);
  const response = await handler.fetch(
    new Request("https://groundlane.test/other"),
    makeEnv(),
    ctx,
  );

  assert.equal(response.status, 404);
});
