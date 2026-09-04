import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SearchResult } from "../core/contracts.js";
import { GroundlaneError } from "../core/errors.js";
import { SEARCH_PROVIDER_IDS } from "../core/search-provider-catalog.js";
import type { SearchRouter } from "../core/search-router.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const domainSchema = z.string().trim().min(3).max(253);
export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(20).default(5),
  domains: z.array(domainSchema).max(50).optional(),
  excludeDomains: z.array(domainSchema).max(50).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  provider: z.enum(["auto", ...SEARCH_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(SEARCH_PROVIDER_IDS)).min(1).max(SEARCH_PROVIDER_IDS.length).optional(),
  strategy: z.enum(["fallback", "balanced", "deep"]).default("balanced"),
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
      fusionScore: z.number().optional(),
      sources: z.array(z.object({
        provider: z.string(),
        rank: z.number().int().positive(),
        rawScore: z.number().optional(),
      })).optional(),
    }),
  ),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  strategy: z.enum(["fallback", "balanced", "deep"]).optional(),
  providersSelected: z.array(z.string()).optional(),
  providersAttempted: z.array(z.string()).optional(),
  providersSucceeded: z.array(z.string()).optional(),
  providerDetails: z.array(z.object({
    providerId: z.string(),
    backend: z.enum(["api", "http-compatible"]),
    ownership: z.enum(["built-in", "operator-hosted"]),
    protocolVersion: z.string(),
  })).optional(),
});

export interface WebSearchModuleOptions {
  router: SearchRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertSearchOutputWithinLimit(result: SearchResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "search", "Search output exceeds the configured limit", false, undefined, { code: "search.output_too_large", text: "Lower maxOutputChars on the request, or narrow your query (fewer terms, no site: filters) so each provider returns fewer hits." });
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
            "Search the public web through configured providers. Auto searches use bounded two-provider fusion by default; explicit providers stay single-source.",
          inputSchema: webSearchInputSchema,
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
                        strategy: input.strategy,
                        ...(input.providers === undefined ? {} : { providers: input.providers }),
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
            return toolError(error, { tool: "search" });
          }
        },
      );
    },
  };
}
