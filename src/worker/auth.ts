const encoder = new TextEncoder();

export interface TimingSafeSubtleCrypto {
  digest(
    algorithm: AlgorithmIdentifier,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

export function parseBearerToken(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return match?.[1];
}

export async function timingSafeTokenEqual(
  candidate: string,
  expected: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  const [candidateDigest, expectedDigest] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(candidate)),
    subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return subtle.timingSafeEqual(candidateDigest, expectedDigest);
}

export type DataPlaneAuthMethod = "static_bearer" | "managed_token" | "oauth";

/**
 * Unified V1 principal contract (PRD 693).
 *
 * Static bearer, D1 managed token and OAuth access token all resolve to this
 * shape. V1 `principalId` is always `"owner"` and MUST NOT be presented as
 * user/tenant isolation. OAuth `clientId` is attribution only.
 */
export interface AuthenticatedPrincipal {
  readonly principalId: "owner";
  readonly authMethod: DataPlaneAuthMethod;
  readonly scopes: readonly string[];
  readonly clientId?: string;
  readonly credentialId?: string;
}

export function createStaticPrincipal(): AuthenticatedPrincipal {
  return { principalId: "owner", authMethod: "static_bearer", scopes: ["mcp"] };
}

export function createManagedPrincipal(
  credentialId: string,
  scopes: readonly string[],
): AuthenticatedPrincipal {
  return {
    principalId: "owner",
    authMethod: "managed_token",
    scopes: [...scopes],
    credentialId,
  };
}

export function createOAuthPrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthenticatedPrincipal {
  return {
    principalId: "owner",
    authMethod: "oauth",
    scopes: [...scopes],
    clientId,
  };
}

/**
 * Caller-supplied principal/tenant/policy override headers (PRD 693).
 * Resolution NEVER reads these; the Worker strips them before proxying so a
 * caller cannot override the verified result.
 */
export const CALLER_PRINCIPAL_OVERRIDE_HEADERS: readonly string[] = [
  "x-groundlane-principal",
  "x-groundlane-tenant",
  "x-groundlane-policy",
  "x-groundlane-user",
  "x-groundlane-client",
  "x-principal-id",
  "x-tenant-id",
  "x-user-id",
  "x-policy",
];

export function sanitizeCallerPrincipalHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of CALLER_PRINCIPAL_OVERRIDE_HEADERS) {
    headers.delete(name);
  }
  return headers;
}

export type WorkerAuthProfile = "local_static" | "worker_internal_context";

export interface ProfileEnv {
  readonly GROUNDLANE_AUTH_MODE?: string | undefined;
  readonly GROUNDLANE_INTERNAL_SIGNING_SECRET?: string | undefined;
}

/**
 * Resolve the Worker auth profile (PRD 708/713).
 * Explicit `GROUNDLANE_AUTH_MODE` wins; otherwise the presence of an internal
 * signing secret selects `worker_internal_context`, defaulting to
 * `local_static`. No listener may enable both modes at once (see
 * assertSingleAuthProfile).
 */
export function resolveWorkerAuthProfile(env: ProfileEnv): WorkerAuthProfile {
  if (env.GROUNDLANE_AUTH_MODE === "worker_internal_context") {
    return "worker_internal_context";
  }
  if (env.GROUNDLANE_AUTH_MODE === "local_static") {
    return "local_static";
  }
  const secret = env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "";
  return secret.length > 0 ? "worker_internal_context" : "local_static";
}

export function assertSingleAuthProfile(env: ProfileEnv): WorkerAuthProfile {
  const mode = (env.GROUNDLANE_AUTH_MODE ?? "").trim();
  if (
    mode !== "" &&
    mode !== "local_static" &&
    mode !== "worker_internal_context"
  ) {
    throw new Error(`Invalid GROUNDLANE_AUTH_MODE: ${mode}`);
  }
  return resolveWorkerAuthProfile(env);
}

/**
 * Container-side raw-bearer policy (PRD 708).
 * `local_static` listeners accept the legacy static bearer; a
 * `worker_internal_context` listener never accepts a raw bearer fallback and
 * only trusts a verified internal context (see internal-context.ts).
 */
export function allowsRawBearerAtContainer(profile: WorkerAuthProfile): boolean {
  return profile === "local_static";
}

/**
 * Worker-edge backward-compat policy (PRD 713).
 * `local_static` has no D1 and keeps the single static bearer.
 * `worker_internal_context` deployments MAY keep Worker-edge static/OAuth
 * verification for backward compat, but MUST explicitly report
 * managed-unavailable when no D1 store is bound instead of silently adding a
 * multi-static fallback.
 */
export function describeEdgeBackwardCompat(profile: WorkerAuthProfile): {
  readonly profile: WorkerAuthProfile;
  readonly retainsStaticAtEdge: boolean;
} {
  if (profile === "local_static") {
    return { profile, retainsStaticAtEdge: true };
  }
  return { profile, retainsStaticAtEdge: true };
}

export interface DistinctSecretSet {
  readonly adminToken?: string;
  readonly legacyToken?: string;
  readonly passphrase?: string;
  readonly signingSecret?: string;
  readonly providerSecrets?: readonly string[];
}

/**
 * PRD 694: admin, legacy, passphrase, signing and provider secrets must all
 * differ. Returns human-readable reuse descriptions; empty means distinct.
 * Empty/unset entries are ignored (missing admin fails closed elsewhere).
 */
export function findSecretReuse(secrets: DistinctSecretSet): string[] {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  const check = (label: string, value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    const first = seen.get(value);
    if (first !== undefined) {
      conflicts.push(`${label} reuses ${first}`);
      return;
    }
    seen.set(value, label);
  };
  check("GROUNDLANE_ADMIN_TOKEN", secrets.adminToken);
  check("GROUNDLANE_AUTH_TOKEN", secrets.legacyToken);
  check("OAUTH_OWNER_PASSPHRASE", secrets.passphrase);
  check("GROUNDLANE_INTERNAL_SIGNING_SECRET", secrets.signingSecret);
  const providers = secrets.providerSecrets ?? [];
  for (let i = 0; i < providers.length; i += 1) {
    const value = providers[i];
    if (value !== undefined) check(`provider[${i}]`, value);
  }
  return conflicts;
}

export async function isBearerEqualToSecret(
  authorization: string | null,
  expectedSecret: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  if (expectedSecret.length === 0) return false;
  const candidate = parseBearerToken(authorization) ?? "";
  return timingSafeTokenEqual(candidate, expectedSecret, subtle);
}

export async function hasValidBearerToken(
  authorization: string | null,
  expectedToken: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<boolean> {
  return isBearerEqualToSecret(authorization, expectedToken, subtle);
}

export function isAdminCredentialsPath(pathname: string): boolean {
  return (
    pathname === "/admin/credentials" || pathname.startsWith("/admin/credentials/")
  );
}

export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp";
}

export function isReadyzPath(pathname: string): boolean {
  return pathname === "/readyz";
}

export function isRegisterPath(pathname: string): boolean {
  return pathname === "/register";
}

export function isOAuthPath(pathname: string): boolean {
  return (
    pathname === "/authorize" ||
    pathname === "/token" ||
    pathname.startsWith("/token/") ||
    pathname.startsWith("/authorize/") ||
    pathname.startsWith("/.well-known/oauth")
  );
}

/** Redact an Authorization value for logs/snapshots (never log raw). */
export function redactAuthorization(value: string | null): string {
  if (value === null) return "none";
  const token = parseBearerToken(value);
  if (token === undefined) return "non-bearer";
  return `bearer:len=${token.length}`;
}
