import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { NewsResult } from "../core/contracts.js";
import { GroundlaneError } from "../core/errors.js";
import { NEWS_PROVIDER_IDS, type NewsRouter } from "../core/news-router.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const webNewsInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(50).default(10),
  provider: z.enum(["auto", ...NEWS_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(NEWS_PROVIDER_IDS)).min(1).max(NEWS_PROVIDER_IDS.length).optional(),
  strategy: z.enum(["fallback", "parallel"]).default("parallel"),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  country: z.string().trim().length(2).optional(),
  language: z.string().trim().length(2).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).superRefine((value, context) => {
  if (value.provider !== "auto" && value.providers !== undefined) {
    context.addIssue({
      code: "custom",
      message: "provider and providers cannot be used together",
      path: ["providers"],
    });
  }
});

const newsItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  source: z.string().optional(),
  publishedAt: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  provider: z.enum(NEWS_PROVIDER_IDS),
});

const newsDataSchema = z.object({
  query: z.string(),
  strategy: z.enum(["fallback", "parallel"]),
  providersSelected: z.array(z.enum(NEWS_PROVIDER_IDS)),
  providersAttempted: z.array(z.enum(NEWS_PROVIDER_IDS)),
  providersSucceeded: z.array(z.enum(NEWS_PROVIDER_IDS)),
  results: z.array(newsItemSchema),
  providerResults: z.array(z.object({
    provider: z.enum(NEWS_PROVIDER_IDS),
    query: z.string(),
    results: z.array(newsItemSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebNewsModuleOptions {
  router: NewsRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertNewsOutputWithinLimit(result: NewsResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_news", "News output exceeds the configured limit", false, undefined, { code: "web_news.output_too_large", text: "Lower maxOutputChars or reduce maxResults so the news index returns fewer entries." });
  }
}

export function createWebNewsModule(options: WebNewsModuleOptions): McpModule {
  return {
    name: "web_news",
    register(server: McpServer): void {
      server.registerTool(
        "web_news",
        {
          description:
            "Search news-specific provider indexes. Parallel mode fans out across configured news APIs and returns attributed news results.",
          inputSchema: webNewsInputSchema,
          outputSchema: resultEnvelopeSchema(newsDataSchema),
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
                    options.router.news(
                      {
                        query: input.query,
                        maxResults: input.maxResults,
                        provider: input.provider,
                        strategy: input.strategy,
                        ...(input.providers === undefined ? {} : { providers: input.providers }),
                        ...(input.timeRange === undefined ? {} : { timeRange: input.timeRange }),
                        ...(input.country === undefined ? {} : { country: input.country }),
                        ...(input.language === undefined ? {} : { language: input.language }),
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "web_news",
                ),
            );
            assertNewsOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "news" });
          }
        },
      );
    },
  };
}
