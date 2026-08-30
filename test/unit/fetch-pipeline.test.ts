import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserBackend, BrowserFetchRequest, HttpFetcher, HttpFetchRequest, RawDocument, ReaderBackend } from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { FetchPipeline, validateFetchPipelineRequest } from "../../src/core/fetch-pipeline.js";
import { Deadline } from "../../src/core/limits.js";
import { SourceAwareDocsResolver } from "../../src/core/source-aware-docs.js";

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

void test("FetchPipeline classifies a raw HTTP challenge before browser fallback", async () => {
  for (const source of [
    '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/challenge.js"></script></head><body></body></html>',
    "<html><head><script></script></head><body>Checking your browser before accessing this site.</body></html>",
  ]) {
    const http: HttpFetcher = {
      fetch: () => Promise.resolve({
        requestedUrl: "https://example.com/docs",
        finalUrl: "https://example.com/docs",
        status: 403,
        headers: {},
        contentType: "text/html",
        body: new TextEncoder().encode(source),
        engine: "http",
        backend: "direct",
      }),
    };
    const browser: BrowserBackend = {
      ready: () => Promise.resolve(true),
      fetch: () => Promise.resolve(raw("<main>Rendered documentation content.</main>", "browser")),
    };

    const result = await new FetchPipeline(http, browser).fetch({
      url: "https://example.com/docs",
      format: "markdown",
      render: "auto",
      maxBytes: 10_000,
      maxOutputChars: 10_000,
      maxRedirects: 3,
      deadline: new Deadline(1_000),
    });

    assert.equal(result.raw.engine, "browser");
    assert.equal(result.fallbackReason, "challenge_response");
  }
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

void test("FetchPipeline proactively uses source-aware Markdown for documentation URLs", async () => {
  const requested: string[] = [];
  const http: HttpFetcher = {
    fetch: (request) => {
      requested.push(`${request.url} ${request.headers?.accept ?? ""}`.trim());
      assert.equal(request.url, "https://developers.cloudflare.com/api/resources/accounts/methods/list/");
      assert.equal(request.headers?.accept, "text/markdown,text/plain;q=0.9,*/*;q=0.1");
      return Promise.resolve({
        requestedUrl: request.url,
        finalUrl: request.url,
        status: 200,
        headers: {},
        contentType: "text/markdown",
        body: new TextEncoder().encode("---\ntitle: List Accounts\n---\n\n[Skip to content](#_top)\n\n# List Accounts\n\nUseful API docs."),
        engine: "http",
        backend: "direct",
      });
    },
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  const result = await new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
    url: "https://developers.cloudflare.com/api/resources/accounts/methods/list/",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });

  assert.deepEqual(requested, ["https://developers.cloudflare.com/api/resources/accounts/methods/list/ text/markdown,text/plain;q=0.9,*/*;q=0.1"]);
  assert.equal(result.raw.backend, "source:accept-markdown");
  assert.equal(result.fallbackReason, "source_aware_markdown");
  assert.match(result.content, /List Accounts/u);
  assert.doesNotMatch(result.content, /Skip to content|title:/u);
});

void test("FetchPipeline does not proactively use source-aware docs for ordinary URLs", async () => {
  const requested: string[] = [];
  const http: HttpFetcher = {
    fetch: (request) => {
      requested.push(request.url);
      return Promise.resolve(raw("<main>Ordinary page content that should use the normal HTTP path.</main>"));
    },
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  const result = await new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
    url: "https://example.com/products",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });

  assert.deepEqual(requested, ["https://example.com/products"]);
  assert.equal(result.raw.backend, "direct");
});

void test("FetchPipeline does not treat a machine JSON API as documentation", async () => {
  const requested: Array<{ url: string; accept?: string }> = [];
  const apiUrl = "https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/confident-ai%2Fdeepeval";
  const http: HttpFetcher = {
    fetch: (request) => {
      requested.push({
        url: request.url,
        ...(request.headers?.accept === undefined ? {} : { accept: request.headers.accept }),
      });
      return Promise.resolve({
        requestedUrl: request.url,
        finalUrl: request.url,
        status: 200,
        headers: {},
        contentType: "application/json",
        body: new TextEncoder().encode('{"full_name":"confident-ai/deepeval"}'),
        engine: "http",
        backend: "direct",
      });
    },
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(false), fetch: () => Promise.reject(new Error("must not run")) };
  const result = await new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
    url: apiUrl,
    format: "text",
    render: "never",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });

  assert.deepEqual(requested, [{ url: apiUrl }]);
  assert.match(result.content, /confident-ai\/deepeval/u);
});

void test("FetchPipeline preserves terminal source-aware errors", async () => {
  for (const reason of [
    new GroundlaneError("DEADLINE_EXCEEDED", "response", "deadline", true),
    new GroundlaneError("CANCELLED", "response", "cancelled"),
  ]) {
    let calls = 0;
    const http: HttpFetcher = {
      fetch: () => {
        calls += 1;
        return Promise.reject(reason);
      },
    };
    const browser: BrowserBackend = { ready: () => Promise.resolve(false), fetch: () => Promise.reject(new Error("must not run")) };

    await assert.rejects(
      new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
        url: "https://docs.example.com/reference/search",
        format: "text",
        render: "never",
        maxBytes: 1_000,
        maxOutputChars: 1_000,
        maxRedirects: 3,
        deadline: new Deadline(1_000),
      }),
      (error) => error === reason,
    );
    assert.equal(calls, 1, reason.code);
  }
});

void test("FetchPipeline rejects proactive source candidates that return HTML", async () => {
  const requested: string[] = [];
  const http: HttpFetcher = {
    fetch: (request) => {
      requested.push(request.url);
      if (request.headers?.accept === "text/markdown,text/plain;q=0.9,*/*;q=0.1") {
        return Promise.resolve({
          requestedUrl: request.url,
          finalUrl: request.url,
          status: 200,
          headers: {},
          contentType: "text/html",
          body: new TextEncoder().encode("<html><body>Not markdown</body></html>"),
          engine: "http",
          backend: "direct",
        });
      }
      return Promise.resolve(raw("<main>Fallback direct HTML content.</main>"));
    },
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  const result = await new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
    url: "https://developers.cloudflare.com/api/resources/accounts/",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });

  assert.deepEqual(requested, [
    "https://developers.cloudflare.com/api/resources/accounts/",
    "https://developers.cloudflare.com/api/resources/accounts/index.md",
    "https://developers.cloudflare.com/api/resources/accounts/",
  ]);
  assert.equal(result.raw.backend, "direct");
  assert.match(result.content, /Fallback direct HTML content/u);
});

void test("FetchPipeline uses source-aware Markdown when broad HTML exceeds byte limit", async () => {
  const requested: string[] = [];
  const deadline = new Deadline(1_000);
  const http: HttpFetcher = {
    fetch: (request) => {
      requested.push(request.url);
      if (request.url === "https://developers.cloudflare.com/api/resources/accounts/") {
        if (request.headers?.accept === "text/markdown,text/plain;q=0.9,*/*;q=0.1") {
          return Promise.resolve({
            requestedUrl: request.url,
            finalUrl: request.url,
            status: 200,
            headers: {},
            contentType: "text/markdown",
            body: new TextEncoder().encode("# Accounts API\n\nMarkdown source."),
            engine: "http",
            backend: "direct",
          });
        }
        return Promise.reject(new GroundlaneError("OUTPUT_LIMIT", "response", "too large"));
      }
      return Promise.reject(new Error("unexpected URL"));
    },
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  const result = await new FetchPipeline(
    http,
    browser,
    undefined,
    undefined,
    new SourceAwareDocsResolver(http),
  ).fetch({
    url: "https://developers.cloudflare.com/api/resources/accounts/",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline,
  });

  assert.deepEqual(requested, [
    "https://developers.cloudflare.com/api/resources/accounts/",
  ]);
  assert.equal(result.raw.backend, "source:accept-markdown");
  assert.equal(result.raw.requestedUrl, "https://developers.cloudflare.com/api/resources/accounts/");
  assert.equal(result.fallbackReason, "source_aware_markdown");
  assert.match(result.content, /Accounts API/u);
});

void test("FetchPipeline falls back to index markdown when content negotiation is unavailable", async () => {
  const requested: string[] = [];
  const http: HttpFetcher = {
    fetch: (request) => {
      requested.push(request.url);
      if (request.url === "https://developers.cloudflare.com/api/resources/accounts/") {
        if (request.headers?.accept === "text/markdown,text/plain;q=0.9,*/*;q=0.1") {
          return Promise.resolve(raw("Not found", "http", 404));
        }
        return Promise.reject(new GroundlaneError("OUTPUT_LIMIT", "response", "too large"));
      }
      assert.equal(request.url, "https://developers.cloudflare.com/api/resources/accounts/index.md");
      return Promise.resolve({
        requestedUrl: request.url,
        finalUrl: request.url,
        status: 200,
        headers: {},
        contentType: "text/markdown",
        body: new TextEncoder().encode("# Index Markdown"),
        engine: "http",
        backend: "direct",
      });
    },
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  const result = await new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
    url: "https://developers.cloudflare.com/api/resources/accounts/",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });

  assert.deepEqual(requested, [
    "https://developers.cloudflare.com/api/resources/accounts/",
    "https://developers.cloudflare.com/api/resources/accounts/index.md",
  ]);
  assert.equal(result.raw.backend, "source:index.md");
  assert.match(result.content, /Index Markdown/u);
});

void test("FetchPipeline does not use source-aware docs for selectors", async () => {
  const http: HttpFetcher = {
    fetch: () => Promise.reject(new GroundlaneError("OUTPUT_LIMIT", "response", "too large")),
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  await assert.rejects(
    new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
      url: "https://developers.cloudflare.com/api/resources/accounts/",
      format: "markdown",
      render: "auto",
      selector: "main",
      maxBytes: 1_000,
      maxOutputChars: 1_000,
      maxRedirects: 3,
      deadline: new Deadline(1_000),
    }),
    { code: "OUTPUT_LIMIT" },
  );
});

void test("FetchPipeline resolves Markdown through scoped llms.txt when direct candidates fail", async () => {
  const requested: string[] = [];
  const http: HttpFetcher = {
    fetch: (request) => {
      requested.push(request.url);
      if (request.url === "https://developers.cloudflare.com/api/resources/accounts/methods/list/") {
        return Promise.reject(new GroundlaneError("OUTPUT_LIMIT", "response", "too large"));
      }
      if (request.url === "https://developers.cloudflare.com/api/resources/accounts/methods/list/index.md") {
        return Promise.resolve(raw("Not found", "http", 404));
      }
      if (request.url === "https://developers.cloudflare.com/api/llms.txt") {
        return Promise.resolve({
          requestedUrl: request.url,
          finalUrl: request.url,
          status: 200,
          headers: {},
          contentType: "text/plain",
          body: new TextEncoder().encode("# Cloudflare API\n\n## API Reference\n\n- [Accounts](/api/resources/accounts/index.md)\n- [DNS](/api/resources/dns/index.md)\n"),
          engine: "http",
          backend: "direct",
        });
      }
      if (request.url === "https://developers.cloudflare.com/api/resources/accounts/index.md") {
        return Promise.resolve({
          requestedUrl: request.url,
          finalUrl: request.url,
          status: 200,
          headers: {},
          contentType: "text/markdown",
          body: new TextEncoder().encode("# Accounts\n\nAccount API overview."),
          engine: "http",
          backend: "direct",
        });
      }
      return Promise.reject(new Error(`unexpected URL ${request.url}`));
    },
  };
  const browser: BrowserBackend = { ready: () => Promise.resolve(true), fetch: () => Promise.reject(new Error("must not run")) };
  const result = await new FetchPipeline(http, browser, undefined, undefined, new SourceAwareDocsResolver(http)).fetch({
    url: "https://developers.cloudflare.com/api/resources/accounts/methods/list/",
    format: "markdown",
    render: "auto",
    maxBytes: 1_000,
    maxOutputChars: 1_000,
    maxRedirects: 3,
    deadline: new Deadline(1_000),
  });

  assert.deepEqual(requested, [
    "https://developers.cloudflare.com/api/resources/accounts/methods/list/",
    "https://developers.cloudflare.com/api/resources/accounts/methods/list/index.md",
    "https://developers.cloudflare.com/api/resources/accounts/methods/list/",
    "https://developers.cloudflare.com/api/llms.txt",
    "https://developers.cloudflare.com/api/resources/accounts/index.md",
  ]);
  assert.equal(result.raw.backend, "source:llms.txt");
  assert.match(result.content, /Account API overview/u);
});

void test("validateFetchPipelineRequest enforces byte, output, redirect and selector bounds", () => {
  const base = { url: "https://example.com", format: "text" as const, render: "never" as const, maxBytes: 1_000, maxOutputChars: 1_000, maxRedirects: 3, deadline: new Deadline(1_000) };
  assert.doesNotThrow(() => validateFetchPipelineRequest(base));
  assert.throws(() => validateFetchPipelineRequest({ ...base, maxBytes: 0 }), { code: "INVALID_INPUT" });
  assert.throws(() => validateFetchPipelineRequest({ ...base, maxRedirects: 21 }), { code: "INVALID_INPUT" });
  assert.throws(() => validateFetchPipelineRequest({ ...base, selector: " " }), { code: "INVALID_INPUT" });
});
