import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ContentResult } from "../core/contracts.js";
import { ContentRouter, CONTENT_PROVIDER_IDS } from "../core/content-router.js";
import { GroundlaneError } from "../core/errors.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const webContentInputSchema = z.object({
  url: z.string().trim().url().max(2_048),
  maxContentChars: z.number().int().min(1).max(200_000).default(20_000),
  provider: z.enum(["auto", ...CONTENT_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(CONTENT_PROVIDER_IDS)).min(1).max(CONTENT_PROVIDER_IDS.length).optional(),
  strategy: z.enum(["fallback", "parallel"]).default("parallel"),
  live: z.boolean().default(false),
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

const contentDataSchema = z.object({
  url: z.string(),
  strategy: z.enum(["fallback", "parallel"]),
  providersSelected: z.array(z.enum(CONTENT_PROVIDER_IDS)),
  providersAttempted: z.array(z.enum(CONTENT_PROVIDER_IDS)),
  providersSucceeded: z.array(z.enum(CONTENT_PROVIDER_IDS)),
  contents: z.array(z.object({
    provider: z.enum(CONTENT_PROVIDER_IDS),
    url: z.string(),
    finalUrl: z.string(),
    title: z.string().optional(),
    content: z.string(),
    format: z.enum(["markdown", "text"]),
    truncated: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebContentModuleOptions {
  router: ContentRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertContentOutputWithinLimit(result: ContentResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_content", "Content output exceeds the configured limit");
  }
}

export function createWebContentModule(options: WebContentModuleOptions): McpModule {
  return {
    name: "web_content",
    register(server: McpServer): void {
      server.registerTool(
        "web_content",
        {
          description:
            "Fetch URL content through content-capable providers. Parallel mode fans out across configured provider Contents/Extract/Scrape/Fetch APIs and returns attributed provider content.",
          inputSchema: webContentInputSchema,
          outputSchema: resultEnvelopeSchema(contentDataSchema),
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
                    options.router.fetchContent(
                      {
                        url: input.url,
                        maxContentChars: input.maxContentChars,
                        provider: input.provider,
                        strategy: input.strategy,
                        live: input.live,
                        ...(input.providers === undefined ? {} : { providers: input.providers }),
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "web_content",
                ),
            );
            assertContentOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
