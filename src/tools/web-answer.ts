import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AnswerResult } from "../core/contracts.js";
import { GroundlaneError } from "../core/errors.js";
import { ANSWER_PROVIDER_IDS, type AnswerRouter } from "../core/answer-router.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const domainSchema = z.string().trim().min(3).max(253);
export const webAnswerInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(10).default(5),
  domains: z.array(domainSchema).max(50).optional(),
  excludeDomains: z.array(domainSchema).max(50).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  provider: z.enum(["auto", ...ANSWER_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(ANSWER_PROVIDER_IDS)).min(1).max(ANSWER_PROVIDER_IDS.length).optional(),
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
});

const answerProviderDataSchema = z.object({
  provider: z.enum(ANSWER_PROVIDER_IDS),
  answer: z.string(),
  citations: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
    excerpts: z.array(z.string()),
  })),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    publishedAt: z.string().optional(),
    provider: z.enum(ANSWER_PROVIDER_IDS),
  })),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

const answerDataSchema = z.object({
  query: z.string(),
  strategy: z.enum(["fallback", "parallel"]),
  providersSelected: z.array(z.enum(ANSWER_PROVIDER_IDS)),
  providersAttempted: z.array(z.enum(ANSWER_PROVIDER_IDS)),
  providersSucceeded: z.array(z.enum(ANSWER_PROVIDER_IDS)),
  answers: z.array(answerProviderDataSchema),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebAnswerModuleOptions {
  router: AnswerRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertAnswerOutputWithinLimit(result: AnswerResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_answer", "Answer output exceeds the configured limit");
  }
}

export function createWebAnswerModule(options: WebAnswerModuleOptions): McpModule {
  return {
    name: "web_answer",
    register(server: McpServer): void {
      server.registerTool(
        "web_answer",
        {
          description:
            "Ask configured answer-capable providers for grounded answers. Parallel mode fans out to multiple providers and returns attributed provider answers without LLM fusion.",
          inputSchema: webAnswerInputSchema,
          outputSchema: resultEnvelopeSchema(answerDataSchema),
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
                    options.router.answer(
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
                  "web_answer",
                ),
            );
            assertAnswerOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
