import { z } from "zod";

import { toGroundlaneError } from "../core/errors.js";
import type { ConcurrencyLimiter, Deadline } from "../core/limits.js";
import { structuredToolError } from "../mcp/results.js";

// Public wire shape for the error hint. Code + text are required; localized is
// optional and only present when an operator has registered translations for
// the code.
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

export function toolError(error: unknown) {
  const safe = toGroundlaneError(error);
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