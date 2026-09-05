import { ReductoAsyncDocumentProvider } from "../adapters/document/reducto-async.js";
import { DOCUMENT_JOB_TOOLS, executeDocumentJobTool, type DocumentJobRuntimePort, type DocumentJobToolName } from "../tools/document-job.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { createEdgeDocumentAsyncRuntime } from "./document-async-runtime.js";
import type { EdgeDocumentOutputEnv } from "./document-output-runtime.js";

export interface EdgeDocumentJobsEnv extends EdgeDocumentOutputEnv {
  readonly DOCUMENT_ASYNC_EDGE_ENABLED?: string;
  readonly DOCUMENT_OUTPUT_EDGE_ENABLED?: string;
  readonly GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
  readonly REDUCTO_API_KEY?: string;
}

export function configuredDocumentJobRuntime(env: EdgeDocumentJobsEnv) {
  if (env.DOCUMENT_ASYNC_EDGE_ENABLED !== "true" || env.DOCUMENT_OUTPUT_EDGE_ENABLED !== "true" ||
    !env.GROUNDLANE_INTERNAL_SIGNING_SECRET?.trim() || !env.REDUCTO_API_KEY?.trim() ||
    env.MANAGED_TOKEN_D1?.withSession === undefined || env.GROUNDLANE_ARTIFACTS === undefined) return undefined;
  return createEdgeDocumentAsyncRuntime(env, new ReductoAsyncDocumentProvider({ apiKey: env.REDUCTO_API_KEY }));
}

/** Called only behind Worker authentication and the existing bounded MCP edge validator. */
export async function maybeHandleEdgeDocumentJobs(request: Request, env: EdgeDocumentJobsEnv, principal: AuthenticatedPrincipal,
  credentialBinding: string, requestId: string, dependencies: { readonly runtime?: DocumentJobRuntimePort; readonly now?: () => number } = {}): Promise<Response | undefined> {
  if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) return undefined;
  let value: unknown;
  try { value = await request.clone().json(); } catch { return undefined; }
  if (typeof value !== "object" || value === null || !("method" in value) || value.method !== "tools/call" || !("params" in value)) return undefined;
  const params = value.params;
  if (typeof params !== "object" || params === null || !("name" in params) || typeof params.name !== "string" ||
    !DOCUMENT_JOB_TOOLS.includes(params.name as DocumentJobToolName)) return undefined;
  let runtime = dependencies.runtime;
  if (runtime === undefined) {
    try { const configured = configuredDocumentJobRuntime(env); if (configured !== undefined) runtime = { submit: configured.submit.bind(configured), ...configured.runtime }; }
    catch { /* Invalid deployment policy remains unavailable, never a proxy fallback. */ }
  }
  const result = await executeDocumentJobTool(params.name as DocumentJobToolName, "arguments" in params ? params.arguments : {}, runtime,
    { ownerId: principal.principalId, credentialBinding }, request.signal, dependencies.now);
  return Response.json({ jsonrpc: "2.0", id: "id" in value && (typeof value.id === "string" || typeof value.id === "number") ? value.id : null, result },
    { headers: { "x-request-id": requestId } });
}

export async function runDocumentJobTick(env: EdgeDocumentJobsEnv, dependencies: { readonly runtime?: ReturnType<typeof createEdgeDocumentAsyncRuntime> } = {}) {
  const runtime = dependencies.runtime ?? configuredDocumentJobRuntime(env);
  if (runtime === undefined) return { enabled: false, scanned: 0, advanced: 0 };
  const result = await runtime.dispatcher.drain({ limit: 8, concurrency: 2, signal: AbortSignal.timeout(240_000) });
  return { enabled: true, scanned: result.scanned, advanced: result.advanced };
}
