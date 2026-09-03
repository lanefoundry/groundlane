import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type {
  AnswerResult,
  ContentResult,
  CrawlResult,
  ImagesResult,
  MapResult,
  NewsResult,
  ResearchResult,
  SearchResult,
} from "../../src/core/contracts.js";
import type { AnswerRouter } from "../../src/core/answer-router.js";
import type { ContentRouter } from "../../src/core/content-router.js";
import type { CrawlRouter } from "../../src/core/crawl-router.js";
import type { ImagesRouter } from "../../src/core/images-router.js";
import type { MapRouter } from "../../src/core/map-router.js";
import type { NewsRouter } from "../../src/core/news-router.js";
import type { ResearchRouter } from "../../src/core/research-router.js";
import type { SearchRouter } from "../../src/core/search-router.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createWebSearchModule } from "../../src/tools/web-search.js";
import { createWebAnswerModule } from "../../src/tools/web-answer.js";
import { createWebContentModule } from "../../src/tools/web-content.js";
import { createWebResearchModule } from "../../src/tools/web-research.js";
import { createWebCrawlModule } from "../../src/tools/web-crawl.js";
import { createWebMapModule } from "../../src/tools/web-map.js";
import { createWebNewsModule } from "../../src/tools/web-news.js";
import { createWebImagesModule } from "../../src/tools/web-images.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RegisteredHandler = (
  input: Record<string, unknown>,
  extra: { signal?: AbortSignal },
) => unknown;

function fakeServer(): {
  handlers: Map<string, RegisteredHandler>;
  server: { registerTool(name: string, _config: unknown, handler: RegisteredHandler): void };
} {
  const handlers = new Map<string, RegisteredHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: RegisteredHandler): void {
      handlers.set(name, handler);
    },
  };
  return { handlers, server };
}

interface ErrorEnvelope {
  ok?: boolean;
  error?: { code?: string; stage?: string; message?: string; retryable?: boolean };
}

function assertDeadlineExceeded(envelope: ErrorEnvelope): void {
  assert.equal(envelope.ok, false, "envelope.ok should be false");
  assert.equal(envelope.error?.code, "DEADLINE_EXCEEDED", "error code should be DEADLINE_EXCEEDED");
  assert.equal(envelope.error?.retryable, true, "DEADLINE_EXCEEDED should be retryable");
}

// ---------------------------------------------------------------------------
// Stalling router stubs — each delays well beyond the tiny deadline set by
// the module option (requestTimeoutMs: 1). The Deadline(1) expires almost
// immediately, so withinDeadline aborts the stalling operation.
// ---------------------------------------------------------------------------

function stallingSearchRouter(): Partial<SearchRouter> {
  return {
    async search(): Promise<SearchResult> {
      await delay(500);
      return { query: "", provider: "test", results: [], durationMs: 0, warnings: [] };
    },
  };
}

function stallingAnswerRouter(): Partial<AnswerRouter> {
  return {
    async answer(): Promise<AnswerResult> {
      await delay(500);
      return {
        query: "",
        strategy: "fallback",
        providersSelected: [],
        providersAttempted: [],
        providersSucceeded: [],
        answers: [],
        durationMs: 0,
        warnings: [],
      };
    },
  };
}

function stallingContentRouter(): Partial<ContentRouter> {
  return {
    async fetchContent(): Promise<ContentResult> {
      await delay(500);
      return {
        url: "https://example.com",
        strategy: "parallel",
        providersSelected: [],
        providersAttempted: [],
        providersSucceeded: [],
        contents: [],
        durationMs: 0,
        warnings: [],
      };
    },
  };
}

function stallingResearchRouter(): Partial<ResearchRouter> {
  return {
    async research(): Promise<ResearchResult> {
      await delay(500);
      return {
        query: "",
        effort: "standard",
        strategy: "fallback",
        providersSelected: [],
        providersAttempted: [],
        providersSucceeded: [],
        reports: [],
        durationMs: 0,
        warnings: [],
      };
    },
  };
}

function stallingCrawlRouter(): Partial<CrawlRouter> {
  return {
    async crawl(): Promise<CrawlResult> {
      await delay(500);
      return {
        url: "https://example.com",
        strategy: "parallel",
        providersSelected: [],
        providersAttempted: [],
        providersSucceeded: [],
        pages: [],
        providerResults: [],
        durationMs: 0,
        warnings: [],
      };
    },
  };
}

function stallingMapRouter(): Partial<MapRouter> {
  return {
    async map(): Promise<MapResult> {
      await delay(500);
      return {
        url: "https://example.com",
        strategy: "parallel",
        providersSelected: [],
        providersAttempted: [],
        providersSucceeded: [],
        links: [],
        providerResults: [],
        durationMs: 0,
        warnings: [],
      };
    },
  };
}

function stallingNewsRouter(): Partial<NewsRouter> {
  return {
    async news(): Promise<NewsResult> {
      await delay(500);
      return {
        query: "",
        strategy: "parallel",
        providersSelected: [],
        providersAttempted: [],
        providersSucceeded: [],
        results: [],
        providerResults: [],
        durationMs: 0,
        warnings: [],
      };
    },
  };
}

function stallingImagesRouter(): Partial<ImagesRouter> {
  return {
    async images(): Promise<ImagesResult> {
      await delay(500);
      return {
        query: "",
        strategy: "parallel",
        providersSelected: [],
        providersAttempted: [],
        providersSucceeded: [],
        results: [],
        providerResults: [],
        durationMs: 0,
        warnings: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — each router-based tool must surface DEADLINE_EXCEEDED when the
// operation exceeds the configured timeout.
//
// Strategy: requestTimeoutMs is set to 1 ms (this is a module option, not
// validated by the input schema's 1 000 ms floor). The Deadline(1) created
// inside the handler expires almost immediately, and withinDeadline races
// the stalling router against the expiration timer. The tool's catch block
// wraps the GroundlaneError into a structured { ok: false, error: {...} }
// envelope which we assert on.
// ---------------------------------------------------------------------------

void test("web_search returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebSearchModule({
    router: stallingSearchRouter() as unknown as SearchRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_search");
  assert.ok(handler);
  const result = await handler({ query: "test" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

void test("web_answer returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebAnswerModule({
    router: stallingAnswerRouter() as unknown as AnswerRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_answer");
  assert.ok(handler);
  const result = await handler({ query: "test" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

void test("web_content returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebContentModule({
    router: stallingContentRouter() as unknown as ContentRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_content");
  assert.ok(handler);
  const result = await handler({ url: "https://example.com" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

void test("web_research returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebResearchModule({
    router: stallingResearchRouter() as unknown as ResearchRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_research");
  assert.ok(handler);
  const result = await handler({ query: "test" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

void test("web_crawl returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebCrawlModule({
    router: stallingCrawlRouter() as unknown as CrawlRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_crawl");
  assert.ok(handler);
  const result = await handler({ url: "https://example.com" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

void test("web_map returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebMapModule({
    router: stallingMapRouter() as unknown as MapRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_map");
  assert.ok(handler);
  const result = await handler({ url: "https://example.com" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

void test("web_news returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebNewsModule({
    router: stallingNewsRouter() as unknown as NewsRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_news");
  assert.ok(handler);
  const result = await handler({ query: "test" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

void test("web_images returns DEADLINE_EXCEEDED when router exceeds deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebImagesModule({
    router: stallingImagesRouter() as unknown as ImagesRouter,
    limiter,
    requestTimeoutMs: 1,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_images");
  assert.ok(handler);
  const result = await handler({ query: "test" }, {});
  const envelope = (result as { structuredContent: ErrorEnvelope }).structuredContent;
  assertDeadlineExceeded(envelope);
});

// ---------------------------------------------------------------------------
// Verify that the tool-level timeoutMs input overrides the module default.
// With a generous module default and a tight caller timeout the operation
// should still succeed when the router finishes within that window.
// ---------------------------------------------------------------------------

void test("web_search respects caller timeoutMs override for deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebSearchModule({
    router: stallingSearchRouter() as unknown as SearchRouter,
    limiter,
    requestTimeoutMs: 120_000,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_search");
  assert.ok(handler);
  const result = await handler({ query: "test", timeoutMs: 1_000 }, {});
  const envelope = (result as { structuredContent: { ok?: boolean } }).structuredContent;
  assert.equal(envelope.ok, true, "should succeed within the caller timeout");
});

void test("web_answer respects caller timeoutMs override for deadline", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebAnswerModule({
    router: stallingAnswerRouter() as unknown as AnswerRouter,
    limiter,
    requestTimeoutMs: 120_000,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_answer");
  assert.ok(handler);
  const result = await handler({ query: "test", timeoutMs: 1_000 }, {});
  const envelope = (result as { structuredContent: { ok?: boolean } }).structuredContent;
  assert.equal(envelope.ok, true, "should succeed within the caller timeout");
});
