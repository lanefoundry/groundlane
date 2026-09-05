import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import {
  CONTAINER_INSTANCE_NAME,
  handleWorkerRequest,
  type WorkerEnv,
} from "../../src/worker/handler.js";
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

const ctx = createFakeExecutionContext();

function mockEnv(fetchImpl: (request: Request) => Promise<Response>): {
  env: WorkerEnv;
  names: string[];
  starts: string[];
} {
  const names: string[] = [];
  const starts: string[] = [];
  return {
    names,
    starts,
    env: {
      GROUNDLANE_AUTH_TOKEN: "test-secret",
      OAUTH_KV: createFakeKvNamespace(),
      OAUTH_OWNER_PASSPHRASE: "test-owner-passphrase-0123456789ab",
      GROUNDLANE_CONTAINER: {
        getByName(name) {
          names.push(name);
          return {
            start: () => {
              starts.push(name);
            },
            fetch: fetchImpl,
          };
        },
      },
    },
  };
}

void test("health endpoint is public and does not wake the container", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/healthz"),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.equal(names.length, 0);
  assert.equal(typeof response.headers.get("x-request-id"), "string");
});

void test("readiness endpoint requires static bearer auth before touching the container", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(Response.json({ status: "ready" })));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/readyz"),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="groundlane"');
  assert.deepEqual(await response.json(), {
    error: {
      code: "unauthorized",
      message: "A valid bearer token is required",
    },
    requestId: response.headers.get("x-request-id"),
  });
  assert.equal(names.length, 0);
});

void test("authenticated readiness endpoint proxies the container", async () => {
  let forwardedPath = "";
  const { env, names } = mockEnv((request) => {
    forwardedPath = new URL(request.url).pathname;
    return Promise.resolve(Response.json({ status: "ready" }));
  });
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/readyz", {
      headers: { authorization: "Bearer test-secret" },
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.equal(forwardedPath, "/readyz");
  assert.deepEqual(names, [CONTAINER_INSTANCE_NAME]);
});

void test("readiness endpoint starts an inactive named container before fetching", async () => {
  const { env, starts } = mockEnv(() => Promise.resolve(Response.json({ status: "ready" })));
  env.GROUNDLANE_CONTAINER = {
    getByName(name) {
      return {
        start: () => {
          starts.push(name);
        },
        fetch: () => Promise.resolve(Response.json({ status: "ready" })),
      };
    },
  };

  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/readyz", {
      headers: { authorization: "Bearer test-secret" },
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(starts, [CONTAINER_INSTANCE_NAME]);
});

void test("DCR register requires static bearer auth before reaching OAuth", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="groundlane"');
  assert.equal(names.length, 0);
});

void test("authenticated DCR register still reaches the OAuth provider", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/register", {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
        client_name: "Integration Test Client",
      }),
    }),
    env,
    subtle,
    ctx,
  );
  const body: { client_id?: string } = await response.json();

  assert.equal(response.status, 201);
  assert.ok(typeof body.client_id === "string" && body.client_id.length > 0);
  assert.equal(names.length, 0);
});

void test("OAuth metadata remains public for connector discovery", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/.well-known/oauth-authorization-server"),
    env,
    subtle,
    ctx,
  );
  const body: {
    authorization_endpoint?: string;
  } = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.authorization_endpoint, "https://groundlane.test/authorize");
  assert.equal(names.length, 0);
});

void test("MCP endpoint without any credentials falls through to the OAuth challenge", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST" }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /Bearer/u);
  assert.match(challenge, /resource_metadata=/u);
  assert.equal(names.length, 0);
});

void test("MCP endpoint falls through to the OAuth challenge when the legacy secret is unset", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  env.GROUNDLANE_AUTH_TOKEN = "";
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 401);
  assert.equal(names.length, 0);
});

void test("authenticated MCP requests route to the named container", async () => {
  let forwardedRequest: Request | undefined;
  const { env, names } = mockEnv((request) => {
    forwardedRequest = request;
    return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
  });
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
      body: "{}",
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(names, [CONTAINER_INSTANCE_NAME]);
  assert.equal(
    forwardedRequest?.headers.get("x-request-id"),
    response.headers.get("x-request-id"),
  );
});

void test("authenticated MCP requests start an inactive named container before proxying", async () => {
  const starts: string[] = [];
  const { env } = mockEnv(() => Promise.resolve(new Response()));
  env.GROUNDLANE_CONTAINER = {
    getByName(name) {
      return {
        start: () => {
          starts.push(name);
        },
        fetch: () => Promise.resolve(Response.json({ ok: true }, { status: 202 })),
      };
    },
  };

  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
      body: "{}",
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(starts, [CONTAINER_INSTANCE_NAME]);
});

void test("authenticated MCP requests await an asynchronous container start before proxying", async () => {
  let running = false;
  const { env } = mockEnv(() => Promise.resolve(new Response()));
  env.GROUNDLANE_CONTAINER = {
    getByName() {
      return {
        start: async () => {
          await Promise.resolve();
          running = true;
        },
        fetch: () => {
          if (!running) {
            throw new Error("The container is not running, consider calling start()");
          }
          return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
        },
      };
    },
  };

  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
      body: "{}",
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 202);
  assert.equal(running, true);
});

void test("container start failures return a structured gateway error without fetching", async () => {
  let fetched = false;
  const { env } = mockEnv(() => Promise.resolve(new Response()));
  env.GROUNDLANE_CONTAINER = {
    getByName() {
      return {
        start: () => Promise.reject(new Error("secret start detail")),
        fetch: () => {
          fetched = true;
          return Promise.resolve(new Response());
        },
      };
    },
  };

  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
      body: "{}",
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 502);
  assert.equal(fetched, false);
  assert.deepEqual(await response.json(), {
    error: {
      code: "container_unavailable",
      message: "The MCP runtime is unavailable",
    },
    requestId: response.headers.get("x-request-id"),
  });
});

void test("container failures return a structured gateway error", async () => {
  const { env } = mockEnv(() =>
    Promise.reject(new Error("secret internal detail")),
  );
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      code: "container_unavailable",
      message: "The MCP runtime is unavailable",
    },
    requestId: response.headers.get("x-request-id"),
  });
});

void test("unknown routes return a structured 404 without touching OAuth or the container", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/not-a-route"),
    env,
    subtle,
    ctx,
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { code: "not_found", message: "Route not found" },
    requestId: response.headers.get("x-request-id"),
  });
  assert.equal(names.length, 0);
});
