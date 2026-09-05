import { z } from "zod";
import type { DurableArtifactCaller, DurableArtifactMetadata } from "../core/durable-artifacts.js";
import type { SaveDurableDocumentOutputInput, DurableDocumentOutputChunk } from "../core/durable-document-output.js";
import { GroundlaneError } from "../core/errors.js";
import { buildDocumentOutputRequest, readOutputBridgeBody } from "../mcp/document-output-bridge.js";
import type { AuthenticatedPrincipal, TimingSafeSubtleCrypto } from "../worker/auth.js";
import { systemUtcClock } from "../worker/managed-tokens.js";

const metadataSchema = z.object({
  schemaVersion: z.literal("1"), refId: z.string(), tenantId: z.string(), ownerId: z.string(), contentHash: z.string(),
  byteSize: z.number().int().positive(), retentionPolicy: z.string(), deletionPolicy: z.enum(["on_expiry", "on_owner_delete", "manual"]),
  expiresAt: z.number().int(), verification: z.literal("verified"), status: z.literal("active"), cleanupReason: z.null(),
  createdAt: z.number().int(), updatedAt: z.number().int(),
  details: z.object({ kind: z.literal("canonical"), sourceRefId: z.string(), documentSchemaVersion: z.string(), externalSourceRef: z.string().optional() }).strict(),
}).strict();
const chunkSchema = z.object({ refId: z.string(), dataBase64: z.string().max(65_536), offset: z.number().int(), nextOffset: z.number().int().nullable(), totalBytes: z.number().int(), contentHash: z.string() }).strict();

export class RemoteDocumentOutputRuntime {
  constructor(private readonly options: {
    signingSecret: string; principal: AuthenticatedPrincipal; credentialBinding: string; subtle: TimingSafeSubtleCrypto;
    timeoutMs: number; fetch?: (request: Request) => Promise<Response>;
  }) {}

  async save(input: SaveDurableDocumentOutputInput, signal: AbortSignal): Promise<DurableArtifactMetadata> {
    this.assertCaller(input.caller);
    const metadata = metadataSchema.parse(await this.call("save", {
      sourceBase64: Buffer.from(input.sourceBytes).toString("base64"), mimeType: input.mimeType, filename: input.filename,
      payload: input.payload, ...(input.sourceExpiresAt === undefined ? {} : { sourceExpiresAt: input.sourceExpiresAt }),
      ...(input.externalSourceRef === undefined ? {} : { externalSourceRef: input.externalSourceRef }),
    }, signal));
    const { externalSourceRef, ...details } = metadata.details;
    return { ...metadata, details: { ...details,
      ...(externalSourceRef === undefined ? {} : { externalSourceRef }),
    } };
  }
  async read(refId: string, caller: DurableArtifactCaller, offset: number, maxBytes: number, signal: AbortSignal): Promise<DurableDocumentOutputChunk> {
    this.assertCaller(caller);
    return chunkSchema.parse(await this.call("read", { refId, offset, maxBytes }, signal));
  }
  async delete(refId: string, caller: DurableArtifactCaller, signal: AbortSignal): Promise<{ deleted: true; cleanupPending: boolean }> {
    this.assertCaller(caller);
    return z.object({ deleted: z.literal(true), cleanupPending: z.boolean() }).strict().parse(await this.call("delete", { refId }, signal));
  }
  private assertCaller(caller: DurableArtifactCaller): void {
    if (caller.tenantId !== "self-hosted" || caller.ownerId !== this.options.principal.principalId || caller.credentialBinding !== this.options.credentialBinding) {
      throw new GroundlaneError("INVALID_INPUT", "document-output", "Document output identity is unavailable");
    }
  }
  private async call(operation: "save" | "read" | "delete", fields: Record<string, unknown>, callerSignal: AbortSignal): Promise<unknown> {
    const deadlineAt = Date.now() + this.options.timeoutMs;
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.options.timeoutMs)]);
    try {
      signal.throwIfAborted();
      const body = new TextEncoder().encode(JSON.stringify({ version: 1, operation, deadlineAt, ...fields }));
      const request = await buildDocumentOutputRequest({
        body, operation, signingSecret: this.options.signingSecret, principal: this.options.principal,
        credentialBinding: this.options.credentialBinding, subtle: this.options.subtle, clock: systemUtcClock(), signal,
      });
      signal.throwIfAborted();
      const response = await (this.options.fetch ?? fetch)(request);
      if (!response.ok) { await response.body?.cancel(); throw new Error("output unavailable"); }
      const data = z.object({ ok: z.literal(true), result: z.unknown() }).strict().parse(JSON.parse(new TextDecoder().decode(await readOutputBridgeBody(response, signal))));
      signal.throwIfAborted();
      return data.result;
    } catch {
      throw new GroundlaneError(callerSignal.aborted ? "CANCELLED" : signal.aborted ? "DEADLINE_EXCEEDED" : "UPSTREAM_ERROR", "document-output", "Document output operation could not complete", false);
    }
  }
}
