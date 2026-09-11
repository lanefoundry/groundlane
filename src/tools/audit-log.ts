import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { InMemoryAuditLog } from "../core/audit-log.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError } from "./common.js";

const auditLogInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  tool: z.string().trim().min(1).max(100).optional(),
});

const auditEntrySchema = z.object({
  timestamp: z.string(),
  tool: z.string(),
  inputHash: z.string(),
  durationMs: z.number(),
  status: z.enum(["ok", "error"]),
  errorCode: z.string().optional(),
});

const auditLogDataSchema = z.object({
  entries: z.array(auditEntrySchema),
  totalCount: z.number().int(),
  byTool: z.record(z.string(), z.number().int()),
  byStatus: z.object({ ok: z.number().int(), error: z.number().int() }),
});

export interface AuditLogModuleOptions {
  auditLog: InMemoryAuditLog;
}

export function createAuditLogModule(options: AuditLogModuleOptions): McpModule {
  return {
    name: "audit_log",
    register(server: McpServer): void {
      server.registerTool(
        "audit_log",
        {
          description:
            "Read the instance-local tool-call audit log. Returns recent tool invocations with tool name, input hash, duration, and status. Useful for debugging, observability, and spend tracking. The log is append-only and in-memory; it resets on restart.",
          inputSchema: auditLogInputSchema,
          outputSchema: resultEnvelopeSchema(auditLogDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        (input) => {
          try {
            let entries = options.auditLog.recent(input.limit);
            if (input.tool !== undefined) {
              entries = entries.filter((e) => e.tool === input.tool);
            }
            return structuredToolResult({
              ok: true,
              data: {
                entries,
                totalCount: options.auditLog.count(),
                byTool: options.auditLog.countByTool(),
                byStatus: options.auditLog.countByStatus(),
              },
            });
          } catch (error) {
            return toolError(error, { tool: "audit_log" });
          }
        },
      );
    },
  };
}
