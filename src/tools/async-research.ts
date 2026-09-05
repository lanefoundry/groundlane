import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { LinkupResearchProvider } from "../adapters/research/linkup.js";
import type { ResearchRequest, ResearchResult } from "../core/contracts.js";
import {
  MCP_TASKS_EXTENSION,
  type AsyncTaskProviderPort,
  type DetailedMcpTask,
  type McpTaskOperationalDetails,
  type McpTaskRuntimePort,
} from "../core/mcp-tasks.js";
import type { AsyncJobCaller } from "../core/async-lifecycle.js";
import { GroundlaneError } from "../core/errors.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import {
  GROUNDLANE_TASK_ID_PATTERN,
  groundlaneCancelTaskRequestSchema,
  groundlaneCancelTaskResultSchema,
  groundlaneCreateTaskResultSchema,
  groundlaneGetTaskRequestSchema,
  groundlaneGetTaskResultSchema,
  groundlaneUpdateTaskRequestSchema,
  groundlaneUpdateTaskResultSchema,
  mcpTaskInputResponsesSchema,
} from "../mcp/tasks-2026-07-28.js";
import { toolError } from "./common.js";

const domainSchema = z.string().trim().min(3).max(253);
export const asyncResearchInputSchema = z.object({
  query: z.string().trim().min(1).max(40_000),
  effort: z.enum(["lite", "standard", "deep"]).default("standard"),
  domains: z.array(domainSchema).max(50).optional(),
  excludeDomains: z.array(domainSchema).max(50).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  country: z.string().trim().length(2).optional(),
  ttlMs: z.number().int().min(60_000).max(86_400_000).optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
}).superRefine((value, context) => {
  if (value.domains !== undefined && value.excludeDomains !== undefined) {
    context.addIssue({
      code: "custom",
      message: "domains and excludeDomains cannot be used together",
      path: ["excludeDomains"],
    });
  }
});

const taskIdSchema = z.object({
  taskId: z.string().min(1).max(256).regex(GROUNDLANE_TASK_ID_PATTERN),
}).passthrough();
const taskUpdateSchema = taskIdSchema.extend({
  inputResponses: mcpTaskInputResponsesSchema,
});

export type AsyncResearchInput = z.infer<typeof asyncResearchInputSchema>;

function researchRequest(input: AsyncResearchInput): ResearchRequest {
  return {
    query: input.query,
    effort: input.effort,
    provider: "linkup",
    strategy: "fallback",
    ...(input.domains === undefined ? {} : { domains: input.domains }),
    ...(input.excludeDomains === undefined ? {} : { excludeDomains: input.excludeDomains }),
    ...(input.timeRange === undefined ? {} : { timeRange: input.timeRange }),
    ...(input.country === undefined ? {} : { country: input.country }),
  };
}

export function createLinkupResearchTaskProvider(
  provider: LinkupResearchProvider,
): AsyncTaskProviderPort<AsyncResearchInput> {
  return {
    id: "linkup",
    parseInput: (value) => asyncResearchInputSchema.parse(value),
    create: (input, signal) => provider.createTask(researchRequest(input), signal),
    async poll(providerTaskId, input, signal) {
      const outcome = await provider.pollTask(providerTaskId, signal);
      if (outcome.status !== "completed") return outcome;
      const report = outcome.result;
      const data: ResearchResult = {
        query: input.query,
        effort: input.effort,
        strategy: "fallback",
        providersSelected: ["linkup"],
        providersAttempted: ["linkup"],
        providersSucceeded: ["linkup"],
        reports: [report],
        durationMs: report.durationMs,
        warnings: report.warnings,
      };
      return {
        status: "completed",
        result: structuredToolResult({ ok: true, data }),
      };
    },
  };
}

function hasTasksCapabilityInBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("params" in body)) return false;
  const params: unknown = body.params;
  if (typeof params !== "object" || params === null || !("_meta" in params)) return false;
  const meta: unknown = params._meta;
  if (
    typeof meta !== "object" || meta === null ||
    !(CLIENT_CAPABILITIES_META_KEY in meta)
  ) return false;
  const capabilities: unknown = meta[CLIENT_CAPABILITIES_META_KEY];
  if (
    typeof capabilities !== "object" || capabilities === null ||
    !("extensions" in capabilities)
  ) return false;
  const extensions: unknown = capabilities.extensions;
  return typeof extensions === "object" && extensions !== null && MCP_TASKS_EXTENSION in extensions;
}

function requireTasksCapabilityInBody(body: unknown): void {
  if (hasTasksCapabilityInBody(body)) return;
  throw new ProtocolError(
    ProtocolErrorCode.MissingRequiredClientCapability,
    "Missing required client capability",
    { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } },
  );
}

function taskHandle(task: DetailedMcpTask) {
  return {
    resultType: "task" as const,
    ...task,
  };
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

export interface AsyncResearchModuleOptions {
  readonly runtime?: McpTaskRuntimePort<AsyncResearchInput>;
  readonly caller: AsyncJobCaller;
  readonly advertiseTasks?: boolean;
}

export function createAsyncResearchModule(options: AsyncResearchModuleOptions): McpModule {
  const unavailable = (): never => {
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "mcp-tasks",
      "Durable async research is not configured",
    );
  };
  const runtime = (): McpTaskRuntimePort<AsyncResearchInput> =>
    options.runtime ?? unavailable();
  return {
    name: "web_research_async",
    ...(options.runtime === undefined ? {} : { modernRequestHandlers: {
      "tools/call": async (params, body, signal) => {
        if (!hasTasksCapabilityInBody(body)) return undefined;
        const call = z.object({
          name: z.literal("web_research_start"),
          arguments: asyncResearchInputSchema,
        }).passthrough().parse(params);
        const task = await runtime().start(call.arguments, options.caller, signal, {
          ...(call.arguments.ttlMs === undefined ? {} : { ttlMs: call.arguments.ttlMs }),
          ...(call.arguments.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: call.arguments.idempotencyKey }),
        });
        return groundlaneCreateTaskResultSchema.parse(taskHandle(task));
      },
      "tasks/get": async (params, body, signal) => {
        requireTasksCapabilityInBody(body);
        groundlaneGetTaskRequestSchema.parse(body);
        const { taskId } = taskIdSchema.parse(params);
        const task = await runtime().get(taskId, options.caller, signal);
        return groundlaneGetTaskResultSchema.parse({ resultType: "complete", ...task });
      },
      "tasks/update": async (params, body, signal) => {
        requireTasksCapabilityInBody(body);
        groundlaneUpdateTaskRequestSchema.parse(body);
        const { taskId, inputResponses } = taskUpdateSchema.parse(params);
        await runtime().update(taskId, inputResponses, options.caller, signal);
        return groundlaneUpdateTaskResultSchema.parse({ resultType: "complete" });
      },
      "tasks/cancel": async (params, body, signal) => {
        requireTasksCapabilityInBody(body);
        groundlaneCancelTaskRequestSchema.parse(body);
        const { taskId } = taskIdSchema.parse(params);
        await runtime().cancel(taskId, options.caller, signal);
        return groundlaneCancelTaskResultSchema.parse({ resultType: "complete" });
      },
    } }),
    register(server): void {
      if (options.advertiseTasks ?? options.runtime !== undefined) {
        server.server.registerCapabilities({
          extensions: { [MCP_TASKS_EXTENSION]: {} },
        });
      }

      server.registerTool(
        "web_research_start",
        {
          description:
            "Start durable Linkup research. Tasks-capable modern clients receive an MCP task handle; other clients receive a compatibility job handle.",
          inputSchema: asyncResearchInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
          _meta: { taskExtension: MCP_TASKS_EXTENSION },
        },
        async (input, context) => {
          try {
            const task = await runtime().start(
              input,
              options.caller,
              context.mcpReq.signal,
              {
                ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
                ...(input.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: input.idempotencyKey }),
              },
            );
            return structuredToolResult({ ok: true, data: { task } });
          } catch (error) {
            return toolError(error, { tool: "web_research_start" });
          }
        },
      );

      server.registerTool(
          "web_research_status",
          {
            description: "Poll durable async research lifecycle and provenance without returning its terminal payload.",
            inputSchema: taskIdSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          async ({ taskId }, context) => {
            try {
              const details = await runtime().describe(
                taskId,
                options.caller,
                context.mcpReq.signal,
              );
              return structuredToolResult({ ok: true, data: compatibilityStatus(details) });
            } catch (error) {
              return toolError(error, { tool: "web_research_status" });
            }
          },
        );

      server.registerTool(
        "web_research_result",
        {
          description: "Read a durable async research result; non-terminal jobs return ready=false.",
          inputSchema: taskIdSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ taskId }, context) => {
          try {
            const details = await runtime().describe(
              taskId,
              options.caller,
              context.mcpReq.signal,
            );
            return structuredToolResult({
              ok: true,
              data: {
                ready: ["completed", "failed", "cancelled"].includes(details.task.status),
                ...details,
              },
            });
          } catch (error) {
            return toolError(error, { tool: "web_research_result" });
          }
        },
      );

      server.registerTool(
        "web_research_cancel",
        {
          description:
            "Stop Groundlane polling for a durable async research job. Upstream cancellation is reported only when the provider acknowledges it.",
          inputSchema: taskIdSchema,
          annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ taskId }, context) => {
          try {
            await runtime().cancel(taskId, options.caller, context.mcpReq.signal);
            const details = await runtime().describe(
              taskId,
              options.caller,
              context.mcpReq.signal,
            );
            return structuredToolResult({ ok: true, data: compatibilityStatus(details) });
          } catch (error) {
            return toolError(error, { tool: "web_research_cancel" });
          }
        },
      );
    },
  };
}
