import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { MapResult } from "../core/contracts.js";
import { GroundlaneError } from "../core/errors.js";
import { MAP_PROVIDER_IDS, type MapRouter } from "../core/map-router.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const webMapInputSchema = z.object({
  url: z.string().trim().url().max(2_048),
  maxLinks: z.number().int().min(1).max(1_000).default(50),
  provider: z.enum(["auto", ...MAP_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(MAP_PROVIDER_IDS)).min(1).max(MAP_PROVIDER_IDS.length).optional(),
  strategy: z.enum(["fallback", "parallel"]).default("parallel"),
  search: z.string().trim().min(1).max(500).optional(),
  includeSubdomains: z.boolean().optional(),
  ignoreCache: z.boolean().default(false),
  maxDepth: z.number().int().min(1).max(5).default(1),
  maxBreadth: z.number().int().min(1).max(500).default(20),
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

const mapLinkSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  provider: z.enum(MAP_PROVIDER_IDS),
});

const mapDataSchema = z.object({
  url: z.string(),
  strategy: z.enum(["fallback", "parallel"]),
  providersSelected: z.array(z.enum(MAP_PROVIDER_IDS)),
  providersAttempted: z.array(z.enum(MAP_PROVIDER_IDS)),
  providersSucceeded: z.array(z.enum(MAP_PROVIDER_IDS)),
  links: z.array(mapLinkSchema),
  providerResults: z.array(z.object({
    provider: z.enum(MAP_PROVIDER_IDS),
    url: z.string(),
    links: z.array(mapLinkSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebMapModuleOptions {
  router: MapRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertMapOutputWithinLimit(result: MapResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_map", "Map output exceeds the configured limit", false, undefined, { code: "web_map.output_too_large", text: "Lower maxOutputChars or reduce maxLinks so the map returns fewer discovered URLs." });
  }
}

export function createWebMapModule(options: WebMapModuleOptions): McpModule {
  return {
    name: "web_map",
    register(server: McpServer): void {
      server.registerTool(
        "web_map",
        {
          description:
            "Discover URLs from a public site through map-capable providers. Parallel mode fans out across configured provider map APIs and returns attributed links.",
          inputSchema: webMapInputSchema,
          outputSchema: resultEnvelopeSchema(mapDataSchema),
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
                    options.router.map(
                      {
                        url: input.url,
                        maxLinks: input.maxLinks,
                        provider: input.provider,
                        strategy: input.strategy,
                        ignoreCache: input.ignoreCache,
                        maxDepth: input.maxDepth,
                        maxBreadth: input.maxBreadth,
                        ...(input.providers === undefined ? {} : { providers: input.providers }),
                        ...(input.search === undefined ? {} : { search: input.search }),
                        ...(input.includeSubdomains === undefined
                          ? {}
                          : { includeSubdomains: input.includeSubdomains }),
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "web_map",
                ),
            );
            assertMapOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
