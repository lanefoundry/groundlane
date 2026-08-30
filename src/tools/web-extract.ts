import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ExtractionField } from "../core/contracts.js";
import { extractFields } from "../core/extract-fields.js";
import type { FetchPipeline } from "../core/fetch-pipeline.js";
import { Deadline, type ConcurrencyLimiter } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const selectorFieldSchema = z
  .object({
    engine: z.literal("selector").default("selector"),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
    selector: z.string().trim().min(1).max(500),
    value: z.enum(["text", "html", "attribute"]).default("text"),
    attribute: z.string().trim().min(1).max(128).optional(),
    many: z.boolean().default(false),
  })
  .refine((field) => field.value !== "attribute" || field.attribute !== undefined, {
    message: "attribute is required when value is attribute",
  });

const patternFieldSchema = z.object({
  engine: z.literal("pattern"),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  pattern: z.string().min(1).max(500),
  flags: z.string().regex(/^[imus]*$/u).optional(),
  group: z.union([z.string().trim().min(1).max(128), z.number().int().min(0).max(100)]).optional(),
  many: z.boolean().default(false),
});

const fieldSchema = z.union([selectorFieldSchema, patternFieldSchema]);

const inputSchema = z.object({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Only HTTP and HTTPS URLs are allowed",
  }),
  fields: z.array(fieldSchema).min(1).max(50),
  waitFor: z.string().trim().min(1).max(500).optional(),
  render: z.enum(["auto", "never", "always"]).default("auto"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxBytes: z.number().int().min(1_024).max(20_000_000).optional(),
  maxOutputChars: z.number().int().min(1_000).max(500_000).optional(),
});

const extractDataSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  data: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  engine: z.enum(["http", "reader", "browser"]),
  backend: z.string(),
  missingFields: z.array(z.string()),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
  blockedSubrequests: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  fallbackReason: z.string().optional(),
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
            "Extract deterministic structured fields from a public page with selector or bounded pattern engines. No LLM inference is performed.",
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
                const fields: ExtractionField[] = input.fields.map((field) => {
                  if (field.engine === "pattern") {
                    return {
                      engine: "pattern",
                      name: field.name,
                      pattern: field.pattern,
                      many: field.many,
                      ...(field.flags === undefined ? {} : { flags: field.flags }),
                      ...(field.group === undefined ? {} : { group: field.group }),
                    };
                  }
                  return {
                    engine: "selector",
                    name: field.name,
                    selector: field.selector,
                    value: field.value,
                    many: field.many,
                    ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
                  };
                });
                const extracted = extractFields(page.content, fields, {
                  maxFields: 50,
                  maxValuesPerField: 100,
                  maxOutputChars: Math.min(
                    input.maxOutputChars ?? options.maxOutputChars,
                    options.maxOutputChars,
                  ),
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
              truncated: result.page.truncated || result.extracted.truncated,
              bytes: result.page.bytes,
              ...(result.page.raw.blockedSubrequests === undefined
                ? {}
                : { blockedSubrequests: result.page.raw.blockedSubrequests }),
              durationMs: Math.round(performance.now() - started),
              warnings: result.page.warnings,
              ...(result.page.fallbackReason === undefined
                ? {}
                : { fallbackReason: result.page.fallbackReason }),
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
