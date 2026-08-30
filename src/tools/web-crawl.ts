import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CrawlResult } from "../core/contracts.js";
import { CRAWL_PROVIDER_IDS, type CrawlRouter } from "../core/crawl-router.js";
import { GroundlaneError } from "../core/errors.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const webCrawlInputSchema = z.object({
  url: z.string().trim().url().max(2_048),
  maxPages: z.number().int().min(1).max(100).default(20),
  maxContentChars: z.number().int().min(0).max(20_000).default(2_000),
  provider: z.enum(["auto", ...CRAWL_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(CRAWL_PROVIDER_IDS)).min(1).max(CRAWL_PROVIDER_IDS.length).optional(),
  strategy: z.enum(["fallback", "parallel"]).default("parallel"),
  instructions: z.string().trim().min(1).max(500).optional(),
  includeSubdomains: z.boolean().optional(),
  ignoreCache: z.boolean().default(false),
  maxDepth: z.number().int().min(1).max(5).default(2),
  maxBreadth: z.number().int().min(1).max(500).default(20),
  maxPolls: z.number().int().min(1).max(5).default(1),
  pollIntervalMs: z.number().int().min(250).max(5_000).default(1_000),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
}).superRefine((value, context) => {
  if (value.provider !== "auto" && value.providers !== undefined) {
    context.addIssue({
      code: "custom",
      message: "provider and providers cannot be used together",
      path: ["providers"],
    });
  }
});

const crawlPageSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  contentChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
  provider: z.enum(CRAWL_PROVIDER_IDS),
});

const crawlDataSchema = z.object({
  url: z.string(),
  strategy: z.enum(["fallback", "parallel"]),
  providersSelected: z.array(z.enum(CRAWL_PROVIDER_IDS)),
  providersAttempted: z.array(z.enum(CRAWL_PROVIDER_IDS)),
  providersSucceeded: z.array(z.enum(CRAWL_PROVIDER_IDS)),
  pages: z.array(crawlPageSchema),
  providerResults: z.array(z.object({
    provider: z.enum(CRAWL_PROVIDER_IDS),
    url: z.string(),
    status: z.enum(["completed", "running", "failed", "unknown"]),
    jobId: z.string().optional(),
    total: z.number().optional(),
    completed: z.number().optional(),
    creditsUsed: z.number().optional(),
    pages: z.array(crawlPageSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebCrawlModuleOptions {
  router: CrawlRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertCrawlOutputWithinLimit(result: CrawlResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_crawl", "Crawl output exceeds the configured limit", false, undefined, { code: "web_crawl.output_too_large", text: "Lower maxOutputChars, reduce maxUrls, or narrow includePaths / patterns so the crawl visits fewer pages." });
  }
}

export function createWebCrawlModule(options: WebCrawlModuleOptions): McpModule {
  return {
    name: "web_crawl",
    register(server: McpServer): void {
      server.registerTool(
        "web_crawl",
        {
          description:
            "Run a bounded public-site crawl through crawl-capable providers and return an attributed job summary with discovered pages and capped page content.",
          inputSchema: webCrawlInputSchema,
          outputSchema: resultEnvelopeSchema(crawlDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  (signal) =>
                    options.router.crawl(
                      {
                        url: input.url,
                        maxPages: input.maxPages,
                        maxContentChars: input.maxContentChars,
                        provider: input.provider,
                        strategy: input.strategy,
                        ignoreCache: input.ignoreCache,
                        maxDepth: input.maxDepth,
                        maxBreadth: input.maxBreadth,
                        maxPolls: input.maxPolls,
                        pollIntervalMs: input.pollIntervalMs,
                        ...(input.providers === undefined ? {} : { providers: input.providers }),
                        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
                        ...(input.includeSubdomains === undefined
                          ? {}
                          : { includeSubdomains: input.includeSubdomains }),
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "web_crawl",
                ),
            );
            assertCrawlOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}

