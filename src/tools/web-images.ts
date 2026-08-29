import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ImagesResult } from "../core/contracts.js";
import { GroundlaneError } from "../core/errors.js";
import { IMAGES_PROVIDER_IDS, type ImagesRouter } from "../core/images-router.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const webImagesInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(50).default(10),
  provider: z.enum(["auto", ...IMAGES_PROVIDER_IDS]).default("auto"),
  providers: z.array(z.enum(IMAGES_PROVIDER_IDS)).min(1).max(IMAGES_PROVIDER_IDS.length).optional(),
  strategy: z.enum(["fallback", "parallel"]).default("parallel"),
  country: z.string().trim().length(2).optional(),
  language: z.string().trim().length(2).optional(),
  safeSearch: z.enum(["off", "moderate", "strict"]).default("moderate"),
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

const imageItemSchema = z.object({
  title: z.string(),
  imageUrl: z.string(),
  sourceUrl: z.string(),
  thumbnailUrl: z.string().optional(),
  source: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  thumbnailWidth: z.number().int().positive().optional(),
  thumbnailHeight: z.number().int().positive().optional(),
  provider: z.enum(IMAGES_PROVIDER_IDS),
});

const imagesDataSchema = z.object({
  query: z.string(),
  strategy: z.enum(["fallback", "parallel"]),
  providersSelected: z.array(z.enum(IMAGES_PROVIDER_IDS)),
  providersAttempted: z.array(z.enum(IMAGES_PROVIDER_IDS)),
  providersSucceeded: z.array(z.enum(IMAGES_PROVIDER_IDS)),
  results: z.array(imageItemSchema),
  providerResults: z.array(z.object({
    provider: z.enum(IMAGES_PROVIDER_IDS),
    query: z.string(),
    results: z.array(imageItemSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export interface WebImagesModuleOptions {
  router: ImagesRouter;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function assertImagesOutputWithinLimit(result: ImagesResult, maxOutputChars: number): void {
  if (Array.from(JSON.stringify(result)).length > maxOutputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_images", "Images output exceeds the configured limit");
  }
}

export function createWebImagesModule(options: WebImagesModuleOptions): McpModule {
  return {
    name: "web_images",
    register(server: McpServer): void {
      server.registerTool(
        "web_images",
        {
          description:
            "Search image-specific provider indexes. Parallel mode fans out across configured images APIs and returns attributed image results.",
          inputSchema: webImagesInputSchema,
          outputSchema: resultEnvelopeSchema(imagesDataSchema),
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
                    options.router.images(
                      {
                        query: input.query,
                        maxResults: input.maxResults,
                        provider: input.provider,
                        strategy: input.strategy,
                        safeSearch: input.safeSearch,
                        ...(input.providers === undefined ? {} : { providers: input.providers }),
                        ...(input.country === undefined ? {} : { country: input.country }),
                        ...(input.language === undefined ? {} : { language: input.language }),
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "web_images",
                ),
            );
            assertImagesOutputWithinLimit(result, options.maxOutputChars);
            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
