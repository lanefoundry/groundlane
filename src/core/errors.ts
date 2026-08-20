export type ErrorCode =
  | "INVALID_INPUT"
  | "URL_BLOCKED"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "OUTPUT_LIMIT"
  | "CONCURRENCY_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR";

export class GroundlaneError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly stage: string,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GroundlaneError";
  }
}

export function toGroundlaneError(error: unknown, stage = "unknown"): GroundlaneError {
  if (error instanceof GroundlaneError) return error;
  return new GroundlaneError("UPSTREAM_ERROR", stage, "The upstream operation failed", true);
}
