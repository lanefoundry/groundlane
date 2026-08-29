import assert from "node:assert/strict";
import test from "node:test";

import { FirecrawlCrawlProvider } from "../../src/adapters/crawl/firecrawl.js";
import { TavilyCrawlProvider } from "../../src/adapters/crawl/tavily.js";

const signal = new AbortController().signal;

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error("expected string body");
  return JSON.parse(body) as unknown;
}

void test("Firecrawl crawl starts /v2/crawl, polls status, and validates provider URLs", async () => {
  const requestedUrls: string[] = [];
  const authorizations: string[] = [];
  const bodies: unknown[] = [];
  const validated: string[] = [];
  const provider = new FirecrawlCrawlProvider({
    apiKey: "firecrawl-secret",
    fetch: (url, init) => {
      requestedUrls.push(url);
      authorizations.push(new Headers(init.headers).get("authorization") ?? "");
      if (init.body !== undefined) bodies.push(parseBody(init.body));
      if (url.endsWith("/v2/crawl")) {
        return Promise.resolve(Response.json({ success: true, id: "job-123" }));
      }
      return Promise.resolve(
        Response.json({
          status: "completed",
          total: 2,
          completed: 2,
          creditsUsed: 2,
          data: [
            {
              markdown: "Alpha content",
              metadata: { sourceURL: "https://example.com/a", title: "A", description: "Alpha" },
            },
            {
              markdown: "Unsafe",
              metadata: { sourceURL: "http://127.0.0.1/private", title: "Unsafe" },
            },
          ],
        }),
      );
    },
    validateUrl: (url) => {
      if (url.includes("127.0.0.1")) return Promise.reject(new Error("blocked"));
      validated.push(url);
      return Promise.resolve();
    },
  });

  const result = await provider.crawl(
    {
      url: "https://example.com",
      maxPages: 10,
      maxContentChars: 5,
      instructions: "docs",
      includeSubdomains: true,
      ignoreCache: true,
      maxDepth: 3,
      maxPolls: 1,
    },
    signal,
  );

  assert.deepEqual(requestedUrls, [
    "https://api.firecrawl.dev/v2/crawl",
    "https://api.firecrawl.dev/v2/crawl/job-123",
  ]);
  assert.deepEqual(authorizations, ["Bearer firecrawl-secret", "Bearer firecrawl-secret"]);
  assert.deepEqual(bodies, [
    {
      url: "https://example.com",
      prompt: "docs",
      limit: 10,
      maxDiscoveryDepth: 3,
      ignoreQueryParameters: true,
      allowExternalLinks: false,
      allowSubdomains: true,
      scrapeOptions: {
        formats: ["markdown"],
        onlyMainContent: true,
        storeInCache: false,
      },
    },
  ]);
  assert.deepEqual(validated, ["https://example.com/a"]);
  assert.equal(result.jobId, "job-123");
  assert.equal(result.status, "completed");
  assert.equal(result.creditsUsed, 2);
  assert.equal(result.pages[0]?.content, "Alpha");
  assert.equal(result.pages[0]?.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /firecrawl-secret/u);
});

void test("Tavily crawl maps /crawl and usage warnings", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const provider = new TavilyCrawlProvider({
    apiKey: "tavily-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({
          base_url: "example.com",
          results: [
            { url: "https://example.com/a", raw_content: "Alpha" },
            { url: "https://example.com/b", raw_content: "Beta" },
          ],
          usage: { credits: 1 },
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.crawl(
    {
      url: "https://example.com",
      maxPages: 2,
      maxContentChars: 100,
      instructions: "python sdk",
      maxDepth: 2,
      maxBreadth: 10,
    },
    signal,
  );

  assert.equal(requestedUrl, "https://api.tavily.com/crawl");
  assert.equal(authorization, "Bearer tavily-secret");
  assert.deepEqual(body, {
    url: "https://example.com",
    instructions: "python sdk",
    max_depth: 2,
    max_breadth: 10,
    limit: 2,
    allow_external: false,
    include_usage: true,
  });
  assert.deepEqual(result.pages.map((page) => page.url), ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(result.warnings, ["tavily credits used: 1"]);
  assert.doesNotMatch(JSON.stringify(result), /tavily-secret/u);
});

