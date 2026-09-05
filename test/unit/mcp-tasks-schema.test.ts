import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GROUNDLANE_TASK_MAX_TTL_MS,
  GROUNDLANE_TASK_MAX_WIRE_BYTES,
  GROUNDLANE_TASK_MIN_POLL_INTERVAL_MS,
  GROUNDLANE_TASK_MIN_TTL_MS,
  MCP_TASKS_EXTENSION_ID,
  MCP_TASKS_PROTOCOL_VERSION,
  groundlaneCancelTaskRequestSchema,
  groundlaneCreateTaskResultSchema,
  groundlaneDetailedTaskSchema,
  groundlaneGetTaskRequestSchema,
  groundlaneGetTaskResultSchema,
  groundlaneUpdateTaskRequestSchema,
  missingTasksCapabilityError,
  mcpCancelTaskRequestSchema,
  mcpCancelTaskResultSchema,
  mcpCreateTaskResultSchema,
  mcpDetailedTaskSchema,
  mcpGetTaskRequestSchema,
  mcpGetTaskResultSchema,
  mcpTasksExtensionCapabilitySchema,
  mcpUpdateTaskRequestSchema,
  mcpUpdateTaskResultSchema,
} from "../../src/mcp/tasks-2026-07-28.js";

const FIXTURE = new URL(
  "../fixtures/mcp/extensions/tasks/2026-07-28/schema.json",
  import.meta.url,
);
const TASK_ID = "ajob-12345678-1234-4123-8123-123456789abc";
const CREATED_AT = "2026-09-05T01:02:03.000Z";
const UPDATED_AT = "2026-09-05T01:03:03.000Z";

const baseTask = {
  taskId: TASK_ID,
  createdAt: CREATED_AT,
  lastUpdatedAt: UPDATED_AT,
  ttlMs: GROUNDLANE_TASK_MIN_TTL_MS,
  pollIntervalMs: GROUNDLANE_TASK_MIN_POLL_INTERVAL_MS,
};

function request(method: string, params: Record<string, unknown>) {
  return { jsonrpc: "2.0" as const, id: 7, method, params };
}

void test("pins the immutable official 2026-07-28 schema artifact", async () => {
  const bytes = await readFile(FIXTURE);
  assert.equal(bytes.byteLength, 99_192);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "bf30afb7ac251e3e22c037b7a685f60ef6603031b5484c0d08b1fa0bbe86d460",
  );
  const schema: unknown = JSON.parse(bytes.toString("utf8"));
  assert.equal((schema as { $id?: unknown }).$id,
    "https://modelcontextprotocol.io/ext-tasks/2026-07-28/schema.json");
  const definitions = (schema as { $defs?: Record<string, unknown> }).$defs ?? {};
  for (const name of [
    "CreateTaskResult",
    "DetailedTask",
    "GetTaskRequest",
    "GetTaskResult",
    "UpdateTaskRequest",
    "UpdateTaskResult",
    "CancelTaskRequest",
    "CancelTaskResult",
    "TasksExtensionCapability",
  ]) {
    assert.ok(name in definitions, name);
  }
  assert.equal(MCP_TASKS_EXTENSION_ID, "io.modelcontextprotocol/tasks");
  assert.equal(MCP_TASKS_PROTOCOL_VERSION, "2026-07-28");
});

void test("accepts only the empty Tasks extension capability", () => {
  assert.deepEqual(mcpTasksExtensionCapabilitySchema.parse({}), {});
  assert.equal(mcpTasksExtensionCapabilitySchema.safeParse({ tasks: true }).success, false);
  assert.deepEqual(missingTasksCapabilityError(), {
    code: -32021,
    message: "Missing required client capability",
    data: {
      requiredCapabilities: {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      },
    },
  });
});

void test("validates the three official request methods and rejects retired methods", () => {
  const metadata = { client: "per-request" };
  assert.equal(mcpGetTaskRequestSchema.safeParse(
    request("tasks/get", { taskId: "official-allows-any-string", _meta: metadata }),
  ).success, true);
  assert.equal(mcpUpdateTaskRequestSchema.safeParse(request("tasks/update", {
    taskId: "task",
    inputResponses: {
      approval: { action: "accept", content: { approved: true } },
      roots: { roots: [{ uri: "file:///workspace" }] },
    },
  })).success, true);
  assert.equal(mcpCancelTaskRequestSchema.safeParse(
    request("tasks/cancel", { taskId: "task" }),
  ).success, true);

  for (const retired of ["tasks/list", "tasks/result"]) {
    assert.equal(mcpGetTaskRequestSchema.safeParse(
      request(retired, { taskId: "task" }),
    ).success, false, retired);
    assert.equal(mcpUpdateTaskRequestSchema.safeParse(
      request(retired, { taskId: "task", inputResponses: {} }),
    ).success, false, retired);
    assert.equal(mcpCancelTaskRequestSchema.safeParse(
      request(retired, { taskId: "task" }),
    ).success, false, retired);
  }
});

void test("validates every DetailedTask discriminator and required payload", () => {
  const variants = [
    { ...baseTask, status: "working" },
    {
      ...baseTask,
      status: "input_required",
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Approve?",
            requestedSchema: { type: "object", properties: {} },
          },
        },
      },
    },
    {
      ...baseTask,
      status: "completed",
      result: { resultType: "complete", content: [], isError: true },
    },
    {
      ...baseTask,
      status: "failed",
      error: { code: -32603, message: "Task failed", data: { retryable: false } },
    },
    { ...baseTask, status: "cancelled" },
  ];
  for (const variant of variants) {
    assert.equal(mcpDetailedTaskSchema.safeParse(variant).success, true, variant.status);
    assert.equal(groundlaneDetailedTaskSchema.safeParse(variant).success, true, variant.status);
  }

  assert.equal(mcpDetailedTaskSchema.safeParse({
    ...baseTask,
    status: "input_required",
  }).success, false);
  assert.equal(mcpDetailedTaskSchema.safeParse({
    ...baseTask,
    status: "completed",
  }).success, false);
  assert.equal(mcpDetailedTaskSchema.safeParse({
    ...baseTask,
    status: "failed",
  }).success, false);
});

void test("validates flat creation, detailed get, and empty update/cancel results", () => {
  const created = { ...baseTask, status: "working", resultType: "task" };
  assert.equal(mcpCreateTaskResultSchema.safeParse(created).success, true);
  assert.equal(groundlaneCreateTaskResultSchema.safeParse(created).success, true);

  const completed = {
    ...baseTask,
    status: "completed",
    resultType: "complete",
    result: { content: [{ type: "text", text: "provider error" }], isError: true },
  };
  assert.equal(mcpGetTaskResultSchema.safeParse(completed).success, true);
  assert.equal(groundlaneGetTaskResultSchema.safeParse(completed).success, true);
  assert.equal(mcpUpdateTaskResultSchema.safeParse({ resultType: "complete" }).success, true);
  assert.equal(mcpCancelTaskResultSchema.safeParse({ resultType: "complete" }).success, true);
  assert.equal(mcpUpdateTaskResultSchema.safeParse({
    resultType: "complete",
    taskId: TASK_ID,
  }).success, true, "official Result permits extension fields");
});

void test("layers Groundlane ID, timestamp, TTL, polling, and ordering policy", () => {
  assert.equal(mcpCreateTaskResultSchema.safeParse({
    ...baseTask,
    taskId: "x",
    ttlMs: null,
    pollIntervalMs: -1,
    status: "working",
    resultType: "task",
  }).success, true, "official schema remains structural");

  const invalidValues = [
    { ...baseTask, taskId: "provider-task-id" },
    { ...baseTask, createdAt: "not-a-timestamp" },
    { ...baseTask, lastUpdatedAt: "2026-09-05T00:00:00.000Z" },
    { ...baseTask, ttlMs: null },
    { ...baseTask, ttlMs: GROUNDLANE_TASK_MIN_TTL_MS - 1 },
    { ...baseTask, ttlMs: GROUNDLANE_TASK_MAX_TTL_MS + 1 },
    { ...baseTask, pollIntervalMs: GROUNDLANE_TASK_MIN_POLL_INTERVAL_MS - 1 },
    { ...baseTask, pollIntervalMs: 60_001 },
  ];
  for (const invalid of invalidValues) {
    assert.equal(groundlaneCreateTaskResultSchema.safeParse({
      ...invalid,
      status: "working",
      resultType: "task",
    }).success, false, JSON.stringify(invalid));
  }
});

void test("bounds Groundlane task requests and results without changing wire fields", () => {
  assert.equal(groundlaneGetTaskRequestSchema.safeParse(
    request("tasks/get", { taskId: TASK_ID }),
  ).success, true);
  assert.equal(groundlaneCancelTaskRequestSchema.safeParse(
    request("tasks/cancel", { taskId: TASK_ID }),
  ).success, true);
  assert.equal(groundlaneUpdateTaskRequestSchema.safeParse(request("tasks/update", {
    taskId: TASK_ID,
    inputResponses: { approval: { action: "decline" } },
  })).success, true);

  const oversized = "x".repeat(GROUNDLANE_TASK_MAX_WIRE_BYTES);
  assert.equal(groundlaneUpdateTaskRequestSchema.safeParse(request("tasks/update", {
    taskId: TASK_ID,
    inputResponses: {
      approval: { action: "accept", content: { reason: oversized } },
    },
  })).success, false);
  assert.equal(groundlaneDetailedTaskSchema.safeParse({
    ...baseTask,
    status: "completed",
    result: { content: [{ type: "text", text: oversized }] },
  }).success, false);
});

void test("request policy keeps per-request metadata while constraining Groundlane task IDs", () => {
  const valid = request("tasks/get", {
    taskId: TASK_ID,
    _meta: {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { [MCP_TASKS_EXTENSION_ID]: {} },
      },
    },
  });
  assert.equal(groundlaneGetTaskRequestSchema.safeParse(valid).success, true);
  assert.equal(groundlaneGetTaskRequestSchema.safeParse(
    request("tasks/get", { taskId: "private-provider-task" }),
  ).success, false);
});
