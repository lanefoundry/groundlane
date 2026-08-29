import { hasValidBearerToken, type TimingSafeSubtleCrypto } from "./auth.js";
import { jsonError } from "./http.js";
import { buildOAuthProvider } from "./oauth.js";
import {
  CONTAINER_INSTANCE_NAME,
  ensureContainerStarted,
  proxyToContainer,
  requestWithId,
  type WorkerEnv,
} from "./proxy.js";

export { CONTAINER_INSTANCE_NAME, type WorkerEnv } from "./proxy.js";

const OAUTH_MANAGED_PATH_PREFIXES = ["/authorize", "/token", "/register", "/.well-known/oauth"];

function isOAuthManagedPath(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    OAUTH_MANAGED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function healthResponse(requestId: string): Response {
  return Response.json(
    { status: "ok", service: "groundlane-worker", requestId },
    { headers: { "x-request-id": requestId } },
  );
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  subtle: TimingSafeSubtleCrypto,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const { pathname } = new URL(request.url);

  if (pathname === "/healthz" && request.method === "GET") {
    return healthResponse(requestId);
  }

  if (pathname === "/readyz" && request.method === "GET") {
    try {
      const container = env.GROUNDLANE_CONTAINER.getByName(CONTAINER_INSTANCE_NAME);
      ensureContainerStarted(container);
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

  // Headless/CLI clients (Codex, Claude Code, scheduled cloud automation):
  // unchanged static-token path, checked first so their behavior never
  // depends on the OAuth layer below.
  if (
    pathname === "/mcp" &&
    env.GROUNDLANE_AUTH_TOKEN.length > 0 &&
    (await hasValidBearerToken(
      request.headers.get("authorization"),
      env.GROUNDLANE_AUTH_TOKEN,
      subtle,
    ))
  ) {
    return proxyToContainer(request, env, requestId);
  }

  // Interactive cloud connectors (claude.ai, ChatGPT): OAuth 2.1. Also
  // handles /mcp requests that failed the legacy check above, so an
  // OAuth-issued bearer token still works on the same route.
  if (isOAuthManagedPath(pathname)) {
    return buildOAuthProvider(subtle).fetch(requestWithId(request, requestId), env, ctx);
  }

  return jsonError(404, "not_found", "Route not found", requestId);
}
