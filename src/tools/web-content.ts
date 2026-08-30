import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ContentResult } from "../core/contracts.js";
import { ContentRouter, CONTENT_PROVIDER_IDS } from "../core/content-router.js";
import { GroundlaneError } from "../core/errors.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

// Suffixes the content providers cannot meaningfully parse: PDFs / archives / images
// return base64 garbage and burn tokens before hitting OUTPUT_LIMIT. Bail early and
// tell the caller to use web_fetch + local OCR / image tooling instead.
const BINARY_URL_SUFFIXES = [".pdf", ".zip", ".tar", ".gz", ".png", ".jpg", ".jpeg", ".webp"] as const;

function detectBinarySuffix(url: string): string | undefined {
  try {
    // Match either ".pdf" (typical file name) or a bare "pdf" trailing segment
    // (e.g. /patent/.../en/pdf used by Google Patents). Excluding the query string
    // is important — ?file=whitepaper.pdf must not be treated as a PDF request.
    const lastSegment = new URL(url).pathname.split("/").pop()?.toLowerCase() ?? "";
    return BINARY_URL_SUFFIXES.find((suffix) => lastSegment.endsWith(suffix) || lastSegment === suffix.slice(1));
  } catch {
    return undefined;
  }
}

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
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Specify either provider or providers, not both" });
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
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "web_content",
      "Content output exceeds the configured limit",
      true,
      undefined,
      {
        code: "web_content.output_too_large",
        text: "Lower maxContentChars, drop to a single provider, or switch strategy to 'fallback'. The current call aggregated output from multiple providers which exceeded the bound.",
      },
    );
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
            const binarySuffix = detectBinarySuffix(input.url);
            if (binarySuffix !== undefined) {
              throw new GroundlaneError(
                "INVALID_INPUT",
                "web_content",
                `URL targets a binary resource (${binarySuffix}); web_content cannot parse it`,
                false,
                undefined,
                {
                  code: "web_content.binary_url",
                  text: "Use web_fetch for HTML pages, or download the file directly with curl + local OCR / image tooling for PDFs and images.",
                },
              );
            }
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