import { z } from "zod";
import type { CreateDocumentAsyncInput, DocumentAsyncStatus } from "../core/document-async-runtime.js";
import type { DurableDocumentJobCaller } from "../core/durable-document-jobs.js";
import { GroundlaneError } from "../core/errors.js";
import { Deadline, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError } from "./common.js";

const id = z.string().min(1).max(256);
export const DOCUMENT_JOB_TOOLS = ["document_job_create", "document_job_status", "document_job_cancel"] as const;
export type DocumentJobToolName = typeof DOCUMENT_JOB_TOOLS[number];
export const documentJobCreateSchema = z.object({
  mode: z.literal("async"), sourceRefId: id, idempotencyKey: id,
  expiresAt: z.number().int().positive(), executionDeadlineAt: z.number().int().positive(),
  executionBudgetSeconds: z.number().int().min(1).max(86_400).default(1_800),
}).strict();
export const documentJobStatusSchema = z.object({ jobId: id }).strict();
export const documentJobCancelSchema = z.object({ jobId: id, upstream: z.boolean().default(false) }).strict();
const snapshotSchema = z.object({ refId: id, artifactKind: z.literal("source"), expiresAt: z.number().int().positive() }).strict();
const publicStatusSchema = z.object({
  jobId: id, status: z.enum(["created", "pending", "running", "completed", "failed", "cancelled", "expired"]),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  resultArtifactRef: id.nullable(), dispatchCancelled: z.boolean(), upstreamRequested: z.boolean(), upstreamAcknowledged: z.boolean(),
  cleanupPending: z.boolean(), sourceRevocation: z.enum(["deleted", "expired"]).nullable(), snapshot: snapshotSchema.optional(),
}).strict();
type RuntimeStatus = DocumentAsyncStatus & { readonly snapshot?: z.infer<typeof snapshotSchema>; readonly snapshotCleanupPending?: boolean };
export interface DocumentJobRuntimePort {
  submit(input: CreateDocumentAsyncInput, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal): Promise<RuntimeStatus>;
  status(jobId: string, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal): Promise<RuntimeStatus>;
  cancel(jobId: string, caller: DurableDocumentJobCaller, upstream: boolean, deadline: Deadline, signal?: AbortSignal): Promise<RuntimeStatus>;
}

/** One serializer shared by edge execution and MCP inventory fallback. No private job fields cross this boundary. */
export async function executeDocumentJobTool(name: DocumentJobToolName, args: unknown, runtime: DocumentJobRuntimePort | undefined,
  caller: DurableDocumentJobCaller, signal: AbortSignal, now: () => number = Date.now) {
  try {
    if (runtime === undefined) throw new GroundlaneError("PROVIDER_UNAVAILABLE", "document-job", "Async document execution is not configured");
    const deadline = new Deadline(30_000);
    const result = await withinDeadline(async (operationSignal) => {
      if (name === "document_job_create") {
        const input = documentJobCreateSchema.parse(args);
        if (input.expiresAt <= now() || input.expiresAt > now() + 86_400_000 || input.executionDeadlineAt <= now() || input.executionDeadlineAt > input.expiresAt) {
          throw new GroundlaneError("INVALID_INPUT", "document-job", "Document job deadlines exceed the supported bounds");
        }
        return runtime.submit({ mode: "async", sourceRefId: input.sourceRefId, idempotencyKey: input.idempotencyKey, expiresAt: input.expiresAt,
          policy: { absoluteDeadlineMs: input.executionDeadlineAt, totalExecutionBudgetMs: input.executionBudgetSeconds * 1000,
            perAttemptDeadlineMs: 20_000, maxInputBytes: 10 * 1024 * 1024, maxOutputBytes: 32 * 1024 * 1024 } }, caller, deadline, operationSignal);
      }
      if (name === "document_job_cancel") {
        const input = documentJobCancelSchema.parse(args);
        return runtime.cancel(input.jobId, caller, input.upstream, deadline, operationSignal);
      }
      return runtime.status(documentJobStatusSchema.parse(args).jobId, caller, deadline, operationSignal);
    }, deadline, signal, "document-job");
    const data = publicStatusSchema.parse({ jobId: result.job.jobId, status: result.job.status,
      createdAt: result.job.createdAt, expiresAt: result.job.expiresAt, resultArtifactRef: result.job.resultArtifactRef,
      dispatchCancelled: result.dispatchCancelled, upstreamRequested: result.upstreamRequested, upstreamAcknowledged: result.upstreamAcknowledged,
      cleanupPending: result.resultCleanupPending || result.snapshotCleanupPending === true, sourceRevocation: result.sourceRevocation,
      ...(result.snapshot === undefined ? {} : { snapshot: result.snapshot }) });
    return structuredToolResult({ ok: true as const, data });
  } catch (error) {
    return toolError(new GroundlaneError(error instanceof z.ZodError ? "INVALID_INPUT" : error instanceof GroundlaneError ? error.code : "UPSTREAM_ERROR",
      "document-job", error instanceof GroundlaneError && error.code === "PROVIDER_UNAVAILABLE"
        ? "Async document execution is not configured" : "Document job operation failed or is unavailable", false));
  }
}

export function createDocumentJobModule(options: { readonly caller: DurableDocumentJobCaller; readonly runtime?: DocumentJobRuntimePort }): McpModule {
  return { name: "document_job", register(server) {
    server.registerTool("document_job_create", { description: "Explicitly create an async document job from a verified source. Admission snapshots the source and schedules work durably. Absolute deadlines keep idempotent retries stable.",
      inputSchema: documentJobCreateSchema, outputSchema: resultEnvelopeSchema(publicStatusSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true } },
    (input, context) => executeDocumentJobTool("document_job_create", input, options.runtime, options.caller, context.mcpReq.signal));
    server.registerTool("document_job_status", { description: "Read an owned document job after reconnect. This read neither starts work nor cancels it; completed jobs return a result ArtifactRef.",
      inputSchema: documentJobStatusSchema, outputSchema: resultEnvelopeSchema(publicStatusSchema), annotations: { readOnlyHint: true, openWorldHint: false } },
    (input, context) => executeDocumentJobTool("document_job_status", input, options.runtime, options.caller, context.mcpReq.signal));
    server.registerTool("document_job_cancel", { description: "Stop Groundlane dispatch. Upstream cancellation is separately opt-in and remains unacknowledged unless the provider confirms it; prior usage is not undone.",
      inputSchema: documentJobCancelSchema, outputSchema: resultEnvelopeSchema(publicStatusSchema), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
    (input, context) => executeDocumentJobTool("document_job_cancel", input, options.runtime, options.caller, context.mcpReq.signal));
  } };
}
