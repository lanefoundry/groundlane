import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserBackend, BrowserFetchRequest, HttpFetcher, HttpFetchRequest, RawDocument, ReaderBackend } from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { FetchPipeline, validateFetchPipelineRequest } from "../../src/core/fetch-pipeline.js";
import { Deadline } from "../../src/core/limits.js";

function raw(body: string, engine: "http" | "reader" | "browser" = "http", status = 200): RawDocument {
  return { requestedUrl: "https://example.com", finalUrl: "https://example.com", status, headers: {}, contentType: engine === "reader" ? "text/markdown" : "text/html", body: new TextEncoder().encode(body), engine, backend: engine === "http" ? "direct" : engine };
}

void test("FetchPipeline uses HTTP without browser fallback for ordinary errors", async () => {
  let browserCalls = 0;
  const http: HttpFetcher = { fetch: (request: HttpFetchRequest) => { void request; return Promise.resolve(raw("<h1>Not found</h1>", "http", 404)); } };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: (request: BrowserFetchRequest) => { void request; browserCalls += 1; return Promise.resolve(raw("browser", "browser")); } };
  const result = await new FetchPipeline(http, browser).fetch({ url: "https://example.com", format: "text", render: "auto", maxBytes: 1_000, maxOutputChars: 1_000, maxRedirects: 3, deadline: new Deadline(1_000) });
  assert.equal(result.raw.status, 404); assert.equal(browserCalls, 0);
});

void test("FetchPipeline browser fallback consumes the original Deadline", async () => {
  let sameDeadline = false; const deadline = new Deadline(1_000);
  const http: HttpFetcher = { fetch: (request) => { sameDeadline = request.deadline === deadline; return Promise.resolve(raw("<html><script>render()</script></html>")); } };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: (request) => { sameDeadline &&= request.deadline === deadline; return Promise.resolve(raw("<main>Rendered content is now sufficiently long for this test.</main>", "browser")); } };
  const result = await new FetchPipeline(http, browser).fetch({ url: "https://example.com", format: "text", render: "auto", maxBytes: 1_000, maxOutputChars: 1_000, maxRedirects: 3, deadline });
  assert.equal(result.raw.engine, "browser"); assert.equal(result.fallbackReason, "js_empty_document"); assert.equal(sameDeadline, true);
});

void test("FetchPipeline render never surfaces an unmet selector without browser retry", async () => {
  const http: HttpFetcher = { fetch: () => Promise.resolve(raw("<main>content</main>")) };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  await assert.rejects(new FetchPipeline(http, browser).fetch({ url: "https://example.com", format: "text", render: "never", selector: ".missing", maxBytes: 1_000, maxOutputChars: 1_000, maxRedirects: 3, deadline: new Deadline(1_000) }), { stage: "selector" });
});

void test("FetchPipeline prefers Jina Reader before browser for Markdown fallback", async () => {
  let readerCalls = 0;
  let browserCalls = 0;
  const deadline = new Deadline(1_000);
  const http: HttpFetcher = { fetch: () => Promise.resolve(raw("<html><script>render()</script></html>")) };
  const browser: BrowserBackend = {
    ready: () => Promise.resolve(true),
    fetch: () => {
      browserCalls += 1;
      return Promise.resolve(raw("browser", "browser"));
    },
  };
  const reader: ReaderBackend = {
    ready: () => Promise.resolve(true),
    fetch: (request) => {
      readerCalls += 1;
      assert.equal(request.deadline, deadline);
      return Promise.resolve(raw("# Reader result", "reader"));
    },
  };
  const result = await new FetchPipeline(http, browser, reader).fetch({
    url: "https://example.com",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline,
  });
  assert.equal(result.raw.engine, "reader");
  assert.equal(readerCalls, 1);
  assert.equal(browserCalls, 0);
  assert.equal(result.fallbackReason, "js_empty_document");
});

void test("FetchPipeline skips Reader when the caller needs HTML", async () => {
  let readerCalls = 0;
  let browserCalls = 0;
  const http: HttpFetcher = { fetch: () => Promise.resolve(raw("<html><script>render()</script></html>")) };
  const browser: BrowserBackend = {
    ready: () => Promise.resolve(true),
    fetch: () => {
      browserCalls += 1;
      return Promise.resolve(raw("<main>Browser result</main>", "browser"));
    },
  };
  const reader: ReaderBackend = {
    ready: () => Promise.resolve(true),
    fetch: () => {
      readerCalls += 1;
      return Promise.resolve(raw("# Reader result", "reader"));
    },
  };
  const result = await new FetchPipeline(http, browser, reader).fetch({
    url: "https://example.com",
    format: "html",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });
  assert.equal(result.raw.engine, "browser");
  assert.equal(readerCalls, 0);
  assert.equal(browserCalls, 1);
});

void test("FetchPipeline falls through from a retryable Reader failure to browser", async () => {
  let browserCalls = 0;
  const http: HttpFetcher = {
    fetch: () =>
      Promise.reject(
        new GroundlaneError("UPSTREAM_ERROR", "connect", "failed", true),
      ),
  };
  const reader: ReaderBackend = {
    ready: () => Promise.resolve(true),
    fetch: () =>
      Promise.reject(
        new GroundlaneError("RATE_LIMITED", "reader", "limited", true),
      ),
  };
  const browser: BrowserBackend = {
    ready: () => Promise.resolve(true),
    fetch: () => {
      browserCalls += 1;
      return Promise.resolve(raw("<main>Browser result</main>", "browser"));
    },
  };
  const result = await new FetchPipeline(http, browser, reader).fetch({
    url: "https://example.com",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });
  assert.equal(result.raw.engine, "browser");
  assert.equal(result.fallbackReason, "http_upstream_failure");
  assert.equal(browserCalls, 1);
});

void test("validateFetchPipelineRequest enforces byte, output, redirect and selector bounds", () => {
  const base = { url: "https://example.com", format: "text" as const, render: "never" as const, maxBytes: 1_000, maxOutputChars: 1_000, maxRedirects: 3, deadline: new Deadline(1_000) };
  assert.doesNotThrow(() => validateFetchPipelineRequest(base));
  assert.throws(() => validateFetchPipelineRequest({ ...base, maxBytes: 0 }), { code: "INVALID_INPUT" });
  assert.throws(() => validateFetchPipelineRequest({ ...base, maxRedirects: 21 }), { code: "INVALID_INPUT" });
  assert.throws(() => validateFetchPipelineRequest({ ...base, selector: " " }), { code: "INVALID_INPUT" });
});
