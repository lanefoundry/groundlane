import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { DisabledBrowserBackend } from "../../src/adapters/browser/disabled.js";
import type {
  AnswerProvider,
  AnswerProviderResult,
  ContentProvider,
  ContentProviderResult,
  CrawlProvider,
  CrawlProviderResult,
  HttpFetcher,
  ImagesProvider,
  ImagesProviderResult,
  MapProvider,
  MapProviderResult,
  NewsProvider,
  NewsProviderResult,
  RawDocument,
  ResearchProvider,
  ResearchProviderResult,
  SearchProvider,
  SearchRequest,
  SearchResult,
} from "../../src/core/contracts.js";
import { AnswerRouter } from "../../src/core/answer-router.js";
import { ContentRouter } from "../../src/core/content-router.js";
import { CorpusStore, InMemoryCorpusBackend } from "../../src/core/corpus-runtime.js";
import { CrawlJobManager } from "../../src/core/crawl-jobs.js";
import { CrawlRouter } from "../../src/core/crawl-router.js";
import { FetchPipeline } from "../../src/core/fetch-pipeline.js";
import { ImagesRouter } from "../../src/core/images-router.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { MapRouter } from "../../src/core/map-router.js";
import { NewsRouter } from "../../src/core/news-router.js";
import { ProviderBalanceRegistry } from "../../src/core/provider-balance.js";
import { ResearchRouter } from "../../src/core/research-router.js";
import { MonthlySearchBudget } from "../../src/core/search-budget.js";
import { SearchRouter } from "../../src/core/search-router.js";
import { createContainerApp } from "../../src/container/app.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { MCP_SERVER_INSTRUCTIONS } from "../../src/mcp/server.js";
import { createCorpusToolsModule } from "../../src/tools/corpus-tools.js";
import { createCrawlJobsModule } from "../../src/tools/crawl-jobs.js";
import { createDocumentPolicyModule } from "../../src/tools/document-policy.js";
import { createDocumentParseModule } from "../../src/tools/document-parse.js";
import { createWebExtractSchemaModule } from "../../src/tools/web-extract-schema.js";
import { createProviderBalanceModule } from "../../src/tools/provider-balance.js";
import { createProviderCapabilitiesModule } from "../../src/tools/provider-capabilities.js";
import { createProviderQuotaModule } from "../../src/tools/provider-quota.js";
import { createParseModule } from "../../src/tools/parse.js";
import { createSearchBudgetStatusModule } from "../../src/tools/search-budget-status.js";
import { createWebAnswerModule } from "../../src/tools/web-answer.js";
import { createWebContentModule } from "../../src/tools/web-content.js";
import { createWebCrawlModule } from "../../src/tools/web-crawl.js";
import { createWebExtractModule } from "../../src/tools/web-extract.js";
import { createWebFetchModule } from "../../src/tools/web-fetch.js";
import { createWebImagesModule } from "../../src/tools/web-images.js";
import { createWebMapModule } from "../../src/tools/web-map.js";
import { createWebNewsModule } from "../../src/tools/web-news.js";
import { createWebResearchModule } from "../../src/tools/web-research.js";
import { createWebSearchModule } from "../../src/tools/web-search.js";

const html = `<!doctype html><html><head><title>Groundlane</title><meta name="description" content="Trusted web access"><meta name="author" content="Groundlane Team"></head><body><main><h1>Hello</h1><p>Groundlane provides readable web content for AI agents.</p><a href="/docs">Docs</a></main></body></html>`;

function contractPdf(text: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(text.length + 31)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(source)); source += `${String(index + 1)} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

const httpFetcher: HttpFetcher = {
  fetch(request): Promise<RawDocument> {
    if (request.url.endsWith("/document.pdf")) {
      return Promise.resolve({
        requestedUrl: request.url,
        finalUrl: request.url,
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        contentType: "application/octet-stream",
        body: contractPdf("Groundlane URL PDF"),
        engine: "http",
        backend: "direct",
      });
    }
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

const answerProvider: AnswerProvider = {
  id: "you",
  supports(): boolean {
    return true;
  },
  answer(): Promise<AnswerProviderResult> {
    return Promise.resolve({
      provider: "you",
      answer: "Groundlane provides trusted web access.",
      citations: [{ url: "https://example.com/groundlane", excerpts: ["Trusted web access"] }],
      results: [
        {
          title: "Groundlane",
          url: "https://example.com/groundlane",
          snippet: "Trusted web access",
          provider: "you",
        },
      ],
      durationMs: 1,
      warnings: [],
    });
  },
};

const researchProvider: ResearchProvider = {
  id: "you",
  supports(): boolean {
    return true;
  },
  research(): Promise<ResearchProviderResult> {
    return Promise.resolve({
      provider: "you",
      report: "Groundlane returns provider-attributed research reports.",
      citations: [{ url: "https://example.com/groundlane", excerpts: ["research reports"] }],
      durationMs: 1,
      warnings: [],
    });
  },
};

const contentProvider: ContentProvider = {
  id: "keenable",
  supports(): boolean {
    return true;
  },
  fetchContent(): Promise<ContentProviderResult> {
    return Promise.resolve({
      provider: "keenable",
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "Example",
      content: "Groundlane content",
      format: "markdown",
      truncated: false,
      durationMs: 1,
      warnings: [],
    });
  },
};

const mapProvider: MapProvider = {
  id: "firecrawl",
  supports(): boolean {
    return true;
  },
  map(): Promise<MapProviderResult> {
    return Promise.resolve({
      provider: "firecrawl",
      url: "https://example.com",
      links: [{ url: "https://example.com/docs", title: "Docs", provider: "firecrawl" }],
      durationMs: 1,
      warnings: [],
    });
  },
};

const crawlProvider: CrawlProvider = {
  id: "firecrawl",
  supports(): boolean {
    return true;
  },
  crawl(): Promise<CrawlProviderResult> {
    return Promise.resolve({
      provider: "firecrawl",
      url: "https://example.com",
      status: "completed",
      jobId: "crawl-job",
      total: 1,
      completed: 1,
      pages: [
        {
          url: "https://example.com/docs",
          title: "Docs",
          content: "Groundlane docs",
          contentChars: 15,
          truncated: false,
          provider: "firecrawl",
        },
      ],
      durationMs: 1,
      warnings: [],
    });
  },
};

const newsProvider: NewsProvider = {
  id: "brave",
  supports(): boolean {
    return true;
  },
  news(): Promise<NewsProviderResult> {
    return Promise.resolve({
      provider: "brave",
      query: "groundlane",
      results: [
        {
          title: "Groundlane news",
          url: "https://example.com/news",
          snippet: "Trusted web access",
          provider: "brave",
        },
      ],
      durationMs: 1,
      warnings: [],
    });
  },
};

const imagesProvider: ImagesProvider = {
  id: "brave",
  supports(): boolean {
    return true;
  },
  images(): Promise<ImagesProviderResult> {
    return Promise.resolve({
      provider: "brave",
      query: "groundlane",
      results: [
        {
          title: "Groundlane image",
          imageUrl: "https://example.com/image.jpg",
          sourceUrl: "https://example.com/images",
          thumbnailUrl: "https://example.com/thumb.jpg",
          source: "Example",
          provider: "brave",
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
  const balanceRegistry = new ProviderBalanceRegistry({
    supportedProviders: ["test"],
    checkers: [],
  });
  const modules = [
    createProviderCapabilitiesModule(),
    createProviderBalanceModule({
      registry: balanceRegistry,
      limiter,
      requestTimeoutMs: 5_000,
    }),
    createProviderQuotaModule({
      balanceRegistry,
      budget: new MonthlySearchBudget({ test: 2 }),
      limiter,
      requestTimeoutMs: 5_000,
    }),
    createSearchBudgetStatusModule({
      budget: new MonthlySearchBudget({ test: 2 }),
    }),
    createWebAnswerModule({
      router: new AnswerRouter([answerProvider], ["you"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebResearchModule({
      router: new ResearchRouter([researchProvider], ["you"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebContentModule({
      router: new ContentRouter([contentProvider], ["keenable"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebMapModule({
      router: new MapRouter([mapProvider], ["firecrawl"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebCrawlModule({
      router: new CrawlRouter([crawlProvider], ["firecrawl"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebNewsModule({
      router: new NewsRouter([newsProvider], ["brave"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebImagesModule({
      router: new ImagesRouter([imagesProvider], ["brave"]),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
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
    createParseModule({
      pipeline,
      limiter,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
    createCrawlJobsModule({
      manager: new CrawlJobManager(),
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createWebExtractSchemaModule({
      providers: [],
      benchmarkReport: null,
      limiter,
      requestTimeoutMs: 5_000,
      maxOutputChars: 10_000,
    }),
    createDocumentPolicyModule({
      limiter,
      requestTimeoutMs: 5_000,
    }),
    createDocumentParseModule({
      pipeline,
      caller: { ownerId: "owner", credentialBinding: "static:test" },
      limiter,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 100_000,
      maxOutputChars: 10_000,
    }),
    createCorpusToolsModule({
      store: new CorpusStore(new InMemoryCorpusBackend()),
      limiter,
      requestTimeoutMs: 5_000,
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
    assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "corpus_create",
        "corpus_delete",
        "corpus_enroll",
        "corpus_remove",
        "corpus_search",
        "corpus_status",
        "corpus_update",
        "crawl_cancel",
        "crawl_create",
        "crawl_result",
        "crawl_status",
        "document_parse",
        "document_policy",
        "parse",
        "provider_balance",
        "provider_capabilities",
        "provider_quota",
        "search_budget_status",
        "web_answer",
        "web_content",
        "web_crawl",
        "web_extract",
        "web_extract_schema",
        "web_fetch",
        "web_images",
        "web_map",
        "web_news",
        "web_research",
        "web_search",
      ],
    );
    const documentTool = tools.tools.find((tool) => tool.name === "document_parse");
    assert.ok(documentTool !== undefined);
    const documentSchema = JSON.stringify(documentTool.outputSchema);
    for (const field of ["schemaVersion", "documentId", "canonicalContentId", "sourceIdentity", "blocks", "readingOrder", "capabilityStates", "provenance"]) {
      assert.match(documentSchema, new RegExp(`"${field}"`, "u"));
    }

    const capabilitiesResult = await client.callTool({
      name: "provider_capabilities",
      arguments: { provider: "you" },
    });
    const capabilitiesEnvelope = capabilitiesResult.structuredContent as {
      ok?: boolean;
      data?: { providers?: Array<{ provider?: string; groundlaneTools?: string[] }> };
    };
    assert.equal(capabilitiesEnvelope.ok, true);
    assert.equal(capabilitiesEnvelope.data?.providers?.[0]?.provider, "you");
    assert.ok(capabilitiesEnvelope.data?.providers?.[0]?.groundlaneTools?.includes("web_search"));
    assert.ok(capabilitiesEnvelope.data?.providers?.[0]?.groundlaneTools?.includes("web_answer"));
    assert.ok(capabilitiesEnvelope.data?.providers?.[0]?.groundlaneTools?.includes("web_research"));

    const balanceResult = await client.callTool({
      name: "provider_balance",
      arguments: { provider: "you" },
    });
    const balanceEnvelope = balanceResult.structuredContent as {
      ok?: boolean;
      data?: { results?: Array<{ provider?: string; status?: string }> };
    };
    assert.equal(balanceEnvelope.ok, true);
    assert.equal(balanceEnvelope.data?.results?.[0]?.provider, "you");
    assert.equal(balanceEnvelope.data?.results?.[0]?.status, "unsupported");

    const fetchResult = await client.callTool({
      name: "web_fetch",
      arguments: { url: "https://example.com", format: "markdown", render: "never" },
    });
    assert.equal(fetchResult.isError, undefined);
    const fetchEnvelope = fetchResult.structuredContent as {
      ok?: boolean;
      data?: {
        title?: string;
        description?: string;
        author?: string;
        content?: string;
        cached?: boolean;
      };
    };
    assert.equal(fetchEnvelope.ok, true);
    assert.strictEqual(fetchEnvelope.data?.cached, false);
    assert.equal(fetchEnvelope.data?.title, "Groundlane");
    assert.equal(fetchEnvelope.data?.description, "Trusted web access");
    assert.equal(fetchEnvelope.data?.author, "Groundlane Team");
    assert.doesNotMatch(fetchEnvelope.data?.content ?? "", /<html|<head/iu);

    const searchResult = await client.callTool({
      name: "web_search",
      arguments: { query: "groundlane", provider: "auto" },
    });
    const searchEnvelope = searchResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        results?: Array<{ fusionScore?: number; sources?: Array<{ provider?: string }> }>;
      };
    };
    assert.equal(searchEnvelope.ok, true);
    assert.equal(searchEnvelope.data?.strategy, "balanced");
    assert.deepEqual(searchEnvelope.data?.providersSelected, ["test"]);
    assert.deepEqual(searchEnvelope.data?.providersAttempted, ["test"]);
    assert.deepEqual(searchEnvelope.data?.providersSucceeded, ["test"]);
    assert.equal(typeof searchEnvelope.data?.results?.[0]?.fusionScore, "number");
    assert.equal(searchEnvelope.data?.results?.[0]?.sources?.[0]?.provider, "test");

    const answerResult = await client.callTool({
      name: "web_answer",
      arguments: { query: "what is Groundlane?", provider: "you" },
    });
    const answerEnvelope = answerResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        answers?: Array<{ provider?: string; citations?: Array<{ url?: string }> }>;
      };
    };
    assert.equal(answerEnvelope.ok, true);
    assert.equal(answerEnvelope.data?.strategy, "fallback");
    assert.deepEqual(answerEnvelope.data?.providersSelected, ["you"]);
    assert.deepEqual(answerEnvelope.data?.providersAttempted, ["you"]);
    assert.deepEqual(answerEnvelope.data?.providersSucceeded, ["you"]);
    assert.equal(answerEnvelope.data?.answers?.[0]?.provider, "you");
    assert.equal(answerEnvelope.data?.answers?.[0]?.citations?.[0]?.url, "https://example.com/groundlane");

    const researchResult = await client.callTool({
      name: "web_research",
      arguments: { query: "what is Groundlane?", provider: "you" },
    });
    const researchEnvelope = researchResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        reports?: Array<{ provider?: string; report?: string; citations?: Array<{ url?: string }> }>;
      };
    };
    assert.equal(researchEnvelope.ok, true);
    assert.equal(researchEnvelope.data?.strategy, "fallback");
    assert.deepEqual(researchEnvelope.data?.providersSelected, ["you"]);
    assert.deepEqual(researchEnvelope.data?.providersAttempted, ["you"]);
    assert.deepEqual(researchEnvelope.data?.providersSucceeded, ["you"]);
    assert.equal(researchEnvelope.data?.reports?.[0]?.provider, "you");
    assert.equal(researchEnvelope.data?.reports?.[0]?.citations?.[0]?.url, "https://example.com/groundlane");

    const contentResult = await client.callTool({
      name: "web_content",
      arguments: { url: "https://example.com", provider: "keenable" },
    });
    const contentEnvelope = contentResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        contents?: Array<{ provider?: string; content?: string }>;
      };
    };
    assert.equal(contentEnvelope.ok, true);
    assert.equal(contentEnvelope.data?.strategy, "fallback");
    assert.deepEqual(contentEnvelope.data?.providersSelected, ["keenable"]);
    assert.deepEqual(contentEnvelope.data?.providersAttempted, ["keenable"]);
    assert.deepEqual(contentEnvelope.data?.providersSucceeded, ["keenable"]);
    assert.equal(contentEnvelope.data?.contents?.[0]?.provider, "keenable");
    assert.equal(contentEnvelope.data?.contents?.[0]?.content, "Groundlane content");

    const mapResult = await client.callTool({
      name: "web_map",
      arguments: { url: "https://example.com", provider: "firecrawl" },
    });
    const mapEnvelope = mapResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        links?: Array<{ provider?: string; url?: string; title?: string }>;
      };
    };
    assert.equal(mapEnvelope.ok, true);
    assert.equal(mapEnvelope.data?.strategy, "fallback");
    assert.deepEqual(mapEnvelope.data?.providersSelected, ["firecrawl"]);
    assert.deepEqual(mapEnvelope.data?.providersAttempted, ["firecrawl"]);
    assert.deepEqual(mapEnvelope.data?.providersSucceeded, ["firecrawl"]);
    assert.equal(mapEnvelope.data?.links?.[0]?.provider, "firecrawl");
    assert.equal(mapEnvelope.data?.links?.[0]?.url, "https://example.com/docs");

    const crawlResult = await client.callTool({
      name: "web_crawl",
      arguments: { url: "https://example.com", provider: "firecrawl" },
    });
    const crawlEnvelope = crawlResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        pages?: Array<{ provider?: string; url?: string; title?: string; content?: string }>;
        providerResults?: Array<{ status?: string; jobId?: string }>;
      };
    };
    assert.equal(crawlEnvelope.ok, true);
    assert.equal(crawlEnvelope.data?.strategy, "fallback");
    assert.deepEqual(crawlEnvelope.data?.providersSelected, ["firecrawl"]);
    assert.deepEqual(crawlEnvelope.data?.providersAttempted, ["firecrawl"]);
    assert.deepEqual(crawlEnvelope.data?.providersSucceeded, ["firecrawl"]);
    assert.equal(crawlEnvelope.data?.providerResults?.[0]?.status, "completed");
    assert.equal(crawlEnvelope.data?.providerResults?.[0]?.jobId, "crawl-job");
    assert.equal(crawlEnvelope.data?.pages?.[0]?.provider, "firecrawl");
    assert.equal(crawlEnvelope.data?.pages?.[0]?.url, "https://example.com/docs");

    const newsResult = await client.callTool({
      name: "web_news",
      arguments: { query: "groundlane", provider: "brave" },
    });
    const newsEnvelope = newsResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        results?: Array<{ provider?: string; url?: string; title?: string }>;
      };
    };
    assert.equal(newsEnvelope.ok, true);
    assert.equal(newsEnvelope.data?.strategy, "fallback");
    assert.deepEqual(newsEnvelope.data?.providersSelected, ["brave"]);
    assert.deepEqual(newsEnvelope.data?.providersAttempted, ["brave"]);
    assert.deepEqual(newsEnvelope.data?.providersSucceeded, ["brave"]);
    assert.equal(newsEnvelope.data?.results?.[0]?.provider, "brave");
    assert.equal(newsEnvelope.data?.results?.[0]?.url, "https://example.com/news");

    const imagesResult = await client.callTool({
      name: "web_images",
      arguments: { query: "groundlane", provider: "brave" },
    });
    const imagesEnvelope = imagesResult.structuredContent as {
      ok?: boolean;
      data?: {
        strategy?: string;
        providersSelected?: string[];
        providersAttempted?: string[];
        providersSucceeded?: string[];
        results?: Array<{ provider?: string; imageUrl?: string; sourceUrl?: string; title?: string }>;
      };
    };
    assert.equal(imagesEnvelope.ok, true);
    assert.equal(imagesEnvelope.data?.strategy, "fallback");
    assert.deepEqual(imagesEnvelope.data?.providersSelected, ["brave"]);
    assert.deepEqual(imagesEnvelope.data?.providersAttempted, ["brave"]);
    assert.deepEqual(imagesEnvelope.data?.providersSucceeded, ["brave"]);
    assert.equal(imagesEnvelope.data?.results?.[0]?.provider, "brave");
    assert.equal(imagesEnvelope.data?.results?.[0]?.imageUrl, "https://example.com/image.jpg");
    assert.equal(imagesEnvelope.data?.results?.[0]?.sourceUrl, "https://example.com/images");

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
      data?: {
        data?: Record<string, unknown>;
        bytes?: number;
        truncated?: boolean;
        warnings?: string[];
      };
    };
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data?.data, { heading: "Hello", href: "/docs" });
    assert.equal(typeof envelope.data?.bytes, "number");
    assert.equal(envelope.data?.truncated, false);
    assert.deepEqual(envelope.data?.warnings, []);

    const patternExtractResult = await client.callTool({
      name: "web_extract",
      arguments: {
        url: "https://example.com",
        render: "never",
        fields: [
          {
            engine: "pattern",
            name: "docsHref",
            pattern: "href=[\"'](?<href>[^\"']+)[\"']",
            group: "href",
          },
        ],
      },
    });
    const patternEnvelope = patternExtractResult.structuredContent as {
      ok?: boolean;
      data?: { data?: Record<string, unknown> };
    };
    assert.equal(patternEnvelope.ok, true);
    assert.deepEqual(patternEnvelope.data?.data, { docsHref: "/docs" });

    const extractLimitResult = await client.callTool({
      name: "web_extract",
      arguments: {
        url: "https://example.com",
        render: "never",
        maxOutputChars: 1_000,
        fields: [{ name: "body", selector: "body", value: "text" }],
      },
    });
    assert.equal(extractLimitResult.isError, undefined);
    const extractLimitEnvelope = extractLimitResult.structuredContent as {
      ok?: boolean;
      data?: { data?: Record<string, unknown> };
    };
    assert.equal(extractLimitEnvelope.ok, true);
    const extractedBody = extractLimitEnvelope.data?.data?.body;
    if (typeof extractedBody !== "string") {
      assert.fail("expected extracted body to be a string");
    }
    assert.match(extractedBody, /Groundlane/u);

    const parseResult = await client.callTool({
      name: "parse",
      arguments: {
        url: "https://example.com",
        render: "never",
        purpose: "all",
      },
    });
    const parseEnvelope = parseResult.structuredContent as {
      ok?: boolean;
      data?: {
        title?: string;
        description?: string;
        links?: Array<{ url?: string; text?: string; internal?: boolean }>;
        text?: string;
      };
    };
    assert.equal(parseEnvelope.ok, true);
    assert.equal(parseEnvelope.data?.title, "Groundlane");
    assert.equal(parseEnvelope.data?.description, "Trusted web access");
    assert.match(parseEnvelope.data?.text ?? "", /readable web content/u);
    assert.deepEqual(parseEnvelope.data?.links?.[0], {
      url: "https://example.com/docs",
      text: "Docs",
      internal: true,
    });

    const documentResult = await client.callTool({
      name: "document_parse",
      arguments: {
        source: {
          kind: "inline",
          dataBase64: Buffer.from("Groundlane document contract", "utf8").toString("base64"),
          mimeType: "text/plain",
          filename: "contract.txt",
        },
      },
    });
    const documentEnvelope = documentResult.structuredContent as {
      ok?: boolean;
      data?: { projection?: { content?: string }; envelope?: { schemaVersion?: string } };
    };
    assert.equal(documentEnvelope.ok, true);
    assert.equal(documentEnvelope.data?.envelope?.schemaVersion, "1.0.0");
    assert.match(documentEnvelope.data?.projection?.content ?? "", /Groundlane document contract/u);

    const mismatchResult = await client.callTool({
      name: "document_parse",
      arguments: {
        source: {
          kind: "inline",
          dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
          mimeType: "application/pdf",
          filename: "forged.pdf",
        },
      },
    });
    const mismatchEnvelope = mismatchResult.structuredContent as {
      ok?: boolean;
      error?: { code?: string; stage?: string; hint?: { code?: string } };
    };
    assert.equal(mismatchEnvelope.ok, false);
    assert.equal(mismatchEnvelope.error?.code, "INVALID_INPUT");
    assert.equal(mismatchEnvelope.error?.stage, "document-source");
    assert.equal(mismatchEnvelope.error?.hint?.code, "document.mime_mismatch");

    const projections = new Map<string, string>();
    for (const output of ["markdown", "structured", "text", "all"] as const) {
      const result = await client.callTool({
        name: "document_parse",
        arguments: {
          source: {
            kind: "inline",
            dataBase64: Buffer.from("deterministic projection", "utf8").toString("base64"),
            mimeType: "text/plain",
            filename: "projection.txt",
          },
          output,
        },
      });
      const envelope = result.structuredContent as {
        ok?: boolean;
        data?: { envelope?: { documentId?: string; canonicalContentId?: string }; projection?: { kind?: string; content?: string } };
      };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data?.projection?.kind, output);
      projections.set(output, `${envelope.data?.envelope?.documentId ?? ""}:${envelope.data?.envelope?.canonicalContentId ?? ""}`);
    }
    assert.equal(new Set(projections.values()).size, 1);

    const urlDocumentResult = await client.callTool({
      name: "document_parse",
      arguments: { source: { kind: "url", url: "https://example.com/document.pdf" }, output: "text" },
    });
    const urlDocumentEnvelope = urlDocumentResult.structuredContent as {
      ok?: boolean;
      data?: {
        projection?: { content?: string };
        envelope?: { metadata?: Array<{ key?: string; value?: string }> };
        mediaType?: string;
      };
    };
    assert.equal(urlDocumentEnvelope.ok, true);
    assert.equal(urlDocumentEnvelope.data?.mediaType, "application/pdf");
    assert.match(urlDocumentEnvelope.data?.projection?.content ?? "", /Groundlane URL PDF/u);
    assert.deepEqual(
      urlDocumentEnvelope.data?.envelope?.metadata?.find((entry) => entry.key === "requestedUrl"),
      { key: "requestedUrl", value: "https://example.com/document.pdf" },
    );

    const crawlCreateResult = await client.callTool({
      name: "crawl_create",
      arguments: { seedUrl: "https://example.com", ttlSeconds: 600 },
    });
    const crawlCreateEnvelope = crawlCreateResult.structuredContent as {
      ok?: boolean;
      data?: { job?: { groundlaneJobId?: string; status?: string }; reused?: boolean };
    };
    assert.equal(crawlCreateEnvelope.ok, true);
    const crawlJobId = crawlCreateEnvelope.data?.job?.groundlaneJobId;
    assert.match(crawlJobId ?? "", /^gl-crawl-/u);
    assert.equal(crawlCreateEnvelope.data?.reused, false);

    const crawlStatusResult = await client.callTool({
      name: "crawl_status",
      arguments: { groundlaneJobId: crawlJobId },
    });
    const crawlStatusEnvelope = crawlStatusResult.structuredContent as {
      ok?: boolean;
      data?: { job?: { status?: string } };
    };
    assert.equal(crawlStatusEnvelope.ok, true);
    assert.equal(crawlStatusEnvelope.data?.job?.status, "created");

    const crawlResultResult = await client.callTool({
      name: "crawl_result",
      arguments: { groundlaneJobId: crawlJobId, pageSize: 10 },
    });
    const crawlResultEnvelope = crawlResultResult.structuredContent as {
      ok?: boolean;
      data?: { items?: unknown[]; nextCursor?: string | null };
    };
    assert.equal(crawlResultEnvelope.ok, true);
    assert.deepEqual(crawlResultEnvelope.data?.items, []);
    assert.equal(crawlResultEnvelope.data?.nextCursor, null);

    const crawlCancelResult = await client.callTool({
      name: "crawl_cancel",
      arguments: { groundlaneJobId: crawlJobId, kind: "caller" },
    });
    const crawlCancelEnvelope = crawlCancelResult.structuredContent as {
      ok?: boolean;
      data?: {
        job?: { status?: string };
        cancelResult?: { callerCancelled?: boolean; upstreamCancelled?: boolean };
      };
    };
    assert.equal(crawlCancelEnvelope.ok, true);
    assert.equal(crawlCancelEnvelope.data?.job?.status, "cancelled_by_caller");
    assert.equal(crawlCancelEnvelope.data?.cancelResult?.callerCancelled, true);
    assert.equal(crawlCancelEnvelope.data?.cancelResult?.upstreamCancelled, false);

    const schemaResult = await client.callTool({
      name: "web_extract_schema",
      arguments: {
        url: "https://example.com",
        schema: { type: "object", properties: { title: { type: "string" } } },
        providerBacked: true,
      },
    });
    const schemaEnvelope = schemaResult.structuredContent as {
      ok?: boolean;
      error?: { code?: string };
    };
    assert.equal(schemaEnvelope.ok, false);
    assert.equal(schemaEnvelope.error?.code, "PROVIDER_UNAVAILABLE");

    const policyResult = await client.callTool({
      name: "document_policy",
      arguments: {},
    });
    const policyEnvelope = policyResult.structuredContent as {
      ok?: boolean;
      data?: {
        cache?: { effectiveExpiresAt?: string };
        upload?: { effectiveExpiresAt?: string };
        artifact?: { effectiveExpiresAt?: string };
        corpus?: { effectiveExpiresAt?: string };
        runtime?: {
          cacheEnabled?: boolean;
          cacheDefaultMode?: string;
          uploadAvailable?: boolean;
          artifactSourceAvailable?: boolean;
          durableAsyncJobsAvailable?: boolean;
          durableCorporaAvailable?: boolean;
          stagingCleanupWindowSeconds?: number;
          ownershipScope?: string;
        };
      };
    };
    assert.equal(policyEnvelope.ok, true);
    assert.match(policyEnvelope.data?.cache?.effectiveExpiresAt ?? "", /^\d{4}-/u);
    assert.match(policyEnvelope.data?.upload?.effectiveExpiresAt ?? "", /^\d{4}-/u);
    assert.match(policyEnvelope.data?.artifact?.effectiveExpiresAt ?? "", /^\d{4}-/u);
    assert.match(policyEnvelope.data?.corpus?.effectiveExpiresAt ?? "", /^\d{4}-/u);
    assert.deepEqual(policyEnvelope.data?.runtime, {
      cacheEnabled: false,
      cacheDefaultMode: "use",
      uploadAvailable: false,
      artifactSourceAvailable: false,
      durableAsyncJobsAvailable: false,
      durableCorporaAvailable: false,
      stagingCleanupWindowSeconds: 3_600,
      ownershipScope: "principal",
    });

    const corpusCreateResult = await client.callTool({
      name: "corpus_create",
      arguments: { displayName: "contract-fixture" },
    });
    const corpusCreateEnvelope = corpusCreateResult.structuredContent as {
      ok?: boolean;
      data?: { corpus?: { corpusId?: string } };
    };
    assert.equal(corpusCreateEnvelope.ok, true);
    const corpusId = corpusCreateEnvelope.data?.corpus?.corpusId;
    assert.match(corpusId ?? "", /^gl-corpus-/u);

    const corpusEnrollResult = await client.callTool({
      name: "corpus_enroll",
      arguments: {
        corpusId,
        sourceId: "doc-1",
        contentHash: "hash-1",
        acl: ["role:reader"],
      },
    });
    const corpusEnrollEnvelope = corpusEnrollResult.structuredContent as { ok?: boolean };
    assert.equal(corpusEnrollEnvelope.ok, true);

    const corpusSearchResult = await client.callTool({
      name: "corpus_search",
      arguments: { corpusId, query: "groundlane", maxResults: 5 },
    });
    const corpusSearchEnvelope = corpusSearchResult.structuredContent as {
      ok?: boolean;
      data?: { toolFamily?: string; corpusId?: string; results?: unknown[] };
    };
    assert.equal(corpusSearchEnvelope.ok, true);
    assert.equal(corpusSearchEnvelope.data?.toolFamily, "corpus_search");
    assert.equal(corpusSearchEnvelope.data?.corpusId, corpusId);
    assert.ok(Array.isArray(corpusSearchEnvelope.data?.results));

    const corpusDeleteResult = await client.callTool({
      name: "corpus_delete",
      arguments: { corpusId },
    });
    const corpusDeleteEnvelope = corpusDeleteResult.structuredContent as { ok?: boolean };
    assert.equal(corpusDeleteEnvelope.ok, true);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
