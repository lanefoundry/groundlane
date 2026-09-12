import assert from "node:assert/strict";
import test from "node:test";

import { CrawlJobManager } from "../../src/core/crawl-jobs.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createCrawlJobsModule } from "../../src/tools/crawl-jobs.js";

type RegisteredHandler = (
  input: Record<string, unknown>,
  extra: { signal?: AbortSignal },
) => unknown;
type SdkRegisteredHandler = (
  input: Record<string, unknown>,
  ctx: { mcpReq: { signal?: AbortSignal } },
) => unknown;

void test("crawl job tools fail closed when deployment state is not durable", async () => {
  const handlers = new Map<string, RegisteredHandler>();
  const server = {
    registerTool(name: string, _definition: unknown, handler: SdkRegisteredHandler): void {
      handlers.set(name, (input, extra) => handler(input, { mcpReq: extra }));
    },
  };
  await createCrawlJobsModule({
    manager: new CrawlJobManager(),
    limiter: new ConcurrencyLimiter(1, 1),
    requestTimeoutMs: 5_000,
    maxOutputChars: 10_000,
    available: false,
  }).register(server as never);

  const calls = [
    ["crawl_create", { seedUrl: "https://example.com", ttlSeconds: 600 }],
    ["crawl_status", { groundlaneJobId: "gl-crawl-unavailable" }],
    ["crawl_result", { groundlaneJobId: "gl-crawl-unavailable" }],
    ["crawl_cancel", { groundlaneJobId: "gl-crawl-unavailable", kind: "caller" }],
  ] as const;

  for (const [name, input] of calls) {
    const handler = handlers.get(name);
    assert.ok(handler);
    const result = await handler(input, {});
    const envelope = (result as { structuredContent?: unknown }).structuredContent as {
      ok?: boolean;
      error?: { code?: string; stage?: string; message?: string };
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "PROVIDER_UNAVAILABLE");
    assert.equal(envelope.error?.stage, "crawl-jobs");
    assert.equal(
      envelope.error?.message,
      "Durable crawl jobs are not configured in this deployment",
    );
  }
});
