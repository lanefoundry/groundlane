import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ResearchResult } from "../core/contracts.js";
import { GroundlaneError } from "../core/errors.js";
import { RESEARCH_PROVIDER_IDS, type ResearchRouter } from "../core/research-router.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const domainSchema = z.string().trim().min(3).max(253);
export const webResearchInputSchema = z.object({
  query: z.string().trim().min(1).max(40_000),
  effort: z.enum(["lite", "standard", "deep"]).default("standard"),
  domains: z.array(domainSchema).max(50).optional(),
  excludeDomains: z.array(domainSchema).max(50).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  country: z.string().trim().length(2).optional(),
  provider: z.enum(["auto", ...RESEARCH_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(RESEARCH_PROVIDER_IDS)).min(1).max(RESEARCH_PROVIDER_IDS.length).optional(),
  strategy: z.enum(["fallback", "parallel"]).default("parallel"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).superRefine((value, context) => {
  if (value.provider !== "auto" && value.providers !== undefined) {
    context.addIssue({
      code: "custom",
      message: "provider and providers cannot be used together",
      path: ["providers"],
    });
  }
  if (value.domains !== undefined && value.excludeDomains !== undefined) {
    context.addIssue({
      code: "custom",
      message: "domains and excludeDomains cannot be used together",
      path: ["excludeDomains"],
    });
  }
});

const researchProviderDataSchema = z.object({
  provider: z.enum(RESEARCH_PROVIDER_IDS),
  report: z.string(),
  citations: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
    excerpts: z.array(z.string()),
  })),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

const researchDataSchema = z.object({
  query: z.string(),
  effort: z.enum(["lite", "standard", "deep"]),
  strategy: z.enum(["fallback", "parallel"]),
  providersSelected: z.array(z.enum(RESEARCH_PROVIDER_IDS)),
  providersAttempted: z.array(z.enum(RESEARCH_PROVIDER_IDS)),
  providersSucceeded: z.array(z.enum(RESEARCH_PROVIDER_IDS)),
  reports: z.array(researchProviderDataSchema),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebResearchModuleOptions {
  router: ResearchRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertResearchOutputWithinLimit(result: ResearchResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_research", "Research output exceeds the configured limit", false, undefined, { code: "web_research.output_too_large", text: "Lower maxOutputChars on the request, or narrow the research question so providers return shorter syntheses." });
  }
}

export function createWebResearchModule(options: WebResearchModuleOptions): McpModule {
  return {
    name: "web_research",
    register(server: McpServer): void {
      server.registerTool(
        "web_research",
        {
          description:
            "Ask configured research-capable providers for cited research reports. Parallel mode fans out to multiple providers and returns attributed reports without cross-provider synthesis.",
          inputSchema: webResearchInputSchema,
          outputSchema: resultEnvelopeSchema(researchDataSchema),
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
                    options.router.research(
                      {
                        query: input.query,
                        effort: input.effort,
                        provider: input.provider,
                        strategy: input.strategy,
                        ...(input.providers === undefined ? {} : { providers: input.providers }),
                        ...(input.domains === undefined ? {} : { domains: input.domains }),
                        ...(input.excludeDomains === undefined
                          ? {}
                          : { excludeDomains: input.excludeDomains }),
                        ...(input.timeRange === undefined ? {} : { timeRange: input.timeRange }),
                        ...(input.country === undefined ? {} : { country: input.country }),
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "web_research",
                ),
            );
            assertResearchOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "research" });
          }
        },
      );
    },
  };
}
