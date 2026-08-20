import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { DisabledBrowserBackend } from "../../src/adapters/browser/disabled.js";
import type {
  HttpFetcher,
  RawDocument,
  SearchProvider,
  SearchRequest,
  SearchResult,
} from "../../src/core/contracts.js";
import { FetchPipeline } from "../../src/core/fetch-pipeline.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { SearchRouter } from "../../src/core/search-router.js";
import { createContainerApp } from "../../src/container/app.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createWebExtractModule } from "../../src/tools/web-extract.js";
import { createWebFetchModule } from "../../src/tools/web-fetch.js";
import { createWebSearchModule } from "../../src/tools/web-search.js";

const html = `<!doctype html><html><head><title>Groundlane</title></head><body><main><h1>Hello</h1><a href="/docs">Docs</a></main></body></html>`;

const httpFetcher: HttpFetcher = {
  fetch(request): Promise<RawDocument> {
    return Promise.resolve({
      requestedUrl: request.url,
      finalUrl: request.url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      contentType: "text/html; charset=utf-8",
      body: new TextEncoder().encode(html),
      engine: "http",
      backend: "direct",
    });
  },
};

const searchProvider: SearchProvider = {
  id: "test",
  supports(): boolean {
    return true;
  },
  search(request: SearchRequest): Promise<SearchResult> {
    return Promise.resolve({
      query: request.query,
      provider: "test",
      results: [
        {
          title: "Groundlane",
          url: "https://example.com/groundlane",
          snippet: "Trusted web access",
          provider: "test",
        },
      ],
      durationMs: 1,
      warnings: [],
    });
  },
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

void test("remote MCP lists and executes all Groundlane MVP tools", async () => {
  const pipeline = new FetchPipeline(httpFetcher, new DisabledBrowserBackend());
  const limiter = new ConcurrencyLimiter(2, 2);
  const modules = [
    createWebFetchModule({
      pipeline,
      limiter,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
    createWebSearchModule({
      router: new SearchRouter([searchProvider], ["test"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebExtractModule({
      pipeline,
      limiter,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
  ];
  const app = createContainerApp({
    authToken: "test-token-that-is-long-enough-for-tests",
    registryFactory: () => createMcpRegistry(modules),
  });
  const server = createServer(app);
  const port = await listen(server);
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: "Bearer test-token-that-is-long-enough-for-tests" } } },
  );
  const client = new Client({ name: "groundlane-test", version: "1.0.0" });

  try {
    // SDK 1.29's optional callback declarations conflict under
    // exactOptionalPropertyTypes, though this class implements Transport.
    await client.connect(transport as Transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["web_extract", "web_fetch", "web_search"],
    );

    const fetchResult = await client.callTool({
      name: "web_fetch",
      arguments: { url: "https://example.com", format: "markdown", render: "never" },
    });
    assert.equal(fetchResult.isError, undefined);
    assert.equal((fetchResult.structuredContent as { ok?: boolean }).ok, true);

    const searchResult = await client.callTool({
      name: "web_search",
      arguments: { query: "groundlane", provider: "auto" },
    });
    assert.equal((searchResult.structuredContent as { ok?: boolean }).ok, true);

    const extractResult = await client.callTool({
      name: "web_extract",
      arguments: {
        url: "https://example.com",
        render: "never",
        fields: [
          { name: "heading", selector: "h1", value: "text" },
          { name: "href", selector: "a", value: "attribute", attribute: "href" },
        ],
      },
    });
    const envelope = extractResult.structuredContent as {
      ok?: boolean;
      data?: { data?: Record<string, unknown> };
    };
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data?.data, { heading: "Hello", href: "/docs" });
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
