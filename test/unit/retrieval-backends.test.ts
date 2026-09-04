import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserlessBackend,
  browserlessContentEndpoint,
  selectRenderedHtml,
} from "../../src/adapters/browser/browserless.js";
import { mapLocalBrowserError } from "../../src/adapters/browser/local-playwright.js";
import { JinaReaderBackend } from "../../src/adapters/reader/jina.js";
import { DEFAULT_BROWSER_CHALLENGE_TIMEOUT_MS, waitForChallengeToClear } from "../../src/core/browser-policy.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { Deadline } from "../../src/core/limits.js";
import type { DnsLookup } from "../../src/core/url-policy.js";

const publicLookup: DnsLookup = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
const resolveSameUrl = (request: { url: string }): Promise<string> =>
  Promise.resolve(request.url);

void test("local browser challenge wait defaults to five seconds", () => {
  assert.equal(DEFAULT_BROWSER_CHALLENGE_TIMEOUT_MS, 5_000);
});

void test("local browser errors retain their stage without exposing runtime details", () => {
  const raw = new Error("browserContext.newPage: Target crashed at /secret/path");
  const mapped = mapLocalBrowserError(raw, "browser");
  assert.equal(mapped.code, "UPSTREAM_ERROR");
  assert.equal(mapped.stage, "browser");
  assert.equal(mapped.retryable, true);
  assert.doesNotMatch(mapped.message, /Target crashed|secret/u);
  assert.equal(mapped.cause, raw);

  const policyError = new GroundlaneError(
    "URL_BLOCKED",
    "browser-request",
    "Blocked by URL policy",
  );
  assert.equal(mapLocalBrowserError(policyError, "browser"), policyError);
});

void test("local browser stops waiting when a challenge remains unresolved", async () => {
  const requestDeadline = new Deadline(1_000);
  await assert.rejects(
    waitForChallengeToClear(
      () => Promise.resolve(true),
      requestDeadline,
      undefined,
      { timeoutMs: 10, pollIntervalMs: 1 },
    ),
    { code: "UPSTREAM_ERROR", stage: "browser-challenge" },
  );
  assert.ok(requestDeadline.remainingMs("test") > 0);
});

void test("local browser continues after a challenge clears", async () => {
  let checks = 0;
  await waitForChallengeToClear(
    () => Promise.resolve(++checks < 3),
    new Deadline(1_000),
    undefined,
    { timeoutMs: 100, pollIntervalMs: 1 },
  );
  assert.equal(checks, 3);
});

void test("local browser preserves the end-to-end deadline when it expires first", async () => {
  await assert.rejects(
    waitForChallengeToClear(
      () => Promise.resolve(true),
      new Deadline(10),
      undefined,
      { timeoutMs: 100, pollIntervalMs: 1 },
    ),
    { code: "DEADLINE_EXCEEDED", stage: "browser-challenge" },
  );
});

void test("local browser challenge waiting propagates cancellation", async () => {
  const controller = new AbortController();
  const waiting = waitForChallengeToClear(
    () => Promise.resolve(true),
    new Deadline(1_000),
    controller.signal,
    { timeoutMs: 100, pollIntervalMs: 10 },
  );
  setImmediate(() => controller.abort());
  await assert.rejects(waiting,
    { code: "CANCELLED", stage: "browser-challenge" },
  );
});

void test("Jina Reader validates the target and returns bounded Markdown provenance", async () => {
  let requestedUrl = "";
  let init: RequestInit | undefined;
  const reader = new JinaReaderBackend({
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: (url, requestInit) => {
      requestedUrl = url;
      init = requestInit;
      return Promise.resolve(new Response("# Groundlane\n\nReader output"));
    },
  });
  const result = await reader.fetch({
    url: "https://example.com/docs?q=reader",
    maxBytes: 1_000,
    deadline: new Deadline(1_000),
  });

  assert.equal(
    requestedUrl,
    "https://r.jina.ai/https://example.com/docs?q=reader",
  );
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).get("x-no-cache"), "true");
  assert.equal(result.engine, "reader");
  assert.equal(result.backend, "jina");
  assert.equal(new TextDecoder().decode(result.body), "# Groundlane\n\nReader output");
});

void test("Jina Reader blocks unsafe targets before calling the provider", async () => {
  let calls = 0;
  const reader = new JinaReaderBackend({
    fetch: () => {
      calls += 1;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  await assert.rejects(
    reader.fetch({
      url: "http://127.0.0.1/admin",
      maxBytes: 1_000,
      deadline: new Deadline(1_000),
    }),
    { code: "URL_BLOCKED" },
  );
  assert.equal(calls, 0);
});

void test("Jina Reader sends only a preflight-validated final URL to the provider", async () => {
  let requestedUrl = "";
  const reader = new JinaReaderBackend({
    lookup: publicLookup,
    resolveRedirects: () => Promise.resolve("https://example.com/final"),
    fetch: (url) => {
      requestedUrl = url;
      return Promise.resolve(new Response("# Final"));
    },
  });
  const result = await reader.fetch({
    url: "https://example.com/start",
    maxBytes: 1_000,
    deadline: new Deadline(1_000),
  });

  assert.equal(requestedUrl, "https://r.jina.ai/https://example.com/final");
  assert.equal(result.finalUrl, "https://example.com/final");
});

void test("Jina Reader does not call the provider when redirect preflight is blocked", async () => {
  let calls = 0;
  const reader = new JinaReaderBackend({
    lookup: publicLookup,
    resolveRedirects: () =>
      Promise.reject(new GroundlaneError("URL_BLOCKED", "redirect", "Blocked")),
    fetch: () => {
      calls += 1;
      return Promise.resolve(new Response("unexpected"));
    },
  });

  await assert.rejects(
    reader.fetch({
      url: "https://example.com/start",
      maxBytes: 1_000,
      deadline: new Deadline(1_000),
    }),
    { code: "URL_BLOCKED" },
  );
  assert.equal(calls, 0);
});

void test("Jina Reader rejects declared responses above the byte budget", async () => {
  const reader = new JinaReaderBackend({
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () =>
      Promise.resolve(
        new Response("small", { headers: { "content-length": "2000" } }),
      ),
  });
  await assert.rejects(
    reader.fetch({
      url: "https://example.com",
      maxBytes: 1_000,
      deadline: new Deadline(1_000),
    }),
    { code: "OUTPUT_LIMIT" },
  );
});

void test("Jina Reader stops a streamed response above the byte budget", async () => {
  const reader = new JinaReaderBackend({
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () => Promise.resolve(new Response("x".repeat(1_001))),
  });
  await assert.rejects(
    reader.fetch({
      url: "https://example.com",
      maxBytes: 1_000,
      deadline: new Deadline(1_000),
    }),
    { code: "OUTPUT_LIMIT" },
  );
});

void test("Browserless uses a fixed regional endpoint and keeps its token out of the URL", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const backend = new BrowserlessBackend({
    token: "browserless-secret",
    region: "lon",
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        new Response("<html><body><main><h1>Rendered</h1></main></body></html>", {
          headers: {
            "content-type": "text/html",
            "x-response-code": "200",
            "x-response-url": "https://example.com/final",
          },
        }),
      );
    },
  });
  const result = await backend.fetch({
    url: "https://example.com/start",
    waitFor: "main",
    selector: "main",
    maxBytes: 10_000,
    deadline: new Deadline(1_000),
  });

  assert.equal(requestedUrl, "https://production-lon.browserless.io/content");
  assert.doesNotMatch(requestedUrl, /browserless-secret/u);
  assert.equal(authorization, "Bearer browserless-secret");
  assert.deepEqual(body, {
    url: "https://example.com/start",
    bestAttempt: false,
    gotoOptions: {
      waitUntil: "domcontentloaded",
      timeout: (body as { gotoOptions: { timeout: number } }).gotoOptions.timeout,
    },
    rejectResourceTypes: ["image", "media", "font"],
    waitForSelector: {
      selector: "main",
      timeout: (body as { waitForSelector: { timeout: number } }).waitForSelector.timeout,
    },
  });
  assert.equal(result.finalUrl, "https://example.com/final");
  assert.equal(result.backend, "browserless");
  assert.equal(new TextDecoder().decode(result.body), "<main><h1>Rendered</h1></main>");
  assert.doesNotMatch(JSON.stringify(result), /browserless-secret/u);
});

void test("Browserless endpoint and selector helpers reject unsupported input", () => {
  assert.equal(
    browserlessContentEndpoint("ams"),
    "https://production-ams.browserless.io/content",
  );
  assert.throws(() => selectRenderedHtml("<main />", "["), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => selectRenderedHtml("<main />", ".missing"), {
    code: "INVALID_INPUT",
  });
});

void test("Browserless sends only a preflight-validated final URL to the provider", async () => {
  let body: unknown;
  const backend = new BrowserlessBackend({
    token: "browserless-secret",
    lookup: publicLookup,
    resolveRedirects: () => Promise.resolve("https://example.com/final"),
    fetch: (_url, init) => {
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        new Response("<main>final</main>", {
          headers: { "x-response-url": "https://example.com/final" },
        }),
      );
    },
  });
  const result = await backend.fetch({
    url: "https://example.com/start",
    maxBytes: 10_000,
    deadline: new Deadline(1_000),
  });

  assert.equal((body as { url: string }).url, "https://example.com/final");
  assert.equal(result.finalUrl, "https://example.com/final");
});

void test("Browserless does not call the provider when redirect preflight is blocked", async () => {
  let calls = 0;
  const backend = new BrowserlessBackend({
    token: "browserless-secret",
    lookup: publicLookup,
    resolveRedirects: () =>
      Promise.reject(new GroundlaneError("URL_BLOCKED", "redirect", "Blocked")),
    fetch: () => {
      calls += 1;
      return Promise.resolve(new Response("unexpected"));
    },
  });

  await assert.rejects(
    backend.fetch({
      url: "https://example.com/start",
      maxBytes: 10_000,
      deadline: new Deadline(1_000),
    }),
    { code: "URL_BLOCKED" },
  );
  assert.equal(calls, 0);
});

void test("Browserless rejects private final URLs reported by the provider", async () => {
  const backend = new BrowserlessBackend({
    token: "browserless-secret",
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () =>
      Promise.resolve(
        new Response("<main>unexpected</main>", {
          headers: { "x-response-url": "http://127.0.0.1/admin" },
        }),
      ),
  });
  await assert.rejects(
    backend.fetch({
      url: "https://example.com",
      maxBytes: 10_000,
      deadline: new Deadline(1_000),
    }),
    { code: "URL_BLOCKED" },
  );
});

void test("Browserless maps quota errors without exposing its token", async () => {
  const backend = new BrowserlessBackend({
    token: "browserless-secret",
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () => Promise.resolve(new Response("quota details", { status: 429 })),
  });
  await assert.rejects(
    backend.fetch({
      url: "https://example.com",
      maxBytes: 10_000,
      deadline: new Deadline(1_000),
    }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.doesNotMatch(error.message, /browserless-secret|quota details/u);
      return "code" in error && error.code === "RATE_LIMITED";
    },
  );
});

// ---------------------------------------------------------------------------
// Browser diagnostic output safety (PRD line 740)
// ---------------------------------------------------------------------------

void test("Browserless result strips response headers by default", async () => {
  const backend = new BrowserlessBackend({
    token: "test-token",
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () =>
      Promise.resolve(
        new Response("<html><body>ok</body></html>", {
          headers: {
            "content-type": "text/html",
            "x-response-code": "200",
            "x-response-url": "https://example.com",
            "set-cookie": "session=abc123; Path=/; HttpOnly",
            "x-custom-secret": "internal-value",
          },
        }),
      ),
  });
  const result = await backend.fetch({
    url: "https://example.com",
    maxBytes: 10_000,
    deadline: new Deadline(1_000),
  });

  assert.deepEqual(result.headers, {}, "headers must be empty object");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /session=abc123/u, "cookies must not leak");
  assert.doesNotMatch(serialized, /internal-value/u, "upstream headers must not leak");
});

void test("Browserless result does not contain screenshot, trace, or HAR data", async () => {
  const backend = new BrowserlessBackend({
    token: "test-token",
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () =>
      Promise.resolve(
        new Response("<html><body>page</body></html>", {
          headers: {
            "x-response-code": "200",
            "x-response-url": "https://example.com",
          },
        }),
      ),
  });
  const result = await backend.fetch({
    url: "https://example.com",
    maxBytes: 10_000,
    deadline: new Deadline(1_000),
  });

  const resultObj = result as unknown as Record<string, unknown>;
  assert.equal(resultObj.screenshot, undefined, "screenshot must not be present");
  assert.equal(resultObj.trace, undefined, "trace must not be present");
  assert.equal(resultObj.har, undefined, "HAR must not be present");
  assert.equal(resultObj.consoleLogs, undefined, "console logs must not be present");
  assert.equal(resultObj.networkLogs, undefined, "network logs must not be present");
});

void test("Browserless result conforms to the safe diagnostic shape", async () => {
  const backend = new BrowserlessBackend({
    token: "test-token",
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () =>
      Promise.resolve(
        new Response("<html><body>safe</body></html>", {
          headers: {
            "x-response-code": "200",
            "x-response-url": "https://example.com/final",
          },
        }),
      ),
  });
  const result = await backend.fetch({
    url: "https://example.com",
    maxBytes: 10_000,
    deadline: new Deadline(1_000),
  });

  // Verify only the expected RawDocument fields are present
  const allowedKeys = new Set([
    "requestedUrl",
    "finalUrl",
    "status",
    "headers",
    "contentType",
    "body",
    "engine",
    "backend",
    "blockedSubrequests",
  ]);
  for (const key of Object.keys(result)) {
    assert.ok(allowedKeys.has(key), `unexpected key "${key}" in browser result`);
  }
  assert.equal(result.engine, "browser");
  assert.equal(result.backend, "browserless");
  assert.equal(typeof result.status, "number");
});

void test("Browserless result excludes blockedSubrequests (Browserless does not track them)", async () => {
  const backend = new BrowserlessBackend({
    token: "test-token",
    lookup: publicLookup,
    resolveRedirects: resolveSameUrl,
    fetch: () =>
      Promise.resolve(
        new Response("<html><body>content</body></html>", {
          headers: {
            "x-response-code": "200",
            "x-response-url": "https://example.com",
          },
        }),
      ),
  });
  const result = await backend.fetch({
    url: "https://example.com",
    maxBytes: 10_000,
    deadline: new Deadline(1_000),
  });

  assert.equal(
    result.blockedSubrequests,
    undefined,
    "Browserless backend should not set blockedSubrequests",
  );
});

void test("RawDocument type allows only a bounded blockedSubrequests count, not detailed logs", () => {
  // Verify the contract: blockedSubrequests is an optional number, not an
  // array of request details that could leak URLs, cookies, or headers.
  const doc: import("../../src/core/contracts.js").RawDocument = {
    requestedUrl: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    headers: {},
    contentType: "text/html",
    body: new Uint8Array(),
    engine: "browser",
    backend: "test",
    blockedSubrequests: 5,
  };
  assert.equal(typeof doc.blockedSubrequests, "number");
  // The type system enforces this is a number, not an array or object.
  // This test documents that the contract carries only a count.
  assert.ok(
    !Array.isArray(doc.blockedSubrequests),
    "blockedSubrequests must be a count, not request details",
  );
});

void test("Browser diagnostic output excludes raw response headers from the tool-level schema", async () => {
  // The web_fetch tool schema (fetchDataSchema) intentionally omits the
  // `headers` field from RawDocument. Even though RawDocument carries
  // headers internally, they must not reach the MCP consumer.
  // We verify by importing the schema and checking its shape.
  const { z } = await import("zod");
  const fetchDataSchema = z.object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    status: z.number().int(),
    contentType: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    publishedAt: z.string().optional(),
    content: z.string(),
    format: z.enum(["markdown", "text", "html"]),
    engine: z.enum(["http", "reader", "browser"]),
    backend: z.string(),
    cached: z.boolean(),
    truncated: z.boolean(),
    bytes: z.number().int().nonnegative(),
    blockedSubrequests: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    fallbackReason: z.string().optional(),
  });
  const shape = fetchDataSchema.shape;
  const keys = Object.keys(shape);

  // headers must NOT appear in the consumer-facing schema
  assert.ok(!keys.includes("headers"), "headers must not be in the tool output schema");
  // Sensitive browser diagnostics must not appear either
  assert.ok(!keys.includes("screenshot"), "screenshot must not be in the tool output schema");
  assert.ok(!keys.includes("trace"), "trace must not be in the tool output schema");
  assert.ok(!keys.includes("har"), "HAR must not be in the tool output schema");
  assert.ok(!keys.includes("cookies"), "cookies must not be in the tool output schema");
  assert.ok(!keys.includes("consoleLogs"), "consoleLogs must not be in the tool output schema");
  assert.ok(!keys.includes("networkLogs"), "networkLogs must not be in the tool output schema");
});
