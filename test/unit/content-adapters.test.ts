import assert from "node:assert/strict";
import test from "node:test";

import { ExaContentProvider } from "../../src/adapters/content/exa.js";
import { FirecrawlContentProvider } from "../../src/adapters/content/firecrawl.js";
import { KeenableContentProvider } from "../../src/adapters/content/keenable.js";
import { LinkupContentProvider } from "../../src/adapters/content/linkup.js";
import { TavilyContentProvider } from "../../src/adapters/content/tavily.js";
import { TinyFishContentProvider } from "../../src/adapters/content/tinyfish.js";
import { YouContentProvider } from "../../src/adapters/content/you.js";

const signal = new AbortController().signal;

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error("expected string body");
  return JSON.parse(body) as unknown;
}

void test("Linkup content maps /v1/fetch", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const provider = new LinkupContentProvider({
    apiKey: "linkup-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(Response.json({ markdown: "Linkup markdown" }));
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.fetchContent({ url: "https://example.com", maxContentChars: 50 }, signal);

  assert.equal(requestedUrl, "https://api.linkup.so/v1/fetch");
  assert.equal(authorization, "Bearer linkup-secret");
  assert.deepEqual(body, {
    url: "https://example.com",
    extractImages: false,
    includeRawContent: false,
    includeRawHtml: false,
    renderJs: false,
    mode: "standard",
  });
  assert.equal(result.content, "Linkup markdown");
  assert.doesNotMatch(JSON.stringify(result), /linkup-secret/u);
});

void test("You content maps /v1/contents and truncates provider output", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let body: unknown;
  const provider = new YouContentProvider({
    apiKey: "you-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json([{ url: "https://example.com", title: "Example", markdown: "abcdef" }]),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.fetchContent(
    { url: "https://example.com", maxContentChars: 3, live: true },
    signal,
  );

  assert.equal(requestedUrl, "https://ydc-index.io/v1/contents");
  assert.equal(apiKey, "you-secret");
  assert.deepEqual(body, {
    urls: ["https://example.com"],
    formats: ["markdown", "metadata"],
    max_age: 0,
  });
  assert.equal(result.title, "Example");
  assert.equal(result.content, "abc");
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /you-secret/u);
});

void test("Exa content maps /contents", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let body: unknown;
  const provider = new ExaContentProvider({
    apiKey: "exa-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({ results: [{ url: "https://example.com", title: "Example", text: "Exa text" }] }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.fetchContent(
    { url: "https://example.com", maxContentChars: 100 },
    signal,
  );

  assert.equal(requestedUrl, "https://api.exa.ai/contents");
  assert.equal(apiKey, "exa-secret");
  assert.deepEqual(body, {
    urls: ["https://example.com"],
    text: { maxCharacters: 100 },
  });
  assert.equal(result.content, "Exa text");
});

void test("Tavily content maps /extract", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const provider = new TavilyContentProvider({
    apiKey: "tavily-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({ results: [{ url: "https://example.com", raw_content: "Tavily markdown" }] }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.fetchContent({ url: "https://example.com", maxContentChars: 100 }, signal);

  assert.equal(requestedUrl, "https://api.tavily.com/extract");
  assert.equal(authorization, "Bearer tavily-secret");
  assert.deepEqual(body, {
    urls: ["https://example.com"],
    extract_depth: "basic",
    format: "markdown",
    include_images: false,
    include_favicon: false,
  });
  assert.equal(result.content, "Tavily markdown");
});

void test("Firecrawl content maps /v2/scrape", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const provider = new FirecrawlContentProvider({
    apiKey: "firecrawl-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({
          data: {
            markdown: "Firecrawl markdown",
            metadata: { url: "https://example.com", title: "Example" },
          },
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.fetchContent({ url: "https://example.com", maxContentChars: 100 }, signal);

  assert.equal(requestedUrl, "https://api.firecrawl.dev/v2/scrape");
  assert.equal(authorization, "Bearer firecrawl-secret");
  assert.deepEqual(body, {
    url: "https://example.com",
    formats: ["markdown"],
    onlyMainContent: true,
  });
  assert.equal(result.title, "Example");
  assert.equal(result.content, "Firecrawl markdown");
});

void test("Keenable content uses public fetch without a key and keyed fetch when configured", async () => {
  const requested: string[] = [];
  const headers: Headers[] = [];
  const publicProvider = new KeenableContentProvider({
    fetch: (url, init) => {
      requested.push(url);
      headers.push(new Headers(init.headers));
      return Promise.resolve(
        Response.json({ url: "https://example.com", title: "Example", content: "Keenable markdown" }),
      );
    },
    validateUrl: () => Promise.resolve(),
    publicTitle: "Groundlane Tests",
  });
  const keyedProvider = new KeenableContentProvider({
    apiKey: "keenable-secret",
    fetch: (url, init) => {
      requested.push(url);
      headers.push(new Headers(init.headers));
      return Promise.resolve(
        Response.json({ url: "https://example.com", title: "Example", content: "Keenable keyed" }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });

  const publicResult = await publicProvider.fetchContent(
    { url: "https://example.com", maxContentChars: 100 },
    signal,
  );
  const keyedResult = await keyedProvider.fetchContent(
    { url: "https://example.com", maxContentChars: 100, live: true },
    signal,
  );

  assert.equal(new URL(requested[0] ?? "").origin + new URL(requested[0] ?? "").pathname, "https://api.keenable.ai/v1/fetch/public");
  assert.equal(headers[0]?.get("x-keenable-title"), "Groundlane Tests");
  assert.equal(publicResult.warnings[0], "keenable public endpoint used");
  assert.equal(new URL(requested[1] ?? "").origin + new URL(requested[1] ?? "").pathname, "https://api.keenable.ai/v1/fetch");
  assert.equal(headers[1]?.get("x-api-key"), "keenable-secret");
  assert.equal(new URL(requested[1] ?? "").searchParams.get("live"), "true");
  assert.equal(keyedResult.content, "Keenable keyed");
  assert.doesNotMatch(JSON.stringify(keyedResult), /keenable-secret/u);
});

void test("TinyFish content maps Fetch API and live cache bypass", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let body: unknown;
  const provider = new TinyFishContentProvider({
    apiKey: "tinyfish-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({
          results: [
            {
              url: "https://example.com",
              final_url: "https://example.com/final",
              title: "Example",
              text: "TinyFish markdown",
              format: "markdown",
            },
          ],
          errors: [],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });

  const result = await provider.fetchContent(
    { url: "https://example.com", maxContentChars: 100, live: true },
    signal,
  );

  assert.equal(requestedUrl, "https://api.fetch.tinyfish.ai");
  assert.equal(apiKey, "tinyfish-secret");
  assert.deepEqual(body, {
    urls: ["https://example.com"],
    format: "markdown",
    links: false,
    image_links: false,
    ttl: 0,
  });
  assert.equal(result.provider, "tinyfish");
  assert.equal(result.finalUrl, "https://example.com/final");
  assert.equal(result.title, "Example");
  assert.equal(result.content, "TinyFish markdown");
  assert.doesNotMatch(JSON.stringify(result), /tinyfish-secret/u);
});
