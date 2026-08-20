import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { extractFields } from "../core/extract-fields.js";
import type { FetchPipeline } from "../core/fetch-pipeline.js";
import { Deadline, type ConcurrencyLimiter } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const fieldSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
    selector: z.string().trim().min(1).max(500),
    value: z.enum(["text", "html", "attribute"]).default("text"),
    attribute: z.string().trim().min(1).max(128).optional(),
    many: z.boolean().default(false),
  })
  .refine((field) => field.value !== "attribute" || field.attribute !== undefined, {
    message: "attribute is required when value is attribute",
  });

const inputSchema = z.object({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Only HTTP and HTTPS URLs are allowed",
  }),
  fields: z.array(fieldSchema).min(1).max(50),
  waitFor: z.string().trim().min(1).max(500).optional(),
  render: z.enum(["auto", "never", "always"]).default("auto"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxBytes: z.number().int().min(1_024).max(20_000_000).optional(),
});

const extractDataSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  data: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  engine: z.enum(["http", "reader", "browser"]),
  backend: z.string(),
  missingFields: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
});

export interface WebExtractModuleOptions {
  pipeline: FetchPipeline;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputChars: number;
}

export function createWebExtractModule(options: WebExtractModuleOptions): McpModule {
  return {
    name: "web_extract",
    register(server: McpServer): void {
      server.registerTool(
        "web_extract",
        {
          description:
            "Extract deterministic structured fields from a public page with CSS selectors. No LLM inference is performed.",
          inputSchema,
          outputSchema: resultEnvelopeSchema(extractDataSchema),
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
              async () => {
                const page = await options.pipeline.fetch(
                  {
                    url: input.url,
                    format: "html",
                    render: input.render,
                    maxBytes: Math.min(input.maxBytes ?? options.maxResponseBytes, options.maxResponseBytes),
                    maxOutputChars: options.maxResponseBytes,
                    maxRedirects: 5,
                    deadline,
                    ...(input.waitFor === undefined ? {} : { waitFor: input.waitFor }),
                  },
                  extra.signal,
                );
                const fields = input.fields.map((field) => ({
                  name: field.name,
                  selector: field.selector,
                  value: field.value,
                  many: field.many,
                  ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
                }));
                const extracted = extractFields(page.content, fields, {
                  maxFields: 50,
                  maxValuesPerField: 100,
                  maxOutputChars: options.maxOutputChars,
                });
                return { page, extracted };
              },
            );
            const data = {
              requestedUrl: input.url,
              finalUrl: result.page.raw.finalUrl,
              data: result.extracted.data,
              engine: result.page.raw.engine,
              backend: result.page.raw.backend,
              missingFields: result.extracted.missingFields,
              durationMs: Math.round(performance.now() - started),
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
