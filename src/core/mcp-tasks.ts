import type {
  AsyncJobCaller,
  BillingUnits,
  ProviderCancelAcknowledgment,
} from "./async-lifecycle.js";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const DEFAULT_MCP_TASK_TTL_MS = 3_600_000;
export const DEFAULT_MCP_TASK_POLL_INTERVAL_MS = 5_000;

export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface McpTaskBase {
  readonly taskId: string;
  readonly status: McpTaskStatus;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
}

export type DetailedMcpTask =
  | (McpTaskBase & { readonly status: "working" })
  | (McpTaskBase & {
      readonly status: "input_required";
      readonly inputRequests: Record<string, unknown>;
    })
  | (McpTaskBase & {
      readonly status: "completed";
      readonly result: Record<string, unknown>;
    })
  | (McpTaskBase & {
      readonly status: "failed";
      readonly error: { readonly code: number; readonly message: string };
    })
  | (McpTaskBase & { readonly status: "cancelled" });

export interface AsyncTaskPollOutcome {
  readonly status: "working" | "input_required" | "completed" | "failed";
  readonly result?: Record<string, unknown>;
  readonly inputRequests?: Record<string, unknown>;
  readonly error?: string;
  readonly billing?: BillingUnits;
}

/** Provider-specific request/response mapping belongs in adapters. */
export interface AsyncTaskProviderPort<Input> {
  readonly id: string;
  parseInput(value: unknown): Input;
  create(input: Input, signal: AbortSignal): Promise<string>;
  poll(
    providerTaskId: string,
    input: Input,
    signal: AbortSignal,
  ): Promise<AsyncTaskPollOutcome>;
  update?(
    providerTaskId: string,
    inputResponses: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void>;
  cancel?(
    providerTaskId: string,
    signal: AbortSignal,
  ): Promise<ProviderCancelAcknowledgment | null>;
}

export interface StartMcpTaskOptions {
  readonly ttlMs?: number;
  readonly idempotencyKey?: string;
  readonly now?: Date;
}

export interface McpTaskOperationalDetails {
  readonly task: DetailedMcpTask;
  readonly billingProvenance:
    | { readonly providerId: string; readonly reported: false }
    | {
        readonly providerId: string;
        readonly reported: true;
        readonly inputUnits: number;
        readonly outputUnits: number;
      };
  readonly cancellation: {
    readonly callerStoppedWaiting: boolean;
    readonly groundlanePollingCancelled: boolean;
    readonly upstreamCancelRequested: boolean;
    readonly upstreamCancelled: boolean;
  };
}

export interface McpTaskRuntimePort<Input> {
  start(
    input: Input,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    options?: StartMcpTaskOptions,
  ): Promise<DetailedMcpTask>;
  get(
    taskId: string,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now?: Date,
  ): Promise<DetailedMcpTask>;
  update(
    taskId: string,
    inputResponses: Record<string, unknown>,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now?: Date,
  ): Promise<void>;
  cancel(
    taskId: string,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now?: Date,
  ): Promise<void>;
  describe(
    taskId: string,
    caller: AsyncJobCaller,
    signal: AbortSignal,
    now?: Date,
  ): Promise<McpTaskOperationalDetails>;
}
