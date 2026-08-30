import assert from "node:assert/strict";
import test from "node:test";

import type { ContentProvider, ContentProviderResult, ContentResult } from "../../src/core/contracts.js";
import type { ContentRouter } from "../../src/core/content-router.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { assertContentOutputWithinLimit, createWebContentModule } from "../../src/tools/web-content.js";
type RegisteredHandler = (
  input: { url?: string; maxContentChars?: number; providers?: string[]; strategy?: string; live?: boolean; timeoutMs?: number },
  extra: { signal?: AbortSignal },
) => unknown;

function fakeServer(): { handlers: Map<string, RegisteredHandler>; server: { registerTool(name: string, _config: unknown, handler: RegisteredHandler): void } } {
  const handlers = new Map<string, RegisteredHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: RegisteredHandler): void {
      handlers.set(name, handler);
    },
  };
  return { handlers, server };
}

const successContent: ContentProviderResult = {
  provider: "you",
  url: "https://example.com",
  finalUrl: "https://example.com",
  content: "ok",
  format: "markdown",
  truncated: false,
  durationMs: 1,
  warnings: [],
};
const stubRouter = {
  fetchContent(): Promise<ContentResult> {
    return Promise.resolve({
      url: "https://example.com",
      strategy: "parallel",
      providersSelected: ["you"],
      providersAttempted: ["you"],
      providersSucceeded: ["you"],
      contents: [successContent],
      durationMs: 1,
      warnings: [],
    });
  },
} satisfies Partial<ContentRouter>;

const hugeContent: ContentProviderResult = {
  provider: "you",
  url: "https://example.com",
  finalUrl: "https://example.com",
  content: "x".repeat(50_000),
  format: "markdown",
  truncated: false,
  durationMs: 1,
  warnings: [],
};

void test("web_content rejects .pdf URLs early with hint pointing to web_fetch", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebContentModule({
    router: stubRouter as unknown as ContentRouter,
    limiter,
    requestTimeoutMs: 5_000,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_content");
  assert.ok(handler);
  const result = await handler({ url: "https://patents.google.com/patent/US11216515B2/en/pdf", maxContentChars: 1000 }, {});

  if (!result || typeof result !== "object" || !("structuredContent" in result)) {
    assert.fail("expected structuredContent");
  }
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    error?: { code?: string; hint?: string; message?: string };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "INVALID_INPUT");
  assert.match(envelope.error?.message ?? "", /\.pdf/);
  assert.match(envelope.error?.hint ?? "", /web_fetch/);
});

void test("web_content attaches hint to OUTPUT_LIMIT errors", () => {
  const huge: ContentResult = {
    url: "https://example.com",
    strategy: "parallel",
    providersSelected: ["you"],
    providersAttempted: ["you"],
    providersSucceeded: ["you"],
    contents: [hugeContent],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertContentOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !("hint" in error)) {
      assert.fail("expected GroundlaneError-shaped throw");
    }
    assert.equal((error as { code: string }).code, "OUTPUT_LIMIT");
    assert.match((error as { hint?: string }).hint ?? "", /maxContentChars/);
  }
});

void test("web_content OUTPUT_LIMIT is retryable", () => {
  const huge: ContentResult = {
    url: "https://example.com",
    strategy: "parallel",
    providersSelected: ["you"],
    providersAttempted: ["you"],
    providersSucceeded: ["you"],
    contents: [hugeContent],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertContentOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    if (!(error instanceof Error) || !("retryable" in error)) {
      assert.fail("expected GroundlaneError-shaped throw");
    }
    assert.equal((error as { retryable: boolean }).retryable, true);
  }
});

void test("web_content allows HTML URLs through (control case)", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebContentModule({
    router: stubRouter as unknown as ContentRouter,
    limiter,
    requestTimeoutMs: 5_000,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_content");
  assert.ok(handler);
  const result = await handler({ url: "https://example.com/page", maxContentChars: 1000 }, {});

  if (!result || typeof result !== "object" || !("structuredContent" in result)) {
    assert.fail("expected structuredContent");
  }
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: { url?: string };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.url, "https://example.com");
});

void test("web_content does not reject URLs that merely contain .pdf in query string", async () => {
  const { handlers, server } = fakeServer();
  const limiter = new ConcurrencyLimiter(1, 1);
  await createWebContentModule({
    router: stubRouter as unknown as ContentRouter,
    limiter,
    requestTimeoutMs: 5_000,
    maxOutputChars: 100_000,
  }).register(server as never);

  const handler = handlers.get("web_content");
  assert.ok(handler);
  // .pdf appears in the query but pathname is /docs — content providers should still try.
  const result = await handler({ url: "https://example.com/docs?file=whitepaper.pdf", maxContentChars: 1000 }, {});

  if (!result || typeof result !== "object" || !("structuredContent" in result)) {
    assert.fail("expected structuredContent");
  }
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
  };
  assert.equal(envelope.ok, true);
});

// Touch the unused ContentProvider import so editors do not strip it from the file
// during the test suite. The provider stub is exercised transitively through stubRouter.
void test("ContentProvider stub compiles", () => {
  const _provider: ContentProvider = {
    id: "you",
    supports() { return true; },
    fetchContent() { return Promise.resolve(successContent); },
  };
  assert.ok(_provider.id === "you");
});