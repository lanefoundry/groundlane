import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ErrorLogSink, PersistedErrorEvent } from "../core/error-log.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema } from "./common.js";

export const errorLogInputSchema = z.object({
  tool: z.string().trim().min(1).max(64).optional(),
  code: z.string().trim().min(1).max(64).optional(),
  hintCode: z.string().trim().min(1).max(128).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const errorLogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  tool: z.string(),
  code: z.string(),
  stage: z.string(),
  hintCode: z.string().optional(),
  message: z.string(),
  retryable: z.boolean(),
  latencyMs: z.number(),
});

const errorLogDataSchema = z.object({
  entries: z.array(errorLogEntrySchema),
  count: z.number().int().nonnegative(),
  queryable: z.boolean(),
});

export interface ErrorLogModuleOptions {
  sink: ErrorLogSink;
  /** Operator-supplied SQL query bridge. Undefined for local dev; when set,
   *  the tool issues SQL against Analytics Engine via the Cloudflare REST API
   *  using accountId and apiToken. */
  cloudflareQuery:
    | { accountId: string; apiToken: string; dataset: string }
    | undefined;
}

export function createErrorLogModule(options: ErrorLogModuleOptions): McpModule {
  return {
    name: "error_log",
    register(server: McpServer): void {
      server.registerTool(
        "error_log",
        {
          description:
            "Operator-only: query the Groundlane error log (Cloudflare Analytics Engine). Filter by tool, code, hintCode, or since. Returns up to `limit` most recent matching events newest first.",
          inputSchema: errorLogInputSchema,
          outputSchema: resultEnvelopeSchema(errorLogDataSchema),
        },
        async (input) => {
          const filter = {
            ...(input.tool === undefined ? {} : { tool: input.tool }),
            ...(input.code === undefined ? {} : { code: input.code }),
            ...(input.hintCode === undefined ? {} : { hintCode: input.hintCode }),
            ...(input.since === undefined ? {} : { since: new Date(input.since) }),
            limit: input.limit,
          };
          const raw: readonly PersistedErrorEvent[] = options.sink.query
            ? await options.sink.query(filter)
            : [];
          const entries = raw.map((e) => ({
            id: e.id,
            timestamp: e.timestamp,
            tool: e.tool,
            code: e.code,
            stage: e.stage,
            ...(e.hintCode === undefined ? {} : { hintCode: e.hintCode }),
            message: e.message,
            retryable: e.retryable,
            latencyMs: e.latencyMs,
          }));
          return structuredToolResult({
            ok: true,
            data: { entries, count: entries.length, queryable: options.sink.query !== undefined },
          });
        },
      );
    },
  };
}