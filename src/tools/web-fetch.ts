import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { FetchPipeline } from "../core/fetch-pipeline.js";
import { Deadline, type ConcurrencyLimiter } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const inputSchema = z.object({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Only HTTP and HTTPS URLs are allowed",
  }),
  format: z.enum(["markdown", "text", "html"]).default("markdown"),
  selector: z.string().trim().min(1).max(500).optional(),
  waitFor: z.string().trim().min(1).max(500).optional(),
  render: z.enum(["auto", "never", "always"]).default("auto"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxBytes: z.number().int().min(1_024).max(20_000_000).optional(),
  maxOutputChars: z.number().int().min(1_000).max(500_000).optional(),
});

const fetchDataSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  status: z.number().int(),
  contentType: z.string(),
  title: z.string().optional(),
  content: z.string(),
  format: z.enum(["markdown", "text", "html"]),
  engine: z.enum(["http", "reader", "browser"]),
  backend: z.string(),
  cached: z.boolean(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
  blockedSubrequests: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  fallbackReason: z.string().optional(),
});

export interface WebFetchModuleOptions {
  pipeline: FetchPipeline;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputChars: number;
}

export function createWebFetchModule(options: WebFetchModuleOptions): McpModule {
  return {
    name: "web_fetch",
    register(server: McpServer): void {
      server.registerTool(
        "web_fetch",
        {
          description:
            "Fetch a public HTTP(S) page as bounded Markdown, text, or HTML. Uses safe HTTP first, then configured Reader/browser fallbacks only when eligible and needed.",
          inputSchema,
          outputSchema: resultEnvelopeSchema(fetchDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const started = performance.now();
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                options.pipeline.fetch(
                  {
                    url: input.url,
                    format: input.format,
                    render: input.render,
                    maxBytes: Math.min(input.maxBytes ?? options.maxResponseBytes, options.maxResponseBytes),
                    maxOutputChars: Math.min(
                      input.maxOutputChars ?? options.maxOutputChars,
                      options.maxOutputChars,
                    ),
                    maxRedirects: 5,
                    deadline,
                    ...(input.selector === undefined ? {} : { selector: input.selector }),
                    ...(input.waitFor === undefined ? {} : { waitFor: input.waitFor }),
                  },
                  extra.signal,
                ),
            );
            const data = {
              requestedUrl: input.url,
              finalUrl: result.raw.finalUrl,
              status: result.raw.status,
              contentType: result.raw.contentType,
              ...(result.title === undefined ? {} : { title: result.title }),
              content: result.content,
              format: result.format,
              engine: result.raw.engine,
              backend: result.raw.backend,
              cached: false,
              truncated: result.truncated,
              bytes: result.bytes,
              ...(result.raw.blockedSubrequests === undefined
                ? {}
                : { blockedSubrequests: result.raw.blockedSubrequests }),
              durationMs: Math.round(performance.now() - started),
              warnings: result.warnings,
              ...(result.fallbackReason === undefined
                ? {}
                : { fallbackReason: result.fallbackReason }),
            };
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
