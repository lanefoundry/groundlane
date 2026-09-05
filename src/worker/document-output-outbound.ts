import type { OutboundHandlerContext } from "@cloudflare/containers";
import { verifyDocumentOutputRequest } from "../mcp/document-output-bridge.js";
import { createEdgeDocumentOutputRuntime, type EdgeDocumentOutputEnv } from "./document-output-runtime.js";
import type { TimingSafeSubtleCrypto } from "./auth.js";
import { systemUtcClock, type ManagedClock } from "./managed-tokens.js";

export interface DocumentOutputOutboundEnv extends EdgeDocumentOutputEnv {
  readonly GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
  readonly DOCUMENT_OUTPUT_EDGE_ENABLED?: string;
}

export function createDocumentOutputOutbound(dependencies: {
  subtle?: TimingSafeSubtleCrypto; clock?: ManagedClock;
  runtime?: ReturnType<typeof createEdgeDocumentOutputRuntime>["runtime"];
} = {}) {
  return async (request: Request, env: DocumentOutputOutboundEnv, context: OutboundHandlerContext): Promise<Response> => {
    const failure = (status: number) => Response.json({ ok: false, error: "DOCUMENT_OUTPUT_UNAVAILABLE" }, { status, headers: { "cache-control": "no-store" } });
    if (env.DOCUMENT_OUTPUT_EDGE_ENABLED !== "true" || !env.GROUNDLANE_INTERNAL_SIGNING_SECRET ||
        context.className !== "GroundlaneContainer" || !context.containerId || context.containerId.length > 256 || context.params !== undefined) return failure(503);
    const clock = dependencies.clock ?? systemUtcClock();
    const subtle = dependencies.subtle ?? crypto.subtle;
    let verified;
    try { verified = await verifyDocumentOutputRequest(request, env.GROUNDLANE_INTERNAL_SIGNING_SECRET, subtle, clock); }
    catch { return failure(request.signal.aborted ? 408 : 400); }
    const { body, context: identity } = verified;
    if (!identity.principal.scopes.includes("mcp")) return failure(403);
    const remaining = Math.min(body.deadlineAt - clock.now(), 120_000);
    if (remaining <= 0 || request.signal.aborted) return failure(408);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(remaining)]);
    const caller = { tenantId: "cloudflare", ownerId: identity.principal.principalId, credentialBinding: identity.credentialBinding };
    try {
      const runtime = dependencies.runtime ?? createEdgeDocumentOutputRuntime(env).runtime;
      let result: unknown;
      if (body.operation === "save") {
        const bytes = Buffer.from(body.sourceBase64, "base64");
        if (bytes.byteLength === 0 || bytes.toString("base64") !== body.sourceBase64) return failure(400);
        result = await runtime.save({
          caller, sourceBytes: bytes, mimeType: body.mimeType, filename: body.filename, payload: body.payload,
          ...(body.sourceExpiresAt === undefined ? {} : { sourceExpiresAt: body.sourceExpiresAt }),
          ...(body.externalSourceRef === undefined ? {} : { externalSourceRef: body.externalSourceRef }),
        }, signal);
      } else if (body.operation === "read") {
        result = await runtime.read(body.refId, caller, body.offset, body.maxBytes, signal);
      } else { result = await runtime.delete(body.refId, caller, signal); }
      if (signal.aborted) return failure(408);
      return Response.json({ ok: true, result }, { headers: { "cache-control": "no-store" } });
    } catch { return failure(signal.aborted ? 408 : 503); }
  };
}

export const handleDocumentOutputOutbound = createDocumentOutputOutbound();
