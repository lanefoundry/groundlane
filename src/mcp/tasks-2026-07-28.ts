import { z } from "zod";

/**
 * Local validators for the immutable MCP Tasks extension release. The source
 * artifact and checksum are pinned under test/fixtures/mcp/extensions/tasks.
 * Do not replace these with the SDK's deprecated 2025 core Tasks schemas.
 */
export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const MCP_TASKS_PROTOCOL_VERSION = "2026-07-28";
export const TASKS_EXTENSION_ID = MCP_TASKS_EXTENSION_ID;
export const TASKS_PROTOCOL_VERSION = MCP_TASKS_PROTOCOL_VERSION;
export const MCP_TASK_METHODS = [
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
] as const;

export interface MissingTasksCapabilityError {
  readonly code: -32021;
  readonly message: "Missing required client capability";
  readonly data: {
    readonly requiredCapabilities: {
      readonly extensions: {
        readonly [MCP_TASKS_EXTENSION_ID]: Record<string, never>;
      };
    };
  };
}

export function missingTasksCapabilityError(): MissingTasksCapabilityError {
  return {
    code: -32021,
    message: "Missing required client capability",
    data: {
      requiredCapabilities: {
        extensions: { [MCP_TASKS_EXTENSION_ID]: {} },
      },
    },
  };
}

export const GROUNDLANE_TASK_MIN_TTL_MS = 60_000;
export const GROUNDLANE_TASK_MAX_TTL_MS = 86_400_000;
export const GROUNDLANE_TASK_MIN_POLL_INTERVAL_MS = 5_000;
export const GROUNDLANE_TASK_MAX_POLL_INTERVAL_MS = 60_000;
export const GROUNDLANE_TASK_MAX_STATUS_MESSAGE_CHARS = 500;
export const GROUNDLANE_TASK_MAX_WIRE_BYTES = 48 * 1024;

export const GROUNDLANE_TASK_ID_PATTERN =
  /^ajob-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const jsonObjectSchema = z.record(z.string(), z.unknown());
const resultMetaSchema = jsonObjectSchema;

const annotationsSchema = jsonObjectSchema;
const textContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  annotations: annotationsSchema.optional(),
  _meta: jsonObjectSchema.optional(),
}).passthrough();
const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
  annotations: annotationsSchema.optional(),
  _meta: jsonObjectSchema.optional(),
}).passthrough();
const audioContentSchema = z.object({
  type: z.literal("audio"),
  data: z.string(),
  mimeType: z.string(),
  annotations: annotationsSchema.optional(),
  _meta: jsonObjectSchema.optional(),
}).passthrough();
const toolUseContentSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: jsonObjectSchema,
  _meta: jsonObjectSchema.optional(),
}).passthrough();
const toolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.array(jsonObjectSchema),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  _meta: jsonObjectSchema.optional(),
}).passthrough();
const samplingContentSchema = z.union([
  textContentSchema,
  imageContentSchema,
  audioContentSchema,
  toolUseContentSchema,
  toolResultContentSchema,
]);

const samplingMessageSchema = z.object({
  role: z.enum(["assistant", "user"]),
  content: z.union([samplingContentSchema, z.array(samplingContentSchema)]),
}).passthrough();

const samplingToolSchema = z.object({
  name: z.string(),
  inputSchema: z.object({ type: z.literal("object") }).passthrough(),
}).passthrough();

const samplingRequestSchema = z.object({
  method: z.literal("sampling/createMessage"),
  params: z.object({
    maxTokens: z.number().int(),
    messages: z.array(samplingMessageSchema),
    includeContext: z.enum(["allServers", "none", "thisServer"]).optional(),
    metadata: jsonObjectSchema.optional(),
    modelPreferences: jsonObjectSchema.optional(),
    stopSequences: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    temperature: z.number().optional(),
    toolChoice: z.object({ mode: z.enum(["auto", "none", "required"]).optional() })
      .passthrough()
      .optional(),
    tools: z.array(samplingToolSchema).optional(),
  }).passthrough(),
}).passthrough();

const rootsRequestSchema = z.object({
  method: z.literal("roots/list"),
  params: jsonObjectSchema.optional(),
}).passthrough();

const elicitationRequestSchema = z.object({
  method: z.literal("elicitation/create"),
  params: z.union([
    z.object({
      mode: z.literal("form").optional(),
      message: z.string(),
      requestedSchema: z.object({
        type: z.literal("object"),
        properties: jsonObjectSchema,
        required: z.array(z.string()).optional(),
        $schema: z.string().optional(),
      }).passthrough(),
    }).passthrough(),
    z.object({
      mode: z.literal("url"),
      message: z.string(),
      url: z.string().url(),
    }).passthrough(),
  ]),
}).passthrough();

export const mcpTaskInputRequestSchema = z.union([
  samplingRequestSchema,
  rootsRequestSchema,
  elicitationRequestSchema,
]);

const samplingResponseSchema = z.object({
  model: z.string(),
  role: z.enum(["assistant", "user"]),
  content: z.union([samplingContentSchema, z.array(samplingContentSchema)]),
}).passthrough();

const rootsResponseSchema = z.object({
  roots: z.array(z.object({ uri: z.string() }).passthrough()),
}).passthrough();

const elicitationResponseSchema = z.object({
  action: z.enum(["accept", "cancel", "decline"]),
  content: z.record(z.string(), z.union([
    z.array(z.string()),
    z.string(),
    z.number().int(),
    z.boolean(),
  ])).optional(),
}).passthrough();

export const mcpTaskInputResponseSchema = z.union([
  samplingResponseSchema,
  rootsResponseSchema,
  elicitationResponseSchema,
]);

export const mcpTaskInputRequestsSchema = z.record(
  z.string(),
  mcpTaskInputRequestSchema,
);
export const mcpTaskInputResponsesSchema = z.record(
  z.string(),
  mcpTaskInputResponseSchema,
);

export const mcpTasksExtensionCapabilitySchema = z.object({}).strict();

export const mcpTaskStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

const officialTaskFields = {
  taskId: z.string(),
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.number().int().nullable(),
  pollIntervalMs: z.number().int().optional(),
} as const;

/** Structural wire schema from the official release; policy is layered below. */
export const mcpTaskSchema = z.object({
  ...officialTaskFields,
  status: mcpTaskStatusSchema,
}).passthrough();

const workingTaskSchema = z.object({
  ...officialTaskFields,
  status: z.literal("working"),
}).passthrough();

const inputRequiredTaskSchema = z.object({
  ...officialTaskFields,
  status: z.literal("input_required"),
  inputRequests: mcpTaskInputRequestsSchema,
}).passthrough();

const completedTaskSchema = z.object({
  ...officialTaskFields,
  status: z.literal("completed"),
  result: jsonObjectSchema,
}).passthrough();

export const mcpTaskErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
}).passthrough();

const failedTaskSchema = z.object({
  ...officialTaskFields,
  status: z.literal("failed"),
  error: mcpTaskErrorSchema,
}).passthrough();

const cancelledTaskSchema = z.object({
  ...officialTaskFields,
  status: z.literal("cancelled"),
}).passthrough();

export const mcpDetailedTaskSchema = z.discriminatedUnion("status", [
  workingTaskSchema,
  inputRequiredTaskSchema,
  completedTaskSchema,
  failedTaskSchema,
  cancelledTaskSchema,
]);

const resultFields = {
  _meta: resultMetaSchema.optional(),
} as const;

export const mcpCreateTaskResultSchema = z.object({
  ...officialTaskFields,
  ...resultFields,
  status: mcpTaskStatusSchema,
  resultType: z.literal("task"),
}).passthrough();

const jsonRpcRequestFields = {
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int()]),
} as const;

const taskIdParamsSchema = z.object({ taskId: z.string() }).passthrough();

export const mcpGetTaskRequestSchema = z.object({
  ...jsonRpcRequestFields,
  method: z.literal("tasks/get"),
  params: taskIdParamsSchema,
}).passthrough();

export const mcpUpdateTaskRequestSchema = z.object({
  ...jsonRpcRequestFields,
  method: z.literal("tasks/update"),
  params: taskIdParamsSchema.extend({
    inputResponses: mcpTaskInputResponsesSchema,
  }),
}).passthrough();

export const mcpCancelTaskRequestSchema = z.object({
  ...jsonRpcRequestFields,
  method: z.literal("tasks/cancel"),
  params: taskIdParamsSchema,
}).passthrough();

export const mcpGetTaskResultSchema = z.intersection(
  mcpDetailedTaskSchema,
  z.object({ ...resultFields, resultType: z.literal("complete") }).passthrough(),
);

export const mcpUpdateTaskResultSchema = z.object({
  ...resultFields,
  resultType: z.literal("complete"),
}).passthrough();

export const mcpCancelTaskResultSchema = mcpUpdateTaskResultSchema;

const groundlaneTaskFields = {
  taskId: z.string().max(256).regex(GROUNDLANE_TASK_ID_PATTERN),
  statusMessage: z.string().max(GROUNDLANE_TASK_MAX_STATUS_MESSAGE_CHARS).optional(),
  createdAt: z.string().datetime({ offset: true }),
  lastUpdatedAt: z.string().datetime({ offset: true }),
  ttlMs: z.number().int()
    .min(GROUNDLANE_TASK_MIN_TTL_MS)
    .max(GROUNDLANE_TASK_MAX_TTL_MS),
  pollIntervalMs: z.number().int()
    .min(GROUNDLANE_TASK_MIN_POLL_INTERVAL_MS)
    .max(GROUNDLANE_TASK_MAX_POLL_INTERVAL_MS)
    .optional(),
} as const;

function addWireSizeIssue(
  value: unknown,
  context: z.core.$RefinementCtx<unknown>,
): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    context.addIssue({ code: "custom", message: "MCP task value must be acyclic JSON" });
    return;
  }
  if (new TextEncoder().encode(encoded).byteLength > GROUNDLANE_TASK_MAX_WIRE_BYTES) {
    context.addIssue({
      code: "custom",
      message: `MCP task value exceeds ${String(GROUNDLANE_TASK_MAX_WIRE_BYTES)} bytes`,
    });
  }
}

function addTimestampOrderIssue(
  value: { createdAt: string; lastUpdatedAt: string },
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (Date.parse(value.lastUpdatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["lastUpdatedAt"],
      message: "lastUpdatedAt must not precede createdAt",
    });
  }
}

const groundlaneWorkingTaskSchema = z.object({
  ...groundlaneTaskFields,
  status: z.literal("working"),
}).strict();

const groundlaneInputRequiredTaskSchema = z.object({
  ...groundlaneTaskFields,
  status: z.literal("input_required"),
  inputRequests: mcpTaskInputRequestsSchema,
}).strict();

const groundlaneCompletedTaskSchema = z.object({
  ...groundlaneTaskFields,
  status: z.literal("completed"),
  result: jsonObjectSchema,
}).strict();

const groundlaneFailedTaskSchema = z.object({
  ...groundlaneTaskFields,
  status: z.literal("failed"),
  error: mcpTaskErrorSchema,
}).strict();

const groundlaneCancelledTaskSchema = z.object({
  ...groundlaneTaskFields,
  status: z.literal("cancelled"),
}).strict();

/** Groundlane's bounded production subset of the official wire contract. */
export const groundlaneDetailedTaskSchema = z.discriminatedUnion("status", [
  groundlaneWorkingTaskSchema,
  groundlaneInputRequiredTaskSchema,
  groundlaneCompletedTaskSchema,
  groundlaneFailedTaskSchema,
  groundlaneCancelledTaskSchema,
]).superRefine((value, context) => {
  addTimestampOrderIssue(value, context);
  addWireSizeIssue(value, context);
});

export const groundlaneCreateTaskResultSchema = z.object({
  ...groundlaneTaskFields,
  ...resultFields,
  status: mcpTaskStatusSchema,
  resultType: z.literal("task"),
}).strict().superRefine((value, context) => {
  addTimestampOrderIssue(value, context);
  addWireSizeIssue(value, context);
});

const groundlaneTaskIdParamsSchema = z.object({
  taskId: groundlaneTaskFields.taskId,
}).passthrough();

export const groundlaneGetTaskRequestSchema = z.object({
  ...jsonRpcRequestFields,
  method: z.literal("tasks/get"),
  params: groundlaneTaskIdParamsSchema,
}).passthrough().superRefine(addWireSizeIssue);

export const groundlaneUpdateTaskRequestSchema = z.object({
  ...jsonRpcRequestFields,
  method: z.literal("tasks/update"),
  params: groundlaneTaskIdParamsSchema.extend({
    inputResponses: mcpTaskInputResponsesSchema,
  }),
}).passthrough().superRefine(addWireSizeIssue);

export const groundlaneCancelTaskRequestSchema = z.object({
  ...jsonRpcRequestFields,
  method: z.literal("tasks/cancel"),
  params: groundlaneTaskIdParamsSchema,
}).passthrough().superRefine(addWireSizeIssue);

export const groundlaneGetTaskResultSchema = z.intersection(
  groundlaneDetailedTaskSchema,
  z.object({ ...resultFields, resultType: z.literal("complete") }).strict(),
).superRefine(addWireSizeIssue);

export const groundlaneUpdateTaskResultSchema = z.object({
  ...resultFields,
  resultType: z.literal("complete"),
}).strict().superRefine(addWireSizeIssue);

export const groundlaneCancelTaskResultSchema = groundlaneUpdateTaskResultSchema;

export type McpTaskStatus20260728 = z.infer<typeof mcpTaskStatusSchema>;
export type McpTask20260728 = z.infer<typeof mcpTaskSchema>;
export type McpDetailedTask20260728 = z.infer<typeof mcpDetailedTaskSchema>;
export type McpCreateTaskResult20260728 = z.infer<typeof mcpCreateTaskResultSchema>;
export type McpGetTaskRequest20260728 = z.infer<typeof mcpGetTaskRequestSchema>;
export type McpGetTaskResult20260728 = z.infer<typeof mcpGetTaskResultSchema>;
export type McpUpdateTaskRequest20260728 = z.infer<typeof mcpUpdateTaskRequestSchema>;
export type McpUpdateTaskResult20260728 = z.infer<typeof mcpUpdateTaskResultSchema>;
export type McpCancelTaskRequest20260728 = z.infer<typeof mcpCancelTaskRequestSchema>;
export type McpCancelTaskResult20260728 = z.infer<typeof mcpCancelTaskResultSchema>;
