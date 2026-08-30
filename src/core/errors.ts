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

// Machine-readable hint identifier. Callers (human UIs or downstream agents) can
// look up the code in their own i18n table or branch on it directly. The text
// below is the en-US fallback; consumers SHOULD prefer hintCode when available.
export interface HintValue {
  code: string;
  text: string;
  // Optional map of BCP-47 locale tag to translated message. Populated by
  // operators (e.g. README translations, hosted dashboards) — Groundlane does
  // not provide any locale beyond the en-US `text` field.
  localized?: Record<string, string>;
}

// Convenience builder so throw sites do not repeat the same object literal.
// Throw sites pass a stable machine code plus a human-friendly text. Localized
// translations are appended by operators, not here.
export function hint(code: string, text: string): HintValue {
  return { code, text };
}

export class GroundlaneError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly stage: string,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
    readonly hint: HintValue | undefined = undefined,
  ) {
    super(message, options);
    this.name = "GroundlaneError";
  }
}

export function toGroundlaneError(error: unknown, stage = "unknown"): GroundlaneError {
  if (error instanceof GroundlaneError) return error;
  return new GroundlaneError("UPSTREAM_ERROR", stage, "The upstream operation failed", true);
}