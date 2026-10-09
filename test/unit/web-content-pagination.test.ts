import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ContentRouter } from "../../src/core/content-router.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createWebContentModule, webContentInputSchema } from "../../src/tools/web-content.js";
import type { ContentResult } from "../../src/core/contracts.js";

void test("web_content paginated request fits deployment output cap and fetches beyond original prefix", async () => {
  let requestedLimit = 0;
  const router: Pick<ContentRouter, "fetchContent"> = {
    fetchContent(request) {
      requestedLimit = request.maxContentChars;
      return Promise.resolve({ url: request.url, strategy: "fallback", providersSelected: ["tavily"], providersAttempted: ["tavily"], providersSucceeded: ["tavily"], contents: [{ provider: "tavily", url: request.url, finalUrl: request.url, content: "字幕😀\n".repeat(30_000), format: "markdown", truncated: false, durationMs: 1, warnings: [] }], durationMs: 1, warnings: [] });
    },
  };
  let handler: ((input: ReturnType<typeof webContentInputSchema.parse>, ctx: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>) | undefined;
  const server = { registerTool(_name: string, _config: unknown, callback: NonNullable<typeof handler>) { handler = callback; } };
  await createWebContentModule({ router: router as ContentRouter, limiter: new ConcurrencyLimiter(1, 1), requestTimeoutMs: 5_000, maxOutputChars: 10_000 }).register(server as McpServer);
  assert.ok(handler);
  const input = webContentInputSchema.parse({ url: "https://example.com/video", provider: "tavily", paginate: true, maxContentChars: 20_000 });
  const response = await handler(input, { mcpReq: { signal: new AbortController().signal } });
  assert.ok(response && typeof response === "object" && "structuredContent" in response);
  const envelope = response.structuredContent as { ok: boolean; data: ContentResult & { contents: { nextContentOffset: number; contentHash: string }[] } };
  assert.equal(envelope.ok, true);
  assert.equal(requestedLimit, 200_000);
  assert.ok(Array.from(JSON.stringify(envelope.data)).length <= 10_000);
  assert.ok(envelope.data.contents[0]!.nextContentOffset > 0);
  assert.match(envelope.data.contents[0]!.contentHash, /^[a-f0-9]{64}$/);
  const first = envelope.data.contents[0]!;
  const nextInput = webContentInputSchema.parse({ ...input, contentOffset: first.nextContentOffset, expectedContentHash: first.contentHash });
  const nextResponse = await handler(nextInput, { mcpReq: { signal: new AbortController().signal } });
  assert.ok(nextResponse && typeof nextResponse === "object" && "structuredContent" in nextResponse);
  const next = nextResponse.structuredContent as { ok: boolean; data: { contents: { content: string; contentOffset: number; contentHash: string }[] } };
  assert.equal(next.ok, true);
  assert.equal(next.data.contents[0]!.contentOffset, first.nextContentOffset);
  assert.equal(next.data.contents[0]!.contentHash, first.contentHash);
});

void test("web_content pagination schema rejects ambiguous providers and unguarded continuation", () => {
  const url = "https://example.com/video";
  assert.equal(webContentInputSchema.safeParse({ url, paginate: true }).success, false);
  assert.equal(webContentInputSchema.safeParse({ url, provider: "tavily", paginate: true, contentOffset: 100 }).success, false);
  assert.equal(webContentInputSchema.safeParse({ url, contentOffset: 100 }).success, false);
  assert.equal(webContentInputSchema.safeParse({ url, paginate: true, provider: "tavily", providers: ["you"] }).success, false);
  assert.equal(webContentInputSchema.safeParse({ url, paginate: true, provider: "tavily", contentOffset: -1 }).success, false);
  assert.equal(webContentInputSchema.safeParse({ url, paginate: true, provider: "tavily", contentOffset: 1.5 }).success, false);
  assert.equal(webContentInputSchema.safeParse({ url, paginate: true, provider: "tavily", expectedContentHash: "bad" }).success, false);
});
