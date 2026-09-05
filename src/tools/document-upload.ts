import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { GroundlaneError, hint } from "../core/errors.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError } from "./common.js";

const digestSchema = z.string().regex(/^sha256-[a-f0-9]{64}$/u);

export const documentUploadCreateInputSchema = z.object({
  declaredMime: z.string().trim().min(1).max(200),
  declaredSize: z.number().int().positive().max(10 * 1024 * 1024),
  filename: z.string().trim().min(1).max(255),
  idempotencyKey: z.string().trim().min(1).max(256),
  expectedDigest: digestSchema.optional(),
  uploadTtlSeconds: z.number().int().min(60).max(3_600).optional(),
  artifactTtlSeconds: z.number().int().min(60).max(2_592_000).optional(),
}).strict();

export const documentUploadCompleteInputSchema = z.object({
  uploadIntentId: z.string().trim().min(1).max(180),
}).strict();

export const documentArtifactDeleteInputSchema = z.object({
  refId: z.string().trim().min(1).max(180),
}).strict();

const uploadHandoffSchema = z.object({
  method: z.literal("PUT"),
  url: z.string().url().max(8_192),
  headers: z.record(z.string(), z.string().max(2_048)).refine(
    (headers) => Object.keys(headers).length <= 16,
    "upload handoff headers exceed the supported bound",
  ),
}).strict();

const uploadIntentDataSchema = z.object({
  uploadIntentId: z.string().min(1).max(180),
  upload: uploadHandoffSchema,
  expiresAt: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
  multipart: z.literal(false),
}).strict();

const sourceArtifactDataSchema = z.object({
  refId: z.string().min(1).max(180),
  artifactKind: z.literal("source"),
  contentHash: digestSchema,
  byteSize: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  verified: z.literal(true),
}).strict();

export type DocumentUploadCreateInput = z.infer<typeof documentUploadCreateInputSchema>;
export type DocumentUploadCompleteInput = z.infer<typeof documentUploadCompleteInputSchema>;
export type DocumentArtifactDeleteInput = z.infer<typeof documentArtifactDeleteInputSchema>;

export interface DocumentUploadCaller {
  readonly ownerId: string;
  readonly credentialBinding: string;
}

export interface DocumentUploadRuntimePort {
  create(
    input: DocumentUploadCreateInput,
    caller: DocumentUploadCaller,
    signal: AbortSignal,
  ): Promise<z.infer<typeof uploadIntentDataSchema>>;
  complete(
    input: DocumentUploadCompleteInput,
    caller: DocumentUploadCaller,
    signal: AbortSignal,
  ): Promise<z.infer<typeof sourceArtifactDataSchema>>;
  delete(
    input: DocumentArtifactDeleteInput,
    caller: DocumentUploadCaller,
    signal: AbortSignal,
  ): Promise<{ readonly refId: string; readonly deleted: true }>;
}

export interface DocumentUploadModuleOptions {
  readonly caller: DocumentUploadCaller;
  readonly runtime?: DocumentUploadRuntimePort;
}

/**
 * Protocol adapter only. Storage coordinates are created and consumed by the
 * injected runtime; modern and legacy MCP transports therefore execute the
 * same ownership, credential, expiry, idempotency, and finalize policy.
 */
export function createDocumentUploadModule(options: DocumentUploadModuleOptions): McpModule {
  const runtime = (): DocumentUploadRuntimePort => {
    if (options.runtime !== undefined) return options.runtime;
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "document_upload",
      "Document upload is not configured",
      false,
      undefined,
      hint("document.upload_unavailable", "Use inline or public URL input, or configure the deployment artifact backend."),
    );
  };
  return {
    name: "document_upload",
    register(server: McpServer): void {
      server.registerTool(
        "document_upload_create",
        {
          description:
            "Create an idempotent, credential-bound upload intent and receive a short-lived single-PUT handoff. The handoff URL is not an ArtifactRef or MCP core upload capability.",
          inputSchema: documentUploadCreateInputSchema,
          outputSchema: resultEnvelopeSchema(uploadIntentDataSchema),
          annotations: { openWorldHint: true },
        },
        async (input, context) => {
          try {
            const data = await runtime().create(input, options.caller, context.mcpReq.signal);
            return structuredToolResult({ ok: true, data: uploadIntentDataSchema.parse(data) });
          } catch (error) {
            return toolError(error, { tool: "document_upload_create" });
          }
        },
      );

      server.registerTool(
        "document_upload_complete",
        {
          description:
            "Verify and immutably finalize a completed single-PUT upload, then mint a storage-neutral source ArtifactRef.",
          inputSchema: documentUploadCompleteInputSchema,
          outputSchema: resultEnvelopeSchema(sourceArtifactDataSchema),
          annotations: { openWorldHint: true },
        },
        async (input, context) => {
          try {
            const data = await runtime().complete(input, options.caller, context.mcpReq.signal);
            return structuredToolResult({ ok: true, data: sourceArtifactDataSchema.parse(data) });
          } catch (error) {
            return toolError(error, { tool: "document_upload_complete" });
          }
        },
      );

      server.registerTool(
        "document_artifact_delete",
        {
          description:
            "Immediately revoke and delete a caller-owned source ArtifactRef. Deletion also revokes its document-cache source bindings.",
          inputSchema: documentArtifactDeleteInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            refId: z.string().min(1).max(180),
            deleted: z.literal(true),
          }).strict()),
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        },
        async (input, context) => {
          try {
            const data = await runtime().delete(input, options.caller, context.mcpReq.signal);
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "document_artifact_delete" });
          }
        },
      );
    },
  };
}
