import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SearchResult } from "../core/contracts.js";
import { GroundlaneError } from "../core/errors.js";
import type { SearchRouter } from "../core/search-router.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const domainSchema = z.string().trim().min(3).max(253);
const inputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(20).default(5),
  domains: z.array(domainSchema).max(50).optional(),
  excludeDomains: z.array(domainSchema).max(50).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  provider: z
    .enum([
      "auto",
      "tavily",
      "exa",
      "parallel",
      "browserbase",
      "brave",
      "firecrawl",
      "serpapi",
    ])
    .default("auto"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
});

const searchDataSchema = z.object({
  query: z.string(),
  provider: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      publishedAt: z.string().optional(),
      score: z.number().optional(),
      provider: z.string(),
    }),
  ),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebSearchModuleOptions {
  router: SearchRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertSearchOutputWithinLimit(result: SearchResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "search", "Search output exceeds the configured limit");
  }
}

export function createWebSearchModule(options: WebSearchModuleOptions): McpModule {
  return {
    name: "web_search",
    register(server: McpServer): void {
      server.registerTool(
        "web_search",
        {
          description:
            "Search the public web through a configured provider and return normalized, attributed results.",
          inputSchema,
          outputSchema: resultEnvelopeSchema(searchDataSchema),
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
                    options.router.search(
                      {
                        query: input.query,
                        maxResults: input.maxResults,
                        provider: input.provider,
                        ...(input.domains === undefined ? {} : { domains: input.domains }),
                        ...(input.excludeDomains === undefined
                          ? {}
                          : { excludeDomains: input.excludeDomains }),
                        ...(input.timeRange === undefined ? {} : { timeRange: input.timeRange }),
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "search",
                ),
            );
            assertSearchOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
