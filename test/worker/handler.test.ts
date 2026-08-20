import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import {
  CONTAINER_INSTANCE_NAME,
  handleWorkerRequest,
  type WorkerEnv,
} from "../../src/worker/handler.js";

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

function mockEnv(fetchImpl: (request: Request) => Promise<Response>): {
  env: WorkerEnv;
  names: string[];
} {
  const names: string[] = [];
  return {
    names,
    env: {
      GROUNDLANE_AUTH_TOKEN: "test-secret",
      GROUNDLANE_CONTAINER: {
        getByName(name) {
          names.push(name);
          return { fetch: fetchImpl };
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
  );

  assert.equal(response.status, 200);
  assert.equal(names.length, 0);
  assert.equal(typeof response.headers.get("x-request-id"), "string");
});

void test("readiness endpoint proxies the container without requiring MCP auth", async () => {
  let forwardedPath = "";
  const { env, names } = mockEnv((request) => {
    forwardedPath = new URL(request.url).pathname;
    return Promise.resolve(Response.json({ status: "ready" }));
  });
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/readyz"),
    env,
    subtle,
  );

  assert.equal(response.status, 200);
  assert.equal(forwardedPath, "/readyz");
  assert.deepEqual(names, [CONTAINER_INSTANCE_NAME]);
});

void test("MCP endpoint rejects missing credentials", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST" }),
    env,
    subtle,
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="groundlane"');
  assert.equal(names.length, 0);
});

void test("MCP endpoint fails closed when the Worker secret is missing", async () => {
  const { env, names } = mockEnv(() => Promise.resolve(new Response()));
  env.GROUNDLANE_AUTH_TOKEN = "";
  const response = await handleWorkerRequest(
    new Request("https://groundlane.test/mcp", { method: "POST" }),
    env,
    subtle,
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
  );

  assert.equal(response.status, 202);
  assert.deepEqual(names, [CONTAINER_INSTANCE_NAME]);
  assert.equal(
    forwardedRequest?.headers.get("x-request-id"),
    response.headers.get("x-request-id"),
  );
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
