import { z } from "zod";

import { toGroundlaneError } from "../core/errors.js";
import type { ConcurrencyLimiter, Deadline } from "../core/limits.js";
import { structuredToolError } from "../mcp/results.js";

export const publicErrorSchema = z.object({
  code: z.string(),
  stage: z.string(),
  message: z.string(),
  retryable: z.boolean(),
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
