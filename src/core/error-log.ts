// Server-side error log: a sink that any throw site can call before/after
// producing a GroundlaneError. The CloudflareErrorSink writes one row to
// Analytics Engine; the NoopErrorSink is the default when the binding is
// not configured (local dev, tests, single-instance deployments without
// the operator binding).

import type { GroundlaneError } from "./errors.js";

/** Subset of AnalyticsEngineDataset.writeDataPoint exposed for tests. */
export interface AnalyticsEngineWriter {
  writeDataPoint(event?: {
    blobs?: readonly string[];
    doubles?: readonly number[];
    indexes?: readonly string[];
  }): void;
}

/** One persisted error event. Independent of ErrorLogEntry in
 *  examples/groundlane-debug.ts so server and client can evolve separately. */
export interface PersistedErrorEvent {
  id: string;
  timestamp: string;
  tool: string;
  code: string;
  stage: string;
  hintCode: string | undefined;
  message: string;
  retryable: boolean;
  latencyMs: number;
}

/** Pluggable sink. Tool handlers call record() after a failed call returns. */
export interface ErrorLogSink {
  record(event: PersistedErrorEvent): void;
  /** Best-effort: query recent events. May be unsupported by some sinks. */
  query?(filter: { tool?: string; code?: string; since?: Date; limit?: number }): Promise<readonly PersistedErrorEvent[]>;
}
export class NoopErrorSink implements ErrorLogSink {
  record(): void {
    // intentionally empty
  }
  query(): Promise<readonly PersistedErrorEvent[]> {
    return Promise.resolve([]);
  }
}
/** Writes to a Cloudflare Analytics Engine dataset. */
export class CloudflareErrorSink implements ErrorLogSink {
  constructor(private readonly dataset: AnalyticsEngineWriter) {}

  record(event: PersistedErrorEvent): void {
    this.dataset.writeDataPoint({
      // Blob 1-9 (Analytics Engine allows up to 20 blobs; we use 8).
      blobs: [
        event.tool,
        event.code,
        event.stage,
        event.hintCode ?? "",
        event.message.slice(0, 256),  // bound message length
        event.retryable ? "1" : "0",
        event.id,
        "",  // reserved blob 8
      ],
      doubles: [event.latencyMs],
      indexes: [event.timestamp],
    });
  }
}

/** Build a PersistedErrorEvent from a tool call context + result error. */
export function buildPersistedErrorEvent(args: {
  tool: string;
  error: GroundlaneError;
  latencyMs: number;
  idFactory?: () => string;
  now?: () => Date;
}): PersistedErrorEvent {
  const id = args.idFactory ? args.idFactory() : makeId();
  return {
    id,
    timestamp: (args.now ? args.now() : new Date()).toISOString(),
    tool: args.tool,
    code: args.error.code,
    stage: args.error.stage,
    hintCode: args.error.hint?.code,
    message: args.error.message,
    retryable: args.error.retryable,
    latencyMs: args.latencyMs,
  };
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0x10000).toString(36).padStart(4, "0")}`;
}

/** Adapter from MCP call lifecycle to an ErrorLogSink. Returns a function
 *  that callers invoke after the tool returns or throws. The returned
 *  closure handles the latency measurement and persists failures. */
export function instrumentToolCall(
  sink: ErrorLogSink,
  tool: string,
  startedAt: number,
  now: () => number = () => Date.now(),
): (error: GroundlaneError) => void {
  return (error) => {
    sink.record(buildPersistedErrorEvent({
      tool,
      error,
      latencyMs: now() - startedAt,
    }));
  };
}
