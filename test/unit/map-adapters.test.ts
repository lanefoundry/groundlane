import assert from "node:assert/strict";
import test from "node:test";

import { FirecrawlMapProvider } from "../../src/adapters/map/firecrawl.js";
import { TavilyMapProvider } from "../../src/adapters/map/tavily.js";

const signal = new AbortController().signal;

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error("expected string body");
  return JSON.parse(body) as unknown;
}

void test("Firecrawl map maps /v2/map and validates provider URLs", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const validated: string[] = [];
  const provider = new FirecrawlMapProvider({
    apiKey: "firecrawl-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({
          success: true,
          links: [
            { url: "https://example.com/a", title: "A", description: "Alpha" },
            { url: "http://127.0.0.1/private", title: "Unsafe" },
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
  const result = await provider.map(
    {
      url: "https://example.com",
      maxLinks: 20,
      search: "docs",
      includeSubdomains: false,
      ignoreCache: true,
    },
    signal,
  );

  assert.equal(requestedUrl, "https://api.firecrawl.dev/v2/map");
  assert.equal(authorization, "Bearer firecrawl-secret");
  assert.deepEqual(body, {
    url: "https://example.com",
    search: "docs",
    includeSubdomains: false,
    ignoreQueryParameters: true,
    ignoreCache: true,
    limit: 20,
  });
  assert.deepEqual(validated, ["https://example.com/a"]);
  assert.equal(result.links[0]?.title, "A");
  assert.equal(result.links[0]?.description, "Alpha");
  assert.doesNotMatch(JSON.stringify(result), /firecrawl-secret/u);
});

void test("Tavily map maps /map and usage warnings", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const provider = new TavilyMapProvider({
    apiKey: "tavily-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({
          base_url: "example.com",
          results: ["https://example.com/a", "https://example.com/b"],
          usage: { credits: 1 },
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.map(
    {
      url: "https://example.com",
      maxLinks: 2,
      search: "python sdk",
      maxDepth: 2,
      maxBreadth: 10,
    },
    signal,
  );

  assert.equal(requestedUrl, "https://api.tavily.com/map");
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
  assert.deepEqual(result.links.map((link) => link.url), ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(result.warnings, ["tavily credits used: 1"]);
  assert.doesNotMatch(JSON.stringify(result), /tavily-secret/u);
});
