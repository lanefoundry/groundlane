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
        "parse",
        "provider_balance",
        "provider_capabilities",
        "provider_quota",
        "search_budget_status",
        "web_answer",
        "web_content",
        "web_crawl",
        "web_extract",
        "web_fetch",
        "web_images",
        "web_map",
        "web_news",
        "web_research",
        "web_search",
      ],
    );

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
      };
    };
    assert.equal(fetchEnvelope.ok, true);
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
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
