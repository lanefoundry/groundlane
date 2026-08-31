import { z } from "zod";

import { toGroundlaneError, type GroundlaneError } from "../core/errors.js";
import { buildPersistedErrorEvent, type ErrorLogSink } from "../core/error-log.js";
import type { ConcurrencyLimiter, Deadline } from "../core/limits.js";
import { structuredToolError } from "../mcp/results.js";

export const publicHintSchema = z.object({
  code: z.string().min(1),
  text: z.string().min(1),
  localized: z.record(z.string(), z.string()).optional(),
});

export const publicErrorSchema = z.object({
  code: z.string(),
  stage: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  hint: publicHintSchema.optional(),
});

export function resultEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.boolean(),
    data: dataSchema.optional(),
    error: publicErrorSchema.optional(),
  });
}

export interface ToolErrorContext {
  tool: string;
  /** Wall-clock latency in ms. Omitted if not measured. */
  latencyMs?: number;
}

// Module-level sink registry. The container sets this once at startup
// based on whether the Analytics Engine binding is present; every tool
// shares the same sink without threading it through module options.
let moduleSink: ErrorLogSink | undefined;

export function setErrorLogSink(sink: ErrorLogSink | undefined): void {
  moduleSink = sink;
}

export function getErrorLogSink(): ErrorLogSink | undefined {
  return moduleSink;
}

export function toolError(error: unknown, ctx: ToolErrorContext = { tool: "unknown" }) {
  const safe: GroundlaneError = toGroundlaneError(error);
  const sink = moduleSink;
  if (sink !== undefined) {
    try {
      sink.record(buildPersistedErrorEvent({
        tool: ctx.tool,
        error: safe,
        latencyMs: ctx.latencyMs ?? 0,
      }));
    } catch {
      // Sink failure must not affect the user-facing envelope.
    }
  }
  const value = {
    ok: false,
    error: {
      code: safe.code,
      stage: safe.stage,
      message: safe.message,
      retryable: safe.retryable,
      ...(safe.hint === undefined ? {} : { hint: safe.hint }),
    },
  };
  return structuredToolError(value);
}

export async function withConcurrency<T>(
  limiter: ConcurrencyLimiter,
  deadline: Deadline,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await limiter.acquire(deadline, signal);
  try {
    return await operation();
  } finally {
    release();
  }
}