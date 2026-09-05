import { z } from "zod";

import type { DurableDocumentOutputRuntime } from "../core/durable-document-output.js";
import { GroundlaneError } from "../core/errors.js";
import { Deadline, withinDeadline, type ConcurrencyLimiter } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export function createDocumentResultModule(
  runtime: Pick<DurableDocumentOutputRuntime, "save" | "read" | "delete">,
  caller: { ownerId: string; credentialBinding: string },
  limits: { limiter: ConcurrencyLimiter; requestTimeoutMs: number; maxOutputChars: number },
): McpModule {
  const identity = { tenantId: "self-hosted", ...caller };
  const refId = z.string().regex(/^art_[A-Za-z0-9_-]+$/u).max(180);
  const run = <T>(name: string, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const deadline = new Deadline(limits.requestTimeoutMs);
    return withConcurrency(limits.limiter, deadline, signal, () => withinDeadline(operation, deadline, signal, name));
  };
  const errorResult = (error: unknown, name: string) => toolError(
    error instanceof GroundlaneError && ["CANCELLED", "DEADLINE_EXCEEDED", "RATE_LIMITED"].includes(error.code)
      ? error : new GroundlaneError("INVALID_INPUT", name, "Document result is unavailable or the requested range is invalid", false),
  );
  return {
    name: "document_result",
    register(server) {
      server.registerTool("document_result_read", {
        description: "Read a bounded base64 byte chunk of a stored document result JSON. Concatenate decoded chunks before decoding UTF-8 and parsing JSON.",
        inputSchema: z.object({ refId, offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(49_152).default(24_576) }).strict(),
        outputSchema: resultEnvelopeSchema(z.object({ refId, dataBase64: z.string(), offset: z.number().int(), nextOffset: z.number().int().nullable(), totalBytes: z.number().int(), contentHash: z.string() }).strict()),
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, async (input, context) => {
        try {
          const maxBytes = Math.min(input.maxBytes, Math.max(1, Math.floor((limits.maxOutputChars - 500) * 3 / 4)));
          const data = await run("document_result_read", context.mcpReq.signal,
            (signal) => runtime.read(input.refId, identity, input.offset, maxBytes, signal));
          return structuredToolResult({ ok: true as const, data });
        } catch (error) {
          return errorResult(error, "document_result_read");
        }
      });
      server.registerTool("document_result_delete", {
        description: "Revoke a stored document result and remove its retained source and result bytes. Retry if physical cleanup is pending.",
        inputSchema: z.object({ refId }).strict(),
        outputSchema: resultEnvelopeSchema(z.object({ deleted: z.literal(true), cleanupPending: z.boolean() }).strict()),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      }, async (input, context) => {
        try {
          const data = await run("document_result_delete", context.mcpReq.signal,
            (signal) => runtime.delete(input.refId, identity, signal));
          return structuredToolResult({ ok: true as const, data });
        } catch (error) {
          return errorResult(error, "document_result_delete");
        }
      });
    },
  };
}
