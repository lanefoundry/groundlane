import { z } from "zod";
import type { AuthenticatedPrincipal, TimingSafeSubtleCrypto } from "../worker/auth.js";
import type { ManagedClock } from "../worker/managed-tokens.js";
import { INTERNAL_CONTEXT_HEADER, INTERNAL_REQUEST_ID_HEADER, mintInternalContext, verifyInternalContext } from "../worker/internal-context.js";

export const DOCUMENT_OUTPUT_HOST = "groundlane-output.internal";
export const DOCUMENT_OUTPUT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const audience = "groundlane-worker-output-v1";
const issuer = "groundlane-container";
const refId = z.string().regex(/^art_[A-Za-z0-9_-]+$/u).max(180);
const base = z.object({ version: z.literal(1), deadlineAt: z.number().int().positive() });
export const documentOutputRequestSchema = z.discriminatedUnion("operation", [
  base.extend({ operation: z.literal("save"), sourceBase64: z.string().min(4), mimeType: z.string().min(1).max(200), filename: z.string().min(1).max(255), payload: z.unknown(), sourceExpiresAt: z.number().int().positive().optional(), externalSourceRef: refId.optional() }).strict(),
  base.extend({ operation: z.literal("read"), refId, offset: z.number().int().nonnegative(), maxBytes: z.number().int().min(1).max(49_152) }).strict(),
  base.extend({ operation: z.literal("delete"), refId }).strict(),
]);

/** Read an untrusted body with an enforced streaming byte cap. */
export async function readOutputBridgeBody(value: Request | Response, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const declared = value.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > DOCUMENT_OUTPUT_MAX_BODY_BYTES)) throw new Error("output body limit");
  const reader = value.body?.getReader();
  if (reader === undefined) throw new Error("output body missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > DOCUMENT_OUTPUT_MAX_BODY_BYTES) throw new Error("output body limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function digest(body: Uint8Array, subtle: TimingSafeSubtleCrypto): Promise<string> {
  const bytes = new Uint8Array(body);
  return `sha256-${[...new Uint8Array(await subtle.digest("SHA-256", bytes.buffer))].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export async function buildDocumentOutputRequest(options: {
  body: Uint8Array; operation: "save" | "read" | "delete"; signingSecret: string;
  principal: AuthenticatedPrincipal; credentialBinding: string;
  subtle: TimingSafeSubtleCrypto; clock: ManagedClock; signal: AbortSignal;
}): Promise<Request> {
  if (options.body.byteLength < 1 || options.body.byteLength > DOCUMENT_OUTPUT_MAX_BODY_BYTES) throw new Error("output body limit");
  const requestId = crypto.randomUUID();
  const path = `/v1/${options.operation}`;
  const token = await mintInternalContext({
    issuer, signingSecret: options.signingSecret, audience, method: "POST", path, requestId,
    principal: options.principal, credentialBinding: options.credentialBinding,
    purpose: `document-output-${options.operation}`, bodySha256: await digest(options.body, options.subtle),
  }, options.subtle, options.clock);
  return new Request(`http://${DOCUMENT_OUTPUT_HOST}${path}`, {
    method: "POST", headers: { "content-type": "application/json", [INTERNAL_CONTEXT_HEADER]: token, [INTERNAL_REQUEST_ID_HEADER]: requestId },
    body: new Uint8Array(options.body), signal: options.signal,
  });
}

export async function verifyDocumentOutputRequest(request: Request, secret: string, subtle: TimingSafeSubtleCrypto, clock: ManagedClock) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.hostname !== DOCUMENT_OUTPUT_HOST || url.search ||
      !["/v1/save", "/v1/read", "/v1/delete"].includes(url.pathname) ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("invalid output route");
  const bytes = await readOutputBridgeBody(request, AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]));
  const requestId = request.headers.get(INTERNAL_REQUEST_ID_HEADER);
  if (!requestId || requestId.length > 128) throw new Error("invalid output identity");
  const verified = await verifyInternalContext(request.headers.get(INTERNAL_CONTEXT_HEADER), {
    signingSecret: secret, expectedIssuer: issuer, expectedAudience: audience,
    expectedMethod: "POST", expectedPath: url.pathname, expectedRequestId: requestId,
    expectedPurpose: `document-output-${url.pathname.slice(4)}`, expectedBodySha256: await digest(bytes, subtle),
  }, subtle, clock);
  if (!verified.ok) throw new Error("invalid output identity");
  const body = documentOutputRequestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (`/v1/${body.operation}` !== url.pathname) throw new Error("invalid output purpose");
  return { body, context: verified.payload };
}
