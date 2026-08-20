import {
  hasValidBearerToken,
  type TimingSafeSubtleCrypto,
} from "./auth.js";
import { jsonError, logWorkerEvent } from "./http.js";

interface ContainerStub {
  fetch(request: Request): Promise<Response>;
}

interface ContainerNamespace {
  getByName(name: string): ContainerStub;
}

export type WorkerEnv = Pick<Cloudflare.Env, "GROUNDLANE_AUTH_TOKEN"> & {
  GROUNDLANE_CONTAINER: ContainerNamespace;
};

export const CONTAINER_INSTANCE_NAME = "groundlane-mcp";

function healthResponse(requestId: string): Response {
  return Response.json(
    { status: "ok", service: "groundlane-worker", requestId },
    { headers: { "x-request-id": requestId } },
  );
}

function requestWithId(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  return new Request(request, { headers });
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  subtle: TimingSafeSubtleCrypto,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const { pathname } = new URL(request.url);

  if (pathname === "/healthz" && request.method === "GET") {
    return healthResponse(requestId);
  }

  if (pathname === "/readyz" && request.method === "GET") {
    try {
      const container = env.GROUNDLANE_CONTAINER.getByName(CONTAINER_INSTANCE_NAME);
      return await container.fetch(requestWithId(request, requestId));
    } catch {
      return jsonError(
        503,
        "container_unavailable",
        "The MCP runtime is not ready",
        requestId,
      );
    }
  }

  if (pathname !== "/mcp") {
    return jsonError(404, "not_found", "Route not found", requestId);
  }

  if (
    env.GROUNDLANE_AUTH_TOKEN.length === 0 ||
    !(await hasValidBearerToken(
      request.headers.get("authorization"),
      env.GROUNDLANE_AUTH_TOKEN,
      subtle,
    ))
  ) {
    logWorkerEvent({
      level: "info",
      event: "request_unauthorized",
      requestId,
      status: 401,
    });
    return jsonError(
      401,
      "unauthorized",
      "A valid bearer token is required",
      requestId,
      { "www-authenticate": 'Bearer realm="groundlane"' },
    );
  }

  try {
    const container = env.GROUNDLANE_CONTAINER.getByName(
      CONTAINER_INSTANCE_NAME,
    );
    const response = await container.fetch(requestWithId(request, requestId));
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
