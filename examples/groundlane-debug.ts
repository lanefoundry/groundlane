/**
 * Groundlane debug helper — client-side error recorder.
 *
 * Groundlane is a stateless MCP server: it does not persist error logs. To
 * debug "why did that call fail 5 minutes ago?", capture errors at the call
 * site. This module is a small, zero-dependency recorder that wraps any
 * Groundlane tool call and keeps the last N entries in memory.
 *
 * Usage:
 *
 *   import { ErrorRecorder, withErrorLog, formatEntry } from "./groundlane-debug.js";
 *
 *   const recorder = new ErrorRecorder();
 *   const result = await withErrorLog(recorder, "web_search",
 *     { query: "groundlane" },
 *     () => mcpClient.call("web_search", { query: "groundlane" }),
 *   );
 *
 *   // Inspect later:
 *   const recent = recorder.query({ since: new Date(Date.now() - 5 * 60_000) });
 *   for (const entry of recent) console.log(formatEntry(entry));
 *
 * Privacy: input.url keeps host + path only; query strings and credentials
 * are stripped. Add your own redaction if your tool calls carry secrets.
 */

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    stage: string;
    message: string;
    retryable: boolean;
    hint?: { code: string; text: string; localized?: Record<string, string> };
  };
}

export interface ErrorLogEntry {
  id: string;
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  error: {
    code: string;
    stage: string;
    message: string;
    hintCode?: string;
    retryable: boolean;
  };
  latencyMs: number;
}

export interface ErrorQuery {
  tool?: string;
  code?: string;
  hintCode?: string;
  since?: Date;
  limit?: number;
}

export class ErrorRecorder {
  private entries: ErrorLogEntry[] = [];
  private nextSeq = 0;

  constructor(private readonly maxEntries = 200) {}

  record(entry: Omit<ErrorLogEntry, "id">): ErrorLogEntry {
    const full: ErrorLogEntry = { ...entry, id: makeId(this.nextSeq++) };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return full;
  }

  query(filter: ErrorQuery = {}): ErrorLogEntry[] {
    const sinceMs = filter.since?.getTime();
    const limit = filter.limit ?? this.maxEntries;
    const out: ErrorLogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i]!;
      if (filter.tool !== undefined && e.tool !== filter.tool) continue;
      if (filter.code !== undefined && e.error.code !== filter.code) continue;
      if (filter.hintCode !== undefined && e.error.hintCode !== filter.hintCode) continue;
      if (sinceMs !== undefined) {
        if (Date.parse(e.timestamp) < sinceMs) continue;
      }
      out.push(e);
    }
    return out;
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  export(): readonly ErrorLogEntry[] {
    return [...this.entries];
  }
}

export async function withErrorLog<T>(
  recorder: ErrorRecorder,
  tool: string,
  input: unknown,
  fn: () => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  const start = Date.now();
  const safeInput = sanitizeInput(input);
  try {
    const result = await fn();
    const latencyMs = Date.now() - start;
    if (!result.ok && result.error !== undefined) {
      recorder.record({
        timestamp: new Date().toISOString(),
        tool,
        input: safeInput,
        error: {
          code: result.error.code,
          stage: result.error.stage,
          message: result.error.message,
          ...(result.error.hint?.code === undefined ? {} : { hintCode: result.error.hint.code }),
          retryable: result.error.retryable,
        },
        latencyMs,
      });
    }
    return result;
  } catch (cause) {
    const latencyMs = Date.now() - start;
    recorder.record({
      timestamp: new Date().toISOString(),
      tool,
      input: safeInput,
      error: {
        code: "UPSTREAM_ERROR",
        stage: tool,
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      },
      latencyMs,
    });
    throw cause;
  }
}

export function sanitizeInput(input: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4 || input === null || typeof input !== "object") {
    return input === null ? { value: null } : { value: input };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      out[key] = redactInlineUrls(value);
      continue;
    }
    out[key] = sanitizeInput(value, depth + 1);
  }
  return out;
}

const SECRET_KEYS = /(api_?key|token|secret|password|passwd|authorization|cookie|signature)/i;
const URL_PATTERN = /https?:\/\/[^\s)\]'",]+/g;

function redactInlineUrls(value: string): string {
  return value.replace(URL_PATTERN, (match) => redactUrl(match));
}

function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    u.search = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function formatEntry(e: ErrorLogEntry): string {
  const hint = e.error.hintCode ? ` hint=${e.error.hintCode}` : "";
  return `[${e.timestamp}] ${e.tool} -> ${e.error.code} (${e.error.stage}) ${e.latencyMs}ms${hint} :: ${e.error.message}`;
}

function makeId(seq: number): string {
  return `${Date.now().toString(36)}-${seq.toString(36).padStart(4, "0")}`;
}