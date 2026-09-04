import { jsonError } from "./http.js";
import {
  isBearerEqualToSecret,
  type TimingSafeSubtleCrypto,
} from "./auth.js";
import {
  BoundedAuditLog,
  FakeClock,
  fingerprintForAudit,
  listManagedMetadata,
  createManagedCredential,
  expireManagedCredential,
  revokeManagedCredential,
  rotateManagedCredential,
  ManagedTokenError,
  RotateIdempotencyStore,
  systemUtcClock,
  type AuditKind,
  type AuditResult,
  type ManagedClock,
  type ManagedTokenStore,
} from "./managed-tokens.js";

export const ADMIN_MAX_BODY_BYTES = 8192;
const REQUEST_ID_HEADER = "x-request-id";

export interface AdminCredentialsEnv {
  readonly GROUNDLANE_ADMIN_TOKEN?: string | undefined;
}

export interface AdminCredentialsDeps {
  readonly env: AdminCredentialsEnv;
  readonly store: ManagedTokenStore | null;
  readonly audit: BoundedAuditLog;
  readonly idempotency: RotateIdempotencyStore;
  readonly subtle: TimingSafeSubtleCrypto;
  readonly clock: ManagedClock;
}

export function isAdminConfigured(env: AdminCredentialsEnv): boolean {
  return (env.GROUNDLANE_ADMIN_TOKEN ?? "").length > 0;
}

export async function isAdminBearer(
  request: Request,
  env: AdminCredentialsEnv,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  return isBearerEqualToSecret(
    request.headers.get("authorization"),
    env.GROUNDLANE_ADMIN_TOKEN ?? "",
    subtle,
  );
}

function requestIdOf(request: Request): string {
  return request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) return {};
  if (text.length > ADMIN_MAX_BODY_BYTES) {
    throw new ManagedTokenError("validation", "body too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ManagedTokenError("validation", "malformed json");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedTokenError("validation", "body must be an object");
  }
  return value as Record<string, unknown>;
}

function toAuditResult(error: unknown): AuditResult {
  if (error instanceof ManagedTokenError) {
    if (error.code === "conflict" || error.code === "duplicate_id") return "conflict";
    if (error.code === "not_found") return "not_found";
    if (error.code === "storage_unavailable") return "storage_unavailable";
    return "validation_error";
  }
  return "validation_error";
}

function errorToResponse(error: unknown, requestId: string): Response {
  if (error instanceof ManagedTokenError) {
    const status =
      error.code === "validation"
        ? 400
        : error.code === "not_found"
          ? 404
          : error.code === "conflict" || error.code === "duplicate_id"
            ? 409
            : 503;
    const code =
      error.code === "validation"
        ? "invalid_request"
        : error.code === "not_found"
          ? "not_found"
          : error.code === "conflict" || error.code === "duplicate_id"
            ? "conflict"
            : "store_unavailable";
    // Sanitized: never echo raw tokens, verifiers, headers or secrets.
    return jsonError(status, code, error.message, requestId);
  }
  return jsonError(500, "internal_error", "Internal error", requestId);
}

/**
 * Pure CLI arg-builder (PRD 711). No I/O, no D1 binding, no SQL. The admin
 * token is NEVER part of argv; callers pass it via a protected environment
 * variable or secret helper. Returns argv without secrets for display/logging.
 */
export function buildCredentialsCliArgs(
  operation: "create" | "list" | "rotate" | "revoke" | "expire" | "audit",
  params: Readonly<Record<string, string | number | undefined>> = {},
): string[] {
  const args = ["groundlane", "credentials", operation];
  const push = (flag: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    args.push(flag, String(value));
  };
  if (operation === "create") {
    push("--label", params["label"]);
    push("--expires-at", params["expiresAt"]);
    if (params["scopes"] !== undefined) push("--scopes", params["scopes"]);
  } else if (operation === "rotate") {
    push("--id", params["id"]);
    push("--overlap-seconds", params["overlapSeconds"]);
    push("--idempotency-key", params["idempotencyKey"]);
    if (params["newId"] !== undefined) push("--new-id", params["newId"]);
  } else if (operation === "revoke" || operation === "expire") {
    push("--id", params["id"]);
  } else if (operation === "list" || operation === "audit") {
    push("--limit", params["limit"]);
    push("--cursor", params["cursor"]);
  }
  return args;
}

/**
 * Redact any CLI/API display object: drop raw token/verifier/header/refresh
 * fields. Used by tests to pin redaction (PRD 696/711).
 */
export function redactCredentialDisplay(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("token") ||
      lower.includes("verifier") ||
      lower.includes("secret") ||
      lower.includes("authorization") ||
      lower.includes("refresh")
    ) {
      continue;
    }
    out[key] = entry;
  }
  return out;
}

let auditOpCounter = 0;
function nextOpId(): string {
  auditOpCounter += 1;
  return `op_${Date.now().toString(36)}_${auditOpCounter}`;
}

/**
 * `/admin/credentials` API (PRD 709). Admin-token only, metadata-only audit,
 * no cookies/sessions, no shared OAuth/register semantics, never forwarded to
 * the Container. The admin token itself is never stored in D1 and cannot be
 * rotated via this API (PRD 710); rotation follows the deployment secret
 * lifecycle.
 */
export async function handleAdminCredentialsRequest(
  request: Request,
  deps: AdminCredentialsDeps,
): Promise<Response> {
  const requestId = requestIdOf(request);
  if (!isAdminConfigured(deps.env)) {
    // Fail closed when no admin token is configured (PRD 710); data-plane
    // routes are unaffected by this branch.
    return jsonError(503, "admin_unavailable", "Admin API is not configured", requestId);
  }
  if (!(await isAdminBearer(request, deps.env, deps.subtle))) {
    const authorization = request.headers.get("authorization");
    if (authorization === null) {
      return jsonError(401, "unauthorized", "A valid bearer token is required", requestId, {
        "www-authenticate": 'Bearer realm="groundlane"',
      });
    }
    return jsonError(403, "forbidden", "Admin access is required", requestId);
  }
  if (deps.store === null) {
    return jsonError(503, "managed_unavailable", "Managed tokens are unavailable", requestId);
  }

  const url = new URL(request.url);
  const pathname = url.pathname;
  const adminToken = deps.env.GROUNDLANE_ADMIN_TOKEN ?? "";
  const fingerprint = await fingerprintForAudit(adminToken, deps.subtle);

  const audit = (
    kind: AuditKind,
    result: AuditResult,
    extra: { oldId?: string; newId?: string; overlapSeconds?: number },
  ): void => {
    const entry = {
      opId: nextOpId(),
      adminFingerprint: fingerprint,
      kind,
      commitTime: deps.clock.now(),
      result,
    } as const;
    const withIds: Record<string, unknown> = { ...entry };
    if (extra.oldId !== undefined) withIds["oldId"] = extra.oldId;
    if (extra.newId !== undefined) withIds["newId"] = extra.newId;
    if (extra.overlapSeconds !== undefined) withIds["overlapSeconds"] = extra.overlapSeconds;
    deps.audit.append(withIds as unknown as typeof entry & typeof extra);
  };

  try {
    if (pathname === "/admin/credentials/audit" && request.method === "GET") {
      const limitRaw = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      const listed = deps.audit.list(
        limit === undefined && cursor === undefined
          ? {}
          : {
              ...(limit === undefined ? {} : { limit }),
              ...(cursor === undefined ? {} : { cursor }),
            },
      );
      return Response.json({ items: listed.items, ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }) }, { headers: { [REQUEST_ID_HEADER]: requestId } });
    }

    if (pathname === "/admin/credentials" && request.method === "GET") {
      const limitRaw = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      const listed = await listManagedMetadata(
        deps.store,
        deps.clock,
        limit === undefined && cursor === undefined
          ? {}
          : {
              ...(limit === undefined ? {} : { limit }),
              ...(cursor === undefined ? {} : { cursor }),
            },
      );
      return Response.json(
        { credentials: listed.items, ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }) },
        { headers: { [REQUEST_ID_HEADER]: requestId } },
      );
    }

    if (pathname === "/admin/credentials" && request.method === "POST") {
      const body = asRecord(await readBoundedJson(request));
      try {
        const created = await createManagedCredential(
          deps.store,
          deps.subtle,
          deps.clock,
          {
            ...(body["label"] === undefined ? {} : { label: body["label"] }),
            ...(body["scopes"] === undefined ? {} : { scopes: body["scopes"] }),
            expiresAt: body["expiresAt"] as number,
            ...(body["id"] === undefined ? {} : { id: body["id"] as string }),
          },
        );
        audit("create", "ok", { newId: created.record.id });
        // Raw secret is returned exactly once here (PRD 696).
        return Response.json(
          {
            id: created.record.id,
            token: created.rawToken,
            secretAvailable: true,
            expiresAt: created.record.expiresAt,
            scopes: [...created.record.scopes],
          },
          { status: 201, headers: { [REQUEST_ID_HEADER]: requestId } },
        );
      } catch (error) {
        audit("create", toAuditResult(error), {});
        throw error;
      }
    }

    if (pathname === "/admin/credentials/rotate" && request.method === "POST") {
      const body = asRecord(await readBoundedJson(request));
      const oldId = body["id"];
      if (typeof oldId !== "string" || oldId.length === 0) {
        throw new ManagedTokenError("validation", "id is required");
      }
      try {
        const rotated = await rotateManagedCredential(
          deps.store,
          deps.subtle,
          deps.clock,
          {
            oldId,
            ...(body["overlapSeconds"] === undefined
              ? {}
              : { overlapSeconds: body["overlapSeconds"] }),
            ...(body["newId"] === undefined ? {} : { newId: body["newId"] as string }),
            ...(body["idempotencyKey"] === undefined
              ? {}
              : { idempotencyKey: body["idempotencyKey"] }),
          },
          deps.idempotency,
        );
        audit("rotate", "ok", {
          oldId,
          newId: rotated.newId,
          overlapSeconds: rotated.overlapSeconds,
        });
        if (rotated.isReplay) {
          return Response.json(
            { id: rotated.newId, secretAvailable: false },
            { headers: { [REQUEST_ID_HEADER]: requestId } },
          );
        }
        return Response.json(
          { id: rotated.newId, token: rotated.rawToken, secretAvailable: true },
          { headers: { [REQUEST_ID_HEADER]: requestId } },
        );
      } catch (error) {
        audit("rotate", toAuditResult(error), { oldId });
        throw error;
      }
    }

    if (pathname === "/admin/credentials/revoke" && request.method === "POST") {
      const body = asRecord(await readBoundedJson(request));
      const id = body["id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new ManagedTokenError("validation", "id is required");
      }
      try {
        const revoked = await revokeManagedCredential(deps.store, deps.clock, id);
        audit("revoke", "ok", { oldId: id });
        return Response.json(
          { id: revoked.id, status: revoked.status, revokedAt: revoked.revokedAt },
          { headers: { [REQUEST_ID_HEADER]: requestId } },
        );
      } catch (error) {
        audit("revoke", toAuditResult(error), { oldId: id });
        throw error;
      }
    }

    if (pathname === "/admin/credentials/expire" && request.method === "POST") {
      const body = asRecord(await readBoundedJson(request));
      const id = body["id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new ManagedTokenError("validation", "id is required");
      }
      try {
        const expired = await expireManagedCredential(deps.store, deps.clock, id);
        audit("expire", "ok", { oldId: id });
        return Response.json(
          { id: expired.id, expiresAt: expired.expiresAt },
          { headers: { [REQUEST_ID_HEADER]: requestId } },
        );
      } catch (error) {
        audit("expire", toAuditResult(error), { oldId: id });
        throw error;
      }
    }

    return jsonError(404, "not_found", "Route not found", requestId);
  } catch (error) {
    return errorToResponse(error, requestId);
  }
}

export function createAdminTestDeps(overrides: {
  adminToken?: string;
  store?: ManagedTokenStore | null;
  clock?: ManagedClock;
  subtle: TimingSafeSubtleCrypto;
}): AdminCredentialsDeps {
  const withDefaults: {
    adminToken: string;
    store: ManagedTokenStore | null;
    clock: ManagedClock;
  } = {
    adminToken: overrides.adminToken ?? "test-admin-token-0123456789abcdef",
    store: null,
    clock: systemUtcClock(),
  };
  if (overrides.store !== undefined) withDefaults.store = overrides.store;
  if (overrides.clock !== undefined) withDefaults.clock = overrides.clock;
  // Default to a fake clock-backed store only when explicitly requested via
  // overrides; otherwise keep null so tests pin managed-unavailable.
  void FakeClock;
  return {
    env: { GROUNDLANE_ADMIN_TOKEN: withDefaults.adminToken },
    store: withDefaults.store,
    audit: new BoundedAuditLog(),
    idempotency: new RotateIdempotencyStore(),
    subtle: overrides.subtle,
    clock: withDefaults.clock,
  };
}
