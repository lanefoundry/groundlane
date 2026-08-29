import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserlessBackend,
  browserlessContentEndpoint,
  selectRenderedHtml,
} from "../../src/adapters/browser/browserless.js";
import { mapLocalBrowserError } from "../../src/adapters/browser/local-playwright.js";
import { JinaReaderBackend } from "../../src/adapters/reader/jina.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { Deadline } from "../../src/core/limits.js";
import type { DnsLookup } from "../../src/core/url-policy.js";

const publicLookup: DnsLookup = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
const resolveSameUrl = (request: { url: string }): Promise<string> =>
  Promise.resolve(request.url);

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
