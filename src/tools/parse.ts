import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { parseDocument } from "../core/parse-document.js";
import type { FetchPipeline } from "../core/fetch-pipeline.js";
import { Deadline, type ConcurrencyLimiter } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const purposeSchema = z.enum(["document", "metadata", "links", "media", "tables", "all"]);

const inputSchema = z
  .object({
    url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "Only HTTP and HTTPS URLs are allowed",
    }).optional(),
    html: z.string().min(1).max(2_000_000).optional(),
    baseUrl: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "Only HTTP and HTTPS base URLs are allowed",
    }).optional(),
    purpose: purposeSchema.default("all"),
    render: z.enum(["auto", "never", "always"]).default("auto"),
    waitFor: z.string().trim().min(1).max(500).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    maxBytes: z.number().int().min(1_024).max(20_000_000).optional(),
    maxOutputChars: z.number().int().min(1_000).max(500_000).optional(),
  })
  .superRefine((value, context) => {
    if ((value.url === undefined) === (value.html === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of url or html is required",
        path: ["url"],
      });
    }
    if (value.html !== undefined && value.baseUrl === undefined) {
      context.addIssue({
        code: "custom",
        message: "baseUrl is required when parsing raw html",
        path: ["baseUrl"],
      });
    }
  });

const linkSchema = z.object({
  url: z.string(),
  text: z.string().optional(),
  rel: z.string().optional(),
  internal: z.boolean(),
});

const imageSchema = z.object({
  url: z.string(),
  alt: z.string().optional(),
  title: z.string().optional(),
});

const tableSchema = z.object({
  caption: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const parseDataSchema = z.object({
  requestedUrl: z.string().optional(),
  finalUrl: z.string().optional(),
  purpose: purposeSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  canonicalUrl: z.string().optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  links: z.array(linkSchema).optional(),
  images: z.array(imageSchema).optional(),
  tables: z.array(tableSchema).optional(),
  engine: z.enum(["http", "reader", "browser"]).optional(),
  backend: z.string().optional(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  fallbackReason: z.string().optional(),
});

export interface ParseModuleOptions {
  pipeline: FetchPipeline;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputChars: number;
}

export function createParseModule(options: ParseModuleOptions): McpModule {
  return {
    name: "parse",
    register(server: McpServer): void {
      server.registerTool(
        "parse",
        {
          description:
            "Parse a fetched public page or caller-provided HTML into document, metadata, links, media, or table structures. URL inputs use Groundlane's bounded fetch pipeline; raw HTML inputs are parsed locally.",
          inputSchema,
          outputSchema: resultEnvelopeSchema(parseDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const started = performance.now();
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const maxOutputChars = Math.min(
              input.maxOutputChars ?? options.maxOutputChars,
              options.maxOutputChars,
            );
            const result = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              async () => {
                if (input.url !== undefined) {
                  const page = await options.pipeline.fetch(
                    {
                      url: input.url,
                      format: "html",
                      render: input.render,
                      maxBytes: Math.min(
                        input.maxBytes ?? options.maxResponseBytes,
                        options.maxResponseBytes,
                      ),
                      maxOutputChars: options.maxResponseBytes,
                      maxRedirects: 5,
                      deadline,
                      ...(input.waitFor === undefined ? {} : { waitFor: input.waitFor }),
                    },
                    extra.signal,
                  );
                  const parsed = parseDocument(page.content, {
                    purpose: input.purpose,
                    baseUrl: page.raw.finalUrl,
                    maxOutputChars,
                  });
                  return { page, parsed };
                }
                const parsed = parseDocument(input.html ?? "", {
                  purpose: input.purpose,
                  baseUrl: input.baseUrl ?? "https://example.com/",
                  maxOutputChars,
                });
                return { parsed };
              },
            );
            const data = {
              ...(input.url === undefined ? {} : { requestedUrl: input.url }),
              ...(result.page === undefined ? {} : { finalUrl: result.page.raw.finalUrl }),
              ...result.parsed,
              ...(result.page === undefined ? {} : { engine: result.page.raw.engine }),
              ...(result.page === undefined ? {} : { backend: result.page.raw.backend }),
              bytes: result.page?.bytes ?? new TextEncoder().encode(input.html ?? "").byteLength,
              durationMs: Math.round(performance.now() - started),
              warnings: [
                ...result.parsed.warnings,
                ...(result.page?.warnings ?? []),
              ],
              ...(result.page?.fallbackReason === undefined
                ? {}
                : { fallbackReason: result.page.fallbackReason }),
            };
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "parse" });
          }
        },
      );
    },
  };
}
