import {
  hasValidBearerToken,
  isAdminCredentialsPath,
  isBearerEqualToSecret,
  isMcpPath,
  isOAuthPath,
  isReadyzPath,
  isRegisterPath,
  parseBearerToken,
  resolveWorkerAuthProfile,
  type TimingSafeSubtleCrypto,
} from "./auth.js";
import {
  BoundedAuditLog,
  isManagedTokenFormat,
  authenticateManagedToken,
  ManagedTokenError,
  RotateIdempotencyStore,
  systemUtcClock,
  type ManagedClock,
  type ManagedTokenStore,
} from "./managed-tokens.js";
import { handleAdminCredentialsRequest } from "./admin-credentials.js";
import { jsonError } from "./http.js";
import {
  buildContainerRequestWithInternalContext,
  mintInternalContext,
  stripCallerInternalHeaders,
} from "./internal-context.js";
import { buildOAuthProvider } from "./oauth.js";
import {
  CONTAINER_INSTANCE_NAME,
  ensureContainerStarted,
  proxyToContainer,
  requestWithId,
  type WorkerEnv,
} from "./proxy.js";

export { CONTAINER_INSTANCE_NAME, type WorkerEnv } from "./proxy.js";

type ExtendedEnv = WorkerEnv & {
  GROUNDLANE_ADMIN_TOKEN?: string;
  GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
  GROUNDLANE_AUTH_MODE?: string;
  __MANAGED_STORE__?: ManagedTokenStore | null;
  __MANAGED_CLOCK__?: ManagedClock;
  __ADMIN_AUDIT__?: BoundedAuditLog;
  __ADMIN_IDEMPOTENCY__?: RotateIdempotencyStore;
};

const sharedAdminAudit = new BoundedAuditLog();
const sharedRotateIdempotency = new RotateIdempotencyStore();

function getManagedStore(env: ExtendedEnv): ManagedTokenStore | null {
  if ("__MANAGED_STORE__" in env) {
    return env.__MANAGED_STORE__ ?? null;
  }
  return null;
}

function getManagedClock(env: ExtendedEnv): ManagedClock {
  return env.__MANAGED_CLOCK__ ?? systemUtcClock();
}

function getAdminAudit(env: ExtendedEnv): BoundedAuditLog {
  return env.__ADMIN_AUDIT__ ?? sharedAdminAudit;
}

function getAdminIdempotency(env: ExtendedEnv): RotateIdempotencyStore {
  return env.__ADMIN_IDEMPOTENCY__ ?? sharedRotateIdempotency;
}

async function isAdminBearer(
  request: Request,
  env: ExtendedEnv,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  const expected = env.GROUNDLANE_ADMIN_TOKEN ?? "";
  return isBearerEqualToSecret(request.headers.get("authorization"), expected, subtle);
}

async function proxyDataPlane(
  request: Request,
  env: ExtendedEnv,
  requestId: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<Response> {
  const profile = resolveWorkerAuthProfile({
    ...(env.GROUNDLANE_AUTH_MODE === undefined
      ? {}
      : { GROUNDLANE_AUTH_MODE: env.GROUNDLANE_AUTH_MODE }),
    ...(env.GROUNDLANE_INTERNAL_SIGNING_SECRET === undefined
      ? {}
      : { GROUNDLANE_INTERNAL_SIGNING_SECRET: env.GROUNDLANE_INTERNAL_SIGNING_SECRET }),
  });
  const sanitized = stripCallerInternalHeaders(request);
  if (profile === "worker_internal_context") {
    const signingSecret = env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "";
    if (signingSecret.length === 0) {
      return jsonError(503, "internal_context_unavailable", "Internal context is not configured", requestId);
    }
    const url = new URL(request.url);
    const token = await mintInternalContext(
      {
        signingSecret,
        audience: CONTAINER_INSTANCE_NAME,
        method: request.method,
        path: url.pathname,
        requestId,
      },
      subtle,
      getManagedClock(env),
    );
    const forContainer = buildContainerRequestWithInternalContext(sanitized, token, requestId);
    try {
      const container = env.GROUNDLANE_CONTAINER.getByName(CONTAINER_INSTANCE_NAME);
      ensureContainerStarted(container);
      const response = await container.fetch(forContainer);
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return jsonError(502, "container_unavailable", "The MCP runtime is unavailable", requestId);
    }
  }
  return proxyToContainer(sanitized, env, requestId);
}

async function authenticateManagedRequest(
  request: Request,
  env: ExtendedEnv,
  subtle: TimingSafeSubtleCrypto,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authorization = request.headers.get("authorization");
  const token = parseBearerToken(authorization);
  // This helper is only called for managed-format bearers; non-managed callers
  // are handled by the static/OAuth paths.
  if (token === undefined || !isManagedTokenFormat(token)) {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return {
      ok: false,
      response: jsonError(401, "unauthorized", "A valid bearer token is required", requestId, {
        "www-authenticate": 'Bearer realm="groundlane"',
      }),
    };
  }
  const store = getManagedStore(env);
  const requestId = crypto.randomUUID();
  if (store === null) {
    return {
      ok: false,
      response: jsonError(503, "managed_unavailable", "Managed tokens are unavailable", requestId),
    };
  }
  try {
    const principal = await authenticateManagedToken(token, store, subtle, getManagedClock(env));
    if (principal === null) {
      return {
        ok: false,
        response: jsonError(401, "unauthorized", "A valid bearer token is required", requestId, {
          "www-authenticate": 'Bearer realm="groundlane"',
        }),
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof ManagedTokenError && error.code === "storage_unavailable") {
      return {
        ok: false,
        response: jsonError(503, "store_unavailable", "Auth store is unavailable", requestId),
      };
    }
    throw error;
  }
}

const OAUTH_MANAGED_PATH_PREFIXES = ["/authorize", "/token", "/register", "/.well-known/oauth"];

function isOAuthManagedPath(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    OAUTH_MANAGED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

async function hasValidStaticBearerToken(
  request: Request,
  env: Pick<WorkerEnv, "GROUNDLANE_AUTH_TOKEN">,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  return (
    env.GROUNDLANE_AUTH_TOKEN.length > 0 &&
    (await hasValidBearerToken(
      request.headers.get("authorization"),
      env.GROUNDLANE_AUTH_TOKEN,
      subtle,
    ))
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
  const url = new URL(request.url);
  const { pathname } = url;
  const extended = env as ExtendedEnv;

  if (pathname === "/healthz" && request.method === "GET") {
    return healthResponse(requestId);
  }

  // PRD 709: credential-management API is admin-only, never forwarded.
  if (isAdminCredentialsPath(pathname)) {
    return handleAdminCredentialsRequest(request, {
      env: {
        ...(extended.GROUNDLANE_ADMIN_TOKEN === undefined
          ? {}
          : { GROUNDLANE_ADMIN_TOKEN: extended.GROUNDLANE_ADMIN_TOKEN }),
      },
      store: getManagedStore(extended),
      audit: getAdminAudit(extended),
      idempotency: getAdminIdempotency(extended),
      subtle,
      clock: getManagedClock(extended),
    });
  }

  // PRD 695 exact-secret route guard: admin bearer never unlocks data-plane
  // routes (/mcp, /readyz, OAuth endpoints, /register).
  if (await isAdminBearer(request, extended, subtle)) {
    if (
      isMcpPath(pathname) ||
      isReadyzPath(pathname) ||
      isOAuthPath(pathname) ||
      isRegisterPath(pathname) ||
      pathname.startsWith("/.well-known/oauth") ||
      pathname === "/mcp"
    ) {
      return jsonError(403, "forbidden", "Admin token cannot access this route", requestId);
    }
    return jsonError(403, "forbidden", "Admin token cannot access this route", requestId);
  }

  if (isReadyzPath(pathname) && request.method === "GET") {
    if (await hasValidStaticBearerToken(request, env, subtle)) {
      return proxyDataPlane(request, extended, requestId, subtle);
    }
    const candidate = parseBearerToken(request.headers.get("authorization"));
    if (candidate !== undefined && isManagedTokenFormat(candidate)) {
      const checked = await authenticateManagedRequest(request, extended, subtle);
      if (!checked.ok) return checked.response;
      return proxyDataPlane(request, extended, requestId, subtle);
    }
    return jsonError(
      401,
      "unauthorized",
      "A valid bearer token is required",
      requestId,
      { "www-authenticate": 'Bearer realm="groundlane"' },
    );
  }

  if (isRegisterPath(pathname) && !(await hasValidStaticBearerToken(request, env, subtle))) {
    return jsonError(
      401,
      "unauthorized",
      "A valid bearer token is required",
      requestId,
      { "www-authenticate": 'Bearer realm="groundlane"' },
    );
  }

  // Headless/CLI clients (Codex, Claude Code, scheduled cloud automation):
  // unchanged static-token path, checked first so their behavior never
  // depends on the OAuth layer below.
  if (isMcpPath(pathname) && (await hasValidStaticBearerToken(request, env, subtle))) {
    return proxyDataPlane(request, extended, requestId, subtle);
  }

  if (isMcpPath(pathname)) {
    const candidate = parseBearerToken(request.headers.get("authorization"));
    if (candidate !== undefined && isManagedTokenFormat(candidate)) {
      const checked = await authenticateManagedRequest(request, extended, subtle);
      if (!checked.ok) return checked.response;
      return proxyDataPlane(request, extended, requestId, subtle);
    }
  }

  // Interactive cloud connectors (claude.ai, ChatGPT): OAuth 2.1. Also
  // handles /mcp requests that failed the legacy check above, so an
  // OAuth-issued bearer token still works on the same route.
  if (isOAuthManagedPath(pathname)) {
    const sanitized = stripCallerInternalHeaders(request);
    return buildOAuthProvider(subtle).fetch(requestWithId(sanitized, requestId), env, ctx);
  }

  return jsonError(404, "not_found", "Route not found", requestId);
}
