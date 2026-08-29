import { jsonError, logWorkerEvent } from "./http.js";

export interface ContainerStub {
  readonly running?: boolean;
  start?: () => void;
  fetch(request: Request): Promise<Response>;
}

export interface ContainerNamespace {
  getByName(name: string): ContainerStub;
}

export type WorkerEnv = Pick<
  Cloudflare.Env,
  "GROUNDLANE_AUTH_TOKEN" | "OAUTH_KV" | "OAUTH_OWNER_PASSPHRASE" | "OAUTH_PROVIDER"
> & {
  GROUNDLANE_CONTAINER: ContainerNamespace;
};

export const CONTAINER_INSTANCE_NAME = "groundlane-mcp";

export function requestWithId(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  return new Request(request, { headers });
}

export function ensureContainerStarted(container: ContainerStub): void {
  if (container.running === false) {
    container.start?.();
  }
}

/**
 * The Container independently re-checks Authorization against
 * GROUNDLANE_AUTH_TOKEN (defense in depth) — it has no notion of the
 * Worker's OAuth layer. By the time a request reaches proxyToContainer it has
 * already been authenticated at the Worker (legacy static token or a
 * validated OAuth access token), so the client's original credential must be
 * replaced with the one shared secret the Container actually understands.
 */
function requestForContainer(
  request: Request,
  requestId: string,
  groundlaneAuthToken: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  headers.set("authorization", `Bearer ${groundlaneAuthToken}`);
  return new Request(request, { headers });
}

export async function proxyToContainer(
  request: Request,
  env: Pick<WorkerEnv, "GROUNDLANE_CONTAINER" | "GROUNDLANE_AUTH_TOKEN">,
  requestId: string,
): Promise<Response> {
  try {
    const container = env.GROUNDLANE_CONTAINER.getByName(CONTAINER_INSTANCE_NAME);
    ensureContainerStarted(container);
    const response = await container.fetch(
      requestForContainer(request, requestId, env.GROUNDLANE_AUTH_TOKEN),
    );
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    logWorkerEvent({
      level: "info",
      event: "request_complete",
      requestId,
      status: response.status,
    });
    return new Response(response.body, { status: response.status, headers });
  } catch (error: unknown) {
    logWorkerEvent({
      level: "error",
      event: error instanceof Error ? "container_request_failed" : "unknown_failure",
      requestId,
      status: 502,
    });
    return jsonError(
      502,
      "container_unavailable",
      "The MCP runtime is unavailable",
      requestId,
    );
  }
}
