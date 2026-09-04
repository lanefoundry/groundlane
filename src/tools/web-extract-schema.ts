import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BenchmarkThresholds } from "../core/schema-extraction-contract.js";
import {
  runSchemaExtraction,
  type SchemaExtractionProvider,
} from "../core/schema-extraction-runtime.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const webExtractSchemaInputSchema = z.object({
  url: z.string().trim().url().max(2_048),
  schema: z.record(z.string(), z.unknown()),
  providerBacked: z.literal(true),
  provider: z.string().trim().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxOutputChars: z.number().int().min(1).max(100_000).optional(),
});

const schemaExtractDataSchema = z.object({
  fields: z.array(z.object({
    name: z.string(),
    status: z.enum(["present", "missing", "invalid"]),
    value: z.unknown().optional(),
    reason: z.string().optional(),
  })),
  provenance: z.object({
    provider: z.string(),
    model: z.string(),
    source: z.string(),
    billedUnits: z.number(),
  }),
  warnings: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
  truncated: z.boolean(),
  digest: z.string(),
});

const DEFAULT_BENCHMARK_THRESHOLDS: BenchmarkThresholds = {
  minRepeatability: 0.9,
  maxLatencyMs: 5_000,
  minFieldAccuracy: 0.85,
  minEntries: 20,
};

export interface WebExtractSchemaModuleOptions {
  providers: readonly SchemaExtractionProvider[];
  defaultProvider?: string;
  /** Null until a benchmark report passes the gate; provider availability
   *  alone never enables production routing. */
  benchmarkReport?: import("../core/schema-extraction-contract.js").ExtractionBenchmarkReport | null;
  thresholds?: BenchmarkThresholds;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

/**
 * Provider-backed schema extraction (PRD 652). Single known URL plus a
 * caller-provided bounded schema, explicit opt-in, Groundlane-side output
 * validation with missing/invalid fields and provider/model/source/billing
 * provenance. Production routing stays closed until a benchmark report
 * passes the repeatability/accuracy/latency gate.
 */
export function createWebExtractSchemaModule(options: WebExtractSchemaModuleOptions): McpModule {
  return {
    name: "web_extract_schema",
    register(server: McpServer): void {
      server.registerTool(
        "web_extract_schema",
        {
          description:
            "Extract structured fields from a single known URL against a caller-provided bounded schema using a provider model. Explicit opt-in only; remote $ref and unbounded nesting are rejected. Closed until the extraction benchmark gate passes.",
          inputSchema: webExtractSchemaInputSchema,
          outputSchema: resultEnvelopeSchema(schemaExtractDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const outcome = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  (signal) =>
                    runSchemaExtraction(
                      {
                        url: input.url,
                        schema: input.schema,
                        providerBacked: true,
                        ...(input.provider === undefined ? {} : { provider: input.provider }),
                        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                        ...(input.maxOutputChars === undefined
                          ? {}
                          : { maxOutputChars: input.maxOutputChars }),
                      },
                      {
                        providers: options.providers,
                        ...(options.defaultProvider === undefined
                          ? {}
                          : { defaultProvider: options.defaultProvider }),
                        benchmarkReport: options.benchmarkReport ?? null,
                        thresholds: options.thresholds ?? DEFAULT_BENCHMARK_THRESHOLDS,
                      },
                      signal,
                    ),
                  deadline,
                  extra.signal,
                  "web_extract_schema",
                ),
            );
            const data = {
              fields: outcome.result.fields.map((field) => ({
                name: field.name,
                status: field.status,
                ...(field.value === undefined ? {} : { value: field.value }),
                ...(field.reason === undefined ? {} : { reason: field.reason }),
              })),
              provenance: {
                provider: outcome.result.provenance.provider,
                model: outcome.result.provenance.model,
                source: outcome.result.provenance.source,
                billedUnits: outcome.result.provenance.billedUnits,
              },
              warnings: [...outcome.warnings],
              durationMs: outcome.durationMs,
              truncated: outcome.truncated,
              digest: outcome.digest,
            };
            if (Array.from(JSON.stringify(data)).length > options.maxOutputChars) {
              throw new Error(
                "web_extract_schema output exceeds the configured limit; narrow the schema or maxOutputChars",
              );
            }
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "web_extract_schema" });
          }
        },
      );
    },
  };
}
