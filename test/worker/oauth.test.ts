import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import {
  buildOAuthProvider,
  validateDcrClientMetadata,
} from "../../src/worker/oauth.js";
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
const GROUNDLANE_AUTH_TOKEN = "container-shared-secret-0123456789abcdef";
const ctx = createFakeExecutionContext();

/**
 * Mirrors the real Container's independent bearer check
 * (src/container/app.ts) — it only understands GROUNDLANE_AUTH_TOKEN, not
 * OAuth access tokens. Using a container fake that ignores auth entirely
 * would hide exactly the bug where the Worker forwarded a client's OAuth
 * token downstream unchanged instead of substituting the shared secret.
 */
function containerRequiringSharedSecret(
  onAuthenticated: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => {
    if (request.headers.get("authorization") !== `Bearer ${GROUNDLANE_AUTH_TOKEN}`) {
      return Promise.resolve(
        Response.json(
          { error: { code: "unauthorized", message: "A valid bearer token is required" } },
          { status: 401, headers: { "www-authenticate": 'Bearer realm="groundlane"' } },
        ),
      );
    }
    return onAuthenticated(request);
  };
}

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
      GROUNDLANE_AUTH_TOKEN,
      OAUTH_KV: createFakeKvNamespace(),
      OAUTH_OWNER_PASSPHRASE: OWNER_PASSPHRASE,
      GROUNDLANE_CONTAINER: {
        getByName() {
          return {
            start: () => Promise.resolve(),
            fetch: containerRequiringSharedSecret(containerFetch),
          };
        },
      },
    },
  };
}

void test("DCR application type and redirect policy is explicit", () => {
  assert.equal(validateDcrClientMetadata({
    application_type: "web",
    redirect_uris: ["https://client.example/callback"],
  }), undefined);
  assert.equal(validateDcrClientMetadata({
    application_type: "native",
    redirect_uris: ["http://127.0.0.1:43210/callback"],
  }), undefined);
  for (const metadata of [
    { redirect_uris: ["https://client.example/callback"] },
    { application_type: "web", redirect_uris: ["http://127.0.0.1/callback"] },
    { application_type: "native", redirect_uris: ["https://client.example/callback"] },
  ]) {
    assert.equal(validateDcrClientMetadata(metadata)?.code, "invalid_client_metadata");
  }
});

void test("configured DCR rejects omitted and mismatched application types", async () => {
  const { env } = makeEnv(() => Promise.resolve(new Response("unused")));
  const provider = buildOAuthProvider(subtle);
  for (const body of [
    { redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" },
    {
      application_type: "web",
      redirect_uris: ["http://127.0.0.1:43210/callback"],
      token_endpoint_auth_method: "none",
    },
  ]) {
    const response = await provider.fetch(
      new Request("https://groundlane.test/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 400);
    const error = await readJson<{ error: string }>(response);
    assert.equal(error.error, "invalid_client_metadata");
  }
});

void test("OAuth metadata keeps issuer, resource, RFC 9207, and CIMD consistent", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Cloudflare");
  Object.defineProperty(globalThis, "Cloudflare", {
    configurable: true,
    value: { compatibilityFlags: { global_fetch_strictly_public: true } },
  });
  try {
    const { env } = makeEnv(() => Promise.resolve(new Response("unused")));
    const provider = buildOAuthProvider(subtle);
    const authorization = await readJson<Record<string, unknown>>(await provider.fetch(
      new Request("https://groundlane.test/.well-known/oauth-authorization-server"),
      env,
      ctx,
    ));
    const resource = await readJson<Record<string, unknown>>(await provider.fetch(
      new Request("https://groundlane.test/.well-known/oauth-protected-resource/mcp"),
      env,
      ctx,
    ));
    assert.equal(authorization.issuer, "https://groundlane.test");
    assert.equal(authorization.authorization_endpoint, "https://groundlane.test/authorize");
    assert.equal(authorization.token_endpoint, "https://groundlane.test/token");
    assert.equal(authorization.registration_endpoint, "https://groundlane.test/register");
    assert.equal(authorization.authorization_response_iss_parameter_supported, true);
    assert.equal(authorization.client_id_metadata_document_supported, true);
    assert.deepEqual(authorization.scopes_supported, ["mcp"]);
    assert.equal(resource.resource, "https://groundlane.test/mcp");
    assert.deepEqual(resource.authorization_servers, [authorization.issuer]);
    assert.deepEqual(resource.bearer_methods_supported, ["header"]);
    const metadataText = JSON.stringify({ authorization, resource });
    assert.equal(metadataText.includes(GROUNDLANE_AUTH_TOKEN), false);
    assert.equal(metadataText.includes(OWNER_PASSPHRASE), false);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "Cloudflare");
    } else {
      Object.defineProperty(globalThis, "Cloudflare", previous);
    }
  }
});

void test("CIMD fetch accepts a matching bounded document and rejects a wrong client id", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Cloudflare");
  Object.defineProperty(globalThis, "Cloudflare", {
    configurable: true,
    value: { compatibilityFlags: { global_fetch_strictly_public: true } },
  });
  const validClientId = "https://client.example/oauth/client.json";
  const wrongClientId = "https://client.example/oauth/wrong.json";
  const redirectUri = "https://client.example/callback";
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    return Promise.resolve(Response.json({
      client_id: url === wrongClientId ? validClientId : url,
      client_name: "CIMD Contract Client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }));
  });
  try {
    const { env } = makeEnv(() => Promise.resolve(new Response("unused")));
    const provider = buildOAuthProvider(subtle);
    async function authorize(clientId: string) {
      const url = new URL("https://groundlane.test/authorize");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("code_challenge", "A".repeat(43));
      url.searchParams.set("code_challenge_method", "S256");
      return provider.fetch(new Request(url), env, ctx);
    }
    const accepted = await authorize(validClientId);
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /CIMD Contract Client/u);
    await assert.rejects(
      authorize(wrongClientId),
      (error: unknown) =>
        error instanceof Error && error.name === "CimdFetchError" &&
        "reason" in error && error.reason === "metadata_resolution_failed",
    );
    assert.ok(fetched.includes(validClientId));
    assert.ok(fetched.includes(wrongClientId));
    assert.ok(fetched.every((url) => url === validClientId || url === wrongClientId));
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "Cloudflare");
    } else {
      Object.defineProperty(globalThis, "Cloudflare", previous);
    }
  }
});

void test("DCR register -> authorize (passphrase) -> token -> authenticated /mcp round trip", async () => {
  let authorizationSeenByContainer: string | null = null;
  const { env } = makeEnv((request) => {
    authorizationSeenByContainer = request.headers.get("authorization");
    return Promise.resolve(Response.json({ ok: true, via: "container" }, { status: 200 }));
  });
  const provider = buildOAuthProvider(subtle);
  const redirectUri = "https://client.example/callback";

  const registerResponse = await provider.fetch(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        application_type: "web",
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
  authorizeUrl.searchParams.set("resource", "https://groundlane.test/mcp");

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
  assert.equal(location.searchParams.get("iss"), "https://groundlane.test");
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
        resource: "https://groundlane.test/mcp",
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

  // The Container only understands GROUNDLANE_AUTH_TOKEN — the Worker must
  // substitute it, not forward the client's OAuth access token verbatim.
  assert.equal(authorizationSeenByContainer, `Bearer ${GROUNDLANE_AUTH_TOKEN}`);
  assert.notEqual(authorizationSeenByContainer, `Bearer ${token.access_token}`);
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

void test("an access token for another resource cannot call Groundlane MCP", async () => {
  let containerCalls = 0;
  const { env } = makeEnv(() => {
    containerCalls += 1;
    return Promise.resolve(new Response("unexpected"));
  });
  const provider = buildOAuthProvider(subtle);
  const redirectUri = "https://client.example/callback";
  const registered = await readJson<{ client_id: string }>(await provider.fetch(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        application_type: "web",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    ctx,
  ));
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64UrlEncode(await sha256(verifier));
  const authorizeUrl = new URL("https://groundlane.test/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", registered.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", "https://other.example/api");
  const approved = await provider.fetch(new Request(authorizeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ passphrase: OWNER_PASSPHRASE }),
  }), env, ctx);
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await readJson<{ access_token: string }>(await provider.fetch(
    new Request("https://groundlane.test/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: registered.client_id,
        code_verifier: verifier,
        resource: "https://other.example/api",
      }),
    }),
    env,
    ctx,
  ));
  const response = await provider.fetch(new Request("https://groundlane.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}` },
  }), env, ctx);
  assert.equal(response.status, 401);
  assert.equal(containerCalls, 0);
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
        application_type: "web",
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
