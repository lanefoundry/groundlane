import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanSourceMarkdown,
  isLikelyDocumentationUrl,
  llmsTxtCandidates,
  markdownSourceCandidates,
  parseLlmsTxtLinks,
  selectLlmsMarkdownLink,
  sliceMarkdownByHash,
  sliceOpenApiJsonByOperationId,
  sliceOpenApiJsonByPath,
} from "../../src/core/source-aware-docs.js";

void test("markdownSourceCandidates maps docs URLs to content-negotiated and index markdown", () => {
  assert.deepEqual(
    markdownSourceCandidates("https://developers.cloudflare.com/workers/get-started/"),
    [
      {
        url: "https://developers.cloudflare.com/workers/get-started/",
        backend: "source:accept-markdown",
      },
      {
        url: "https://developers.cloudflare.com/workers/get-started/index.md",
        backend: "source:index.md",
      },
    ],
  );
  assert.deepEqual(
    markdownSourceCandidates("https://developers.cloudflare.com/workers/get-started"),
    [
      {
        url: "https://developers.cloudflare.com/workers/get-started",
        backend: "source:accept-markdown",
      },
      {
        url: "https://developers.cloudflare.com/workers/get-started/index.md",
        backend: "source:index.md",
      },
    ],
  );
  assert.deepEqual(markdownSourceCandidates("https://developers.cloudflare.com/workers/index.md"), []);
});

void test("llmsTxtCandidates checks scoped docs index before root index", () => {
  assert.deepEqual(llmsTxtCandidates("https://developers.cloudflare.com/api/resources/accounts/"), [
    "https://developers.cloudflare.com/api/llms.txt",
    "https://developers.cloudflare.com/llms.txt",
  ]);
});

void test("isLikelyDocumentationUrl recognizes common docs surfaces", () => {
  assert.equal(isLikelyDocumentationUrl("https://developers.cloudflare.com/api/resources/accounts/"), true);
  assert.equal(isLikelyDocumentationUrl("https://docs.example.com/reference/search"), true);
  assert.equal(isLikelyDocumentationUrl("https://example.com/products"), false);
});

void test("cleanSourceMarkdown removes bounded documentation chrome", () => {
  const markdown = "---\ntitle: Example\n---\n\n[Skip to content](#_top)\n\n[API Reference](https://example.com/api)\n\nOpen in **Claude**\n\nCopy Markdown\n\n# Page\n\nUseful body.\n\nOn this page\n\n## Keep\n\nCode:\n\n```ts\nconsole.log(\"keep\");\n```\n\nWas this helpful?\n";
  assert.equal(
    cleanSourceMarkdown(markdown),
    "# Page\n\nUseful body.\n\n## Keep\n\nCode:\n\n```ts\nconsole.log(\"keep\");\n```",
  );
});

void test("parseLlmsTxtLinks extracts public Markdown links with sections", () => {
  assert.deepEqual(
    parseLlmsTxtLinks("# Docs\n\n## API\n\n- [Accounts](/api/resources/accounts/index.md): Account operations\n- [External](https://example.net/api/resources/accounts/index.md)\n- [Bad](javascript:alert(1))\n", "https://developers.cloudflare.com/api/llms.txt"),
    [
      {
        title: "Accounts",
        url: "https://developers.cloudflare.com/api/resources/accounts/index.md",
        section: "API",
        notes: "Account operations",
      },
    ],
  );
});

void test("parseLlmsTxtLinks caps discovered same-origin links", () => {
  const links = Array.from({ length: 600 }, (_value, index) => `- [Page ${index}](/docs/page-${index}/index.md)`).join("\n");
  assert.equal(parseLlmsTxtLinks(`# Docs\n\n## Pages\n\n${links}`, "https://example.com/docs/llms.txt").length, 500);
});

void test("selectLlmsMarkdownLink selects the nearest llms.txt Markdown link", () => {
  const llms = "# API\n\n## API Reference\n\n- [Accounts](/api/resources/accounts/index.md)\n- [DNS](/api/resources/dns/index.md)\n";
  const selected = selectLlmsMarkdownLink(
    llms,
    "https://developers.cloudflare.com/api/llms.txt",
    "https://developers.cloudflare.com/api/resources/accounts/methods/list/",
  );

  assert.equal(selected?.url, "https://developers.cloudflare.com/api/resources/accounts/index.md");
});

void test("sliceMarkdownByHash returns the requested heading range", () => {
  const markdown = "# Page\n\nIntro\n\n## Alpha\n\nKeep this.\n\n### Detail\n\nAlso keep.\n\n## Beta\n\nDrop this.";
  assert.equal(
    sliceMarkdownByHash(markdown, "https://example.com/docs/#alpha"),
    "## Alpha\n\nKeep this.\n\n### Detail\n\nAlso keep.",
  );
  assert.equal(sliceMarkdownByHash(markdown, "https://example.com/docs/#missing"), markdown);
});

void test("sliceOpenApiJsonByPath extracts a single path or method", () => {
  const openApi = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/accounts": {
        get: { operationId: "accounts-list", summary: "List accounts" },
        post: { operationId: "accounts-create", summary: "Create account" },
      },
    },
  });

  assert.match(sliceOpenApiJsonByPath(openApi, "/accounts")?.content ?? "", /accounts-list/u);
  const getSlice = sliceOpenApiJsonByPath(openApi, "/accounts", "GET");
  assert.equal(getSlice?.backend, "source:openapi-path");
  assert.match(getSlice?.content ?? "", /List accounts/u);
  assert.doesNotMatch(getSlice?.content ?? "", /Create account/u);
  assert.equal(sliceOpenApiJsonByPath(openApi, "/missing"), undefined);
});

void test("sliceOpenApiJsonByOperationId extracts a unique operation", () => {
  const openApi = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/accounts": {
        get: { operationId: "accounts-list", summary: "List accounts" },
      },
      "/zones": {
        get: { operationId: "zones-list", summary: "List zones" },
      },
    },
  });

  const slice = sliceOpenApiJsonByOperationId(openApi, "zones-list");
  assert.equal(slice?.backend, "source:openapi-operation");
  assert.match(slice?.content ?? "", /"path": "\/zones"/u);
  assert.match(slice?.content ?? "", /List zones/u);
  assert.equal(sliceOpenApiJsonByOperationId(openApi, "missing"), undefined);
});

void test("sliceOpenApiJsonByOperationId rejects duplicate or malformed matches", () => {
  const duplicate = JSON.stringify({
    paths: {
      "/a": { get: { operationId: "same" } },
      "/b": { post: { operationId: "same" } },
    },
  });

  assert.equal(sliceOpenApiJsonByOperationId(duplicate, "same"), undefined);
  assert.equal(sliceOpenApiJsonByOperationId("{", "same"), undefined);
  assert.equal(sliceOpenApiJsonByPath("{", "/a"), undefined);
});
