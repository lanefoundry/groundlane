import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { ZodError } from "zod";

import { LinkupResearchProvider } from "../adapters/research/linkup.js";
import { DurableMcpTaskRuntime } from "../core/durable-mcp-tasks.js";
import { GroundlaneError } from "../core/errors.js";
import { MCP_TASKS_EXTENSION, type DetailedMcpTask } from "../core/mcp-tasks.js";
import type { McpTaskOperationalDetails } from "../core/mcp-tasks.js";
import { structuredToolError, structuredToolResult } from "../mcp/results.js";
import {
  GROUNDLANE_TASK_ID_PATTERN,
  groundlaneCancelTaskRequestSchema,
  groundlaneCancelTaskResultSchema,
  groundlaneCreateTaskResultSchema,
  groundlaneGetTaskRequestSchema,
  groundlaneGetTaskResultSchema,
  groundlaneUpdateTaskRequestSchema,
  groundlaneUpdateTaskResultSchema,
} from "../mcp/tasks-2026-07-28.js";
import {
  asyncResearchInputSchema,
  createLinkupResearchTaskProvider,
} from "../tools/async-research.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { D1DurableRecordStore } from "./d1-durable-store.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";
import type { ResearchFetchLike } from "../adapters/research/common.js";

const TASK_METHODS = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);
const FALLBACK_TOOLS = new Set([
  "web_research_start",
  "web_research_status",
  "web_research_result",
  "web_research_cancel",
]);

export interface EdgeTasksEnv {
  readonly MANAGED_TOKEN_D1?: D1DatabaseLike;
  readonly LINKUP_API_KEY?: string;
}

export interface EdgeTasksDependencies {
  readonly fetch?: ResearchFetchLike;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function taskCapability(body: Record<string, unknown>): boolean {
  const params = objectValue(body.params);
  const meta = objectValue(params?._meta);
  const capabilities = objectValue(meta?.[CLIENT_CAPABILITIES_META_KEY]);
  const extensions = objectValue(capabilities?.extensions);
  return extensions !== undefined && MCP_TASKS_EXTENSION in extensions;
}

function jsonRpcId(body: Record<string, unknown>): string | number | null {
  return typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
}

function jsonRpcResult(
  body: Record<string, unknown>,
  result: Record<string, unknown>,
  requestId: string,
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: jsonRpcId(body),
    result: {
      ...result,
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "groundlane", version: "0.1.0" } },
    },
  }, { headers: { "x-request-id": requestId } });
}

function jsonRpcError(
  body: Record<string, unknown>,
  code: number,
  message: string,
  requestId: string,
  status = 400,
  data?: Record<string, unknown>,
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: jsonRpcId(body),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }, { status, headers: { "x-request-id": requestId } });
}

function taskId(params: Record<string, unknown>): string {
  if (typeof params.taskId !== "string" || params.taskId.length === 0 || params.taskId.length > 256) {
    throw new GroundlaneError("INVALID_INPUT", "mcp-tasks", "taskId is invalid");
  }
  if (!GROUNDLANE_TASK_ID_PATTERN.test(params.taskId)) {
    throw new GroundlaneError("INVALID_INPUT", "mcp-tasks", "taskId is invalid");
  }
  return params.taskId;
}

function callResult(task: DetailedMcpTask): Record<string, unknown> {
  return structuredToolResult({ ok: true, data: { task } });
}

function compatibilityStatus(details: McpTaskOperationalDetails) {
  const task = details.task;
  return {
    task: {
      taskId: task.taskId,
      status: task.status,
      ...(task.statusMessage === undefined ? {} : { statusMessage: task.statusMessage }),
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttlMs: task.ttlMs,
      ...(task.pollIntervalMs === undefined ? {} : { pollIntervalMs: task.pollIntervalMs }),
    },
    billingProvenance: details.billingProvenance,
    cancellation: details.cancellation,
  };
}

/**
 * Handle Cloudflare Tasks at the authenticated Worker edge, where D1 is
 * available. All unrelated MCP traffic continues to the Container SDK.
 */
export async function maybeHandleEdgeTasks(
  request: Request,
  env: EdgeTasksEnv,
  principal: AuthenticatedPrincipal,
  credentialBinding: string,
  requestId: string,
  dependencies: EdgeTasksDependencies = {},
): Promise<Response | undefined> {
  const apiKey = env.LINKUP_API_KEY?.trim();
  if (env.MANAGED_TOKEN_D1 === undefined || apiKey === undefined || apiKey.length === 0) {
    return undefined;
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (request.method !== "POST" || mediaType !== "application/json") return undefined;
  let bodyValue: unknown;
  try {
    bodyValue = await request.clone().json();
  } catch {
    return undefined;
  }
  const body = objectValue(bodyValue);
  if (body === undefined || typeof body.method !== "string") return undefined;
  const params = objectValue(body.params) ?? {};
  const toolName = body.method === "tools/call" && typeof params.name === "string"
    ? params.name
    : undefined;
  if (!TASK_METHODS.has(body.method) && (toolName === undefined || !FALLBACK_TOOLS.has(toolName))) {
    return undefined;
  }

  const runtime = new DurableMcpTaskRuntime(
    new D1DurableRecordStore(env.MANAGED_TOKEN_D1, "mcp-tasks-v1"),
    createLinkupResearchTaskProvider(new LinkupResearchProvider({
      apiKey,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    })),
    5_000,
  );
  const caller = { ownerId: principal.principalId, credentialBinding };
  try {
    if (TASK_METHODS.has(body.method)) {
      if (!taskCapability(body)) {
        return jsonRpcError(
          body,
          ProtocolErrorCode.MissingRequiredClientCapability,
          "Missing required client capability",
          requestId,
          400,
          { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } },
        );
      }
      const id = taskId(params);
      if (body.method === "tasks/get") {
        groundlaneGetTaskRequestSchema.parse(body);
        const task = await runtime.get(id, caller, request.signal);
        const result = groundlaneGetTaskResultSchema.parse({ resultType: "complete", ...task });
        return jsonRpcResult(body, result, requestId);
      }
      if (body.method === "tasks/update") {
        groundlaneUpdateTaskRequestSchema.parse(body);
        const inputResponses = objectValue(params.inputResponses);
        if (inputResponses === undefined) {
          throw new GroundlaneError("INVALID_INPUT", "mcp-tasks", "inputResponses is invalid");
        }
        await runtime.update(id, inputResponses, caller, request.signal);
        return jsonRpcResult(body, groundlaneUpdateTaskResultSchema.parse({
          resultType: "complete",
        }), requestId);
      }
      groundlaneCancelTaskRequestSchema.parse(body);
      await runtime.cancel(id, caller, request.signal);
      return jsonRpcResult(body, groundlaneCancelTaskResultSchema.parse({
        resultType: "complete",
      }), requestId);
    }

    if (toolName === "web_research_start") {
      const input = asyncResearchInputSchema.parse(objectValue(params.arguments) ?? {});
      const task = await runtime.start(input, caller, request.signal, {
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      return jsonRpcResult(
        body,
        taskCapability(body)
          ? groundlaneCreateTaskResultSchema.parse({ resultType: "task", ...task })
          : callResult(task),
        requestId,
      );
    }
    const id = taskId(objectValue(params.arguments) ?? {});
    if (toolName === "web_research_cancel") {
      await runtime.cancel(id, caller, request.signal);
      const details = await runtime.describe(id, caller, request.signal);
      return jsonRpcResult(body, structuredToolResult({
        ok: true,
        data: compatibilityStatus(details),
      }), requestId);
    }
    const details = await runtime.describe(id, caller, request.signal);
    return jsonRpcResult(body, structuredToolResult({
      ok: true,
      data: toolName === "web_research_status"
        ? compatibilityStatus(details)
        : {
            ready: ["completed", "failed", "cancelled"].includes(details.task.status),
            ...details,
          },
    }), requestId);
  } catch (error) {
    if (TASK_METHODS.has(body.method)) {
      const invalid = error instanceof ZodError || (error instanceof GroundlaneError &&
        (error.code === "INVALID_INPUT" || error.code === "DEADLINE_EXCEEDED"));
      return jsonRpcError(
        body,
        invalid ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError,
        invalid
          ? error instanceof GroundlaneError
            ? error.message
            : "Invalid task request"
          : "Task operation failed",
        requestId,
        invalid ? 400 : 500,
      );
    }
    const result = structuredToolError({
      ok: false,
      error: {
        code: error instanceof ZodError
          ? "INVALID_INPUT"
          : error instanceof GroundlaneError ? error.code : "UPSTREAM_ERROR",
        message: error instanceof ZodError
          ? "Invalid task request"
          : error instanceof GroundlaneError ? error.message : "Task operation failed",
      },
    });
    return jsonRpcResult(body, result, requestId);
  }
}
