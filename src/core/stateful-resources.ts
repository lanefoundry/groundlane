// ---------------------------------------------------------------------------
// PRD 686, 689 -- Stateful resource gate (contract + validation only)
//
// Gate-definition layer: pure contracts and validation functions that any
// future stateful-resource implementation must pass. No real browser
// session, no credential vault, no network, no storage. All errors are
// sanitized: messages name the offending field, never the secret value.
// ---------------------------------------------------------------------------

// -- PRD 686: generic stateful resource definition ---------------------------

export type StatefulResourceKind =
  | "authenticated_session"
  | "monitor"
  | "scheduled_research"
  | "stateful_browser_session"
  | "orchestration"
  | "corpus_lifecycle"
  | "synthesis"
  | "model_extraction";

export interface OwnerBinding {
  readonly ownerId: string;
  readonly principalId: string;
}

export interface CredentialBindingRef {
  readonly credentialId: string;
  readonly fundingSource: string;
}

export interface TtlRetention {
  readonly ttlSeconds: number;
  readonly retentionSeconds: number;
  readonly expiresAt: string;
}

export type StatefulResourceStatus =
  | "proposed"
  | "pending_approval"
  | "active"
  | "suspended"
  | "released"
  | "expired"
  | "deleted";

export type StatefulCancelKind = "caller" | "groundlane" | "upstream";

export const REQUIRED_CANCEL_KINDS: readonly StatefulCancelKind[] = [
  "caller",
  "groundlane",
  "upstream",
] as const;

export interface StatusResultCancel {
  readonly status: StatefulResourceStatus;
  readonly resultRef: string | null;
  readonly cancelKinds: readonly StatefulCancelKind[];
}

export interface NotificationConfig {
  readonly mode: "none" | "poll" | "webhook";
  readonly webhookUrl?: string;
}

export interface AbuseControls {
  readonly maxInstancesPerOwner: number;
  readonly maxOperationsPerSession: number;
  readonly requireExplicitOptIn: boolean;
}

export interface QuotaBillingProvenance {
  readonly providerId: string;
  readonly billedUnits: number;
  readonly billedAt: string | null;
}

export interface DataDeletion {
  readonly onRelease: "delete" | "revoke";
  readonly retentionAfterReleaseSeconds: number;
  readonly physicalCleanupPending: boolean;
}

export interface StatefulResourceDefinition {
  readonly kind: StatefulResourceKind;
  readonly owner: OwnerBinding;
  readonly credentialBinding: CredentialBindingRef;
  readonly ttlRetention: TtlRetention;
  readonly statusResultCancel: StatusResultCancel;
  readonly notification: NotificationConfig;
  readonly abuseControls: AbuseControls;
  readonly quotaBilling: QuotaBillingProvenance;
  readonly dataDeletion: DataDeletion;
}

export const STATEFUL_MAX_TTL_SECONDS = 30 * 24 * 3600;
export const STATEFUL_MAX_RETENTION_SECONDS = 90 * 24 * 3600;

const CREDENTIAL_SECRET_KEYS: readonly string[] = [
  "secretValue",
  "secret",
  "token",
  "apiKey",
  "password",
  "rawPassword",
  "totpSeed",
  "passkey",
  "cookieSnapshot",
  "storageSnapshot",
] as const;

export function validateOwnerBinding(owner: OwnerBinding): void {
  if (!owner.ownerId) {
    throw new Error("ownerId is required for stateful resources");
  }
  if (!owner.principalId) {
    throw new Error("principalId is required for stateful resources");
  }
}

export function validateCredentialBindingRef(ref: CredentialBindingRef): void {
  if (!ref.credentialId) {
    throw new Error("credentialId is required for stateful resources");
  }
  if (!ref.fundingSource) {
    throw new Error("fundingSource is required for stateful resources");
  }
  for (const key of Object.keys(ref)) {
    if ((CREDENTIAL_SECRET_KEYS).includes(key)) {
      throw new Error(
        `credentialBinding must not carry secret value "${key}"; ` +
          "bind by credential ID only",
      );
    }
  }
}

export function validateTtlRetention(ttl: TtlRetention): void {
  if (!Number.isInteger(ttl.ttlSeconds) || ttl.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be positive");
  }
  if (ttl.ttlSeconds > STATEFUL_MAX_TTL_SECONDS) {
    throw new Error(
      `ttlSeconds ${String(ttl.ttlSeconds)} exceeds gate maximum ${String(STATEFUL_MAX_TTL_SECONDS)}`,
    );
  }
  if (!Number.isInteger(ttl.retentionSeconds) || ttl.retentionSeconds < 0) {
    throw new Error("retentionSeconds must be non-negative");
  }
  if (ttl.retentionSeconds > STATEFUL_MAX_RETENTION_SECONDS) {
    throw new Error(
      `retentionSeconds ${String(ttl.retentionSeconds)} exceeds gate maximum ${String(STATEFUL_MAX_RETENTION_SECONDS)}`,
    );
  }
  if (Number.isNaN(new Date(ttl.expiresAt).getTime())) {
    throw new Error("expiresAt must be a valid timestamp");
  }
}

const KNOWN_STATEFUL_STATUSES: readonly StatefulResourceStatus[] = [
  "proposed",
  "pending_approval",
  "active",
  "suspended",
  "released",
  "expired",
  "deleted",
] as const;

export function validateStatusResultCancel(status: StatusResultCancel): void {
  if (!KNOWN_STATEFUL_STATUSES.includes(status.status)) {
    throw new Error(`Unknown stateful resource status "${status.status}"`);
  }
  for (const required of REQUIRED_CANCEL_KINDS) {
    if (!status.cancelKinds.includes(required)) {
      throw new Error(
        `cancelKinds must express caller, groundlane, and upstream independently; missing "${required}"`,
      );
    }
  }
}

export function validateNotificationConfig(config: NotificationConfig): void {
  if (config.mode === "webhook") {
    if (config.webhookUrl === undefined || config.webhookUrl === "") {
      throw new Error("webhookUrl is required when notification mode is webhook");
    }
    let parsed: URL;
    try {
      parsed = new URL(config.webhookUrl);
    } catch {
      throw new Error("webhookUrl must be a valid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("webhookUrl must use HTTPS");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("webhookUrl must not contain credentials");
    }
    return;
  }
  if (config.webhookUrl !== undefined) {
    throw new Error(
      `webhookUrl must not be set when notification mode is "${config.mode}"`,
    );
  }
}

export function validateAbuseControls(controls: AbuseControls): void {
  if (!Number.isInteger(controls.maxInstancesPerOwner) || controls.maxInstancesPerOwner <= 0) {
    throw new Error("maxInstancesPerOwner must be positive");
  }
  if (!Number.isInteger(controls.maxOperationsPerSession) || controls.maxOperationsPerSession <= 0) {
    throw new Error("maxOperationsPerSession must be positive");
  }
  if (controls.requireExplicitOptIn !== true) {
    throw new Error("requireExplicitOptIn must be true for stateful resources");
  }
}

export function validateQuotaBillingProvenance(
  provenance: QuotaBillingProvenance,
): void {
  if (!provenance.providerId) {
    throw new Error("providerId is required in quota/billing provenance");
  }
  if (!Number.isFinite(provenance.billedUnits) || provenance.billedUnits < 0) {
    throw new Error("billedUnits must be non-negative");
  }
}

export function validateDataDeletion(deletion: DataDeletion): void {
  if (deletion.onRelease !== "delete" && deletion.onRelease !== "revoke") {
    throw new Error(`Unknown data-deletion onRelease "${String(deletion.onRelease)}"`);
  }
  if (
    !Number.isInteger(deletion.retentionAfterReleaseSeconds) ||
    deletion.retentionAfterReleaseSeconds < 0
  ) {
    throw new Error("retentionAfterReleaseSeconds must be non-negative");
  }
}

const KNOWN_RESOURCE_KINDS: readonly StatefulResourceKind[] = [
  "authenticated_session",
  "monitor",
  "scheduled_research",
  "stateful_browser_session",
  "orchestration",
  "corpus_lifecycle",
  "synthesis",
  "model_extraction",
] as const;

export function validateStatefulResourceDefinition(
  def: StatefulResourceDefinition,
): void {
  if (!KNOWN_RESOURCE_KINDS.includes(def.kind)) {
    throw new Error(`Unknown stateful resource kind "${String(def.kind)}"`);
  }
  validateOwnerBinding(def.owner);
  validateCredentialBindingRef(def.credentialBinding);
  validateTtlRetention(def.ttlRetention);
  validateStatusResultCancel(def.statusResultCancel);
  validateNotificationConfig(def.notification);
  validateAbuseControls(def.abuseControls);
  validateQuotaBillingProvenance(def.quotaBilling);
  validateDataDeletion(def.dataDeletion);
}

const STATEFUL_TRANSITIONS: Record<
  StatefulResourceStatus,
  readonly StatefulResourceStatus[]
> = {
  proposed: ["pending_approval", "deleted"],
  pending_approval: ["active", "deleted"],
  active: ["suspended", "released", "expired", "deleted"],
  suspended: ["active", "released", "expired", "deleted"],
  released: ["deleted"],
  expired: ["deleted"],
  deleted: [],
};

export function validateStatefulStatusTransition(
  from: StatefulResourceStatus,
  to: StatefulResourceStatus,
): void {
  if (from === to) {
    throw new Error(`Status is already "${from}"; no transition needed`);
  }
  const allowed = STATEFUL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid stateful resource status transition from "${from}" to "${to}"`,
    );
  }
}

export function isStatefulResourceExpired(
  def: StatefulResourceDefinition,
  now: Date,
): boolean {
  return new Date(def.ttlRetention.expiresAt).getTime() <= now.getTime();
}

// -- PRD 689: authenticated session v1 gate ----------------------------------

export interface SessionGatePolicy {
  readonly allowlistedDomains: readonly string[];
  readonly authorizedAccounts: readonly string[];
}

export interface SessionNavigationPolicy {
  readonly mode: string;
  readonly maxNavigations: number;
  readonly allowedDomains: readonly string[];
}

export interface AuthenticatedSessionRequest {
  readonly domain: string;
  readonly accountId: string;
  readonly loginMode: string;
  readonly mfaRequired: boolean;
  readonly profileKind: string;
  readonly principalId: string;
  readonly site: string;
  readonly accountBinding: string;
  readonly leaseHolder: string;
  readonly idleTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
  readonly navigation: SessionNavigationPolicy;
}

export type AuthenticatedSessionStatus =
  | "pending_login"
  | "active"
  | "released"
  | "expired"
  | "deleted";

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly principalId: string;
  readonly site: string;
  readonly accountId: string;
  readonly domain: string;
  readonly leaseHolder: string;
  readonly idleTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly status: AuthenticatedSessionStatus;
  readonly profileKind: "provider-owned-opaque";
  readonly profileRef: string | null;
  readonly navigation: SessionNavigationPolicy;
  readonly billingProvenance: QuotaBillingProvenance;
}

export interface SessionCallerBinding {
  readonly principalId: string;
  readonly site: string;
  readonly accountId: string;
}

export interface SessionNavigationRequest {
  readonly url: string;
  readonly method: string;
}

export const SESSION_MIN_TTL_SECONDS = 60;
export const SESSION_MAX_IDLE_TTL_SECONDS = 30 * 60;
export const SESSION_MAX_ABSOLUTE_TTL_SECONDS = 8 * 3600;
export const SESSION_MAX_NAVIGATIONS = 200;

const SESSION_FORBIDDEN_MATERIAL_KEYS: readonly string[] = [
  "rawPassword",
  "password",
  "totpSeed",
  "totpSecret",
  "passkey",
  "privateKey",
  "cookie",
  "cookies",
  "cookieSnapshot",
  "storageSnapshot",
  "localStorage",
  "sessionStorage",
  "exportCookies",
] as const;

const CAPTCHA_BYPASS_KEYS: readonly string[] = [
  "captchaBypass",
  "captchaSolver",
  "captchaSolution",
  "managedChallengeBypass",
  "challengeBypass",
  "undetectable",
] as const;

/**
 * Rejects any session input carrying exportable credential material.
 * The error names the field only — never the value.
 */
export function assertNoForbiddenSessionMaterial(input: object): void {
  for (const key of Object.keys(input)) {
    if ((SESSION_FORBIDDEN_MATERIAL_KEYS).includes(key)) {
      throw new Error(
        `Session field "${key}" must never be stored: raw passwords, TOTP seeds, ` +
          "passkeys, and exportable cookie/storage snapshots are forbidden",
      );
    }
  }
}

/**
 * The bypass capability knob must not exist at all: neither a promise
 * (`true`) nor a disavowal (`false`) is an accepted configuration key.
 */
export function assertNoCaptchaBypassClaim(config: object): void {
  for (const key of Object.keys(config)) {
    if ((CAPTCHA_BYPASS_KEYS).includes(key)) {
      if (key.toLowerCase().includes("captcha")) {
        throw new Error(
          `Session field "${key}" rejected: CAPTCHA bypass must not be promised or configured`,
        );
      }
      throw new Error(
        `Session field "${key}" rejected: managed-challenge bypass must not be promised or configured`,
      );
    }
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export function validateSessionNavigationPolicy(
  navigation: SessionNavigationPolicy,
  sessionDomain: string,
): void {
  if (navigation.mode !== "read-only") {
    throw new Error(
      `Session navigation mode must be "read-only", got "${String(navigation.mode)}"`,
    );
  }
  if (
    !Number.isInteger(navigation.maxNavigations) ||
    navigation.maxNavigations <= 0
  ) {
    throw new Error("maxNavigations must be a positive integer");
  }
  if (navigation.maxNavigations > SESSION_MAX_NAVIGATIONS) {
    throw new Error(
      `maxNavigations ${String(navigation.maxNavigations)} exceeds gate maximum ${String(SESSION_MAX_NAVIGATIONS)}`,
    );
  }
  if (navigation.allowedDomains.length === 0) {
    throw new Error("allowedDomains must contain at least the session domain");
  }
  const normalizedSession = normalizeDomain(sessionDomain);
  const normalizedAllowed = navigation.allowedDomains.map(normalizeDomain);
  if (!normalizedAllowed.includes(normalizedSession)) {
    throw new Error("allowedDomains must include the session domain");
  }
}

export function validateAuthenticatedSessionRequest(
  req: AuthenticatedSessionRequest,
  policy: SessionGatePolicy,
): void {
  assertNoForbiddenSessionMaterial(req);
  const normalizedDomain = normalizeDomain(req.domain);
  const allowlisted = policy.allowlistedDomains.map(normalizeDomain);
  if (!allowlisted.includes(normalizedDomain)) {
    throw new Error(
      `Session domain "${req.domain}" is not allowlisted for authenticated browsing`,
    );
  }
  if (!policy.authorizedAccounts.includes(req.accountId)) {
    throw new Error(
      `Session account "${req.accountId}" is not operator-authorized for authenticated browsing`,
    );
  }
  if (req.loginMode !== "human-in-the-loop") {
    throw new Error(
      "Session loginMode must be human-in-the-loop: interactive login/MFA is required",
    );
  }
  if (req.mfaRequired !== true) {
    throw new Error("mfaRequired must be true for authenticated sessions");
  }
  if (req.profileKind !== "provider-owned-opaque") {
    throw new Error(
      "Session profileKind must be provider-owned-opaque: only opaque provider profile/context references are accepted",
    );
  }
  if (!req.principalId || !req.site || !req.accountBinding) {
    throw new Error(
      "principal/site/account binding is required for authenticated sessions",
    );
  }
  if (req.accountBinding !== req.accountId) {
    throw new Error("accountBinding must equal the authorized accountId");
  }
  if (!req.leaseHolder) {
    throw new Error("leaseHolder is required: sessions run under an exclusive lease");
  }
  if (
    !Number.isInteger(req.idleTtlSeconds) ||
    req.idleTtlSeconds < SESSION_MIN_TTL_SECONDS ||
    req.idleTtlSeconds > SESSION_MAX_IDLE_TTL_SECONDS
  ) {
    throw new Error(
      `idleTtlSeconds must be an integer in [${String(SESSION_MIN_TTL_SECONDS)}, ${String(SESSION_MAX_IDLE_TTL_SECONDS)}]`,
    );
  }
  if (
    !Number.isInteger(req.absoluteTtlSeconds) ||
    req.absoluteTtlSeconds < SESSION_MIN_TTL_SECONDS ||
    req.absoluteTtlSeconds > SESSION_MAX_ABSOLUTE_TTL_SECONDS
  ) {
    throw new Error(
      `absoluteTtlSeconds must be an integer in [${String(SESSION_MIN_TTL_SECONDS)}, ${String(SESSION_MAX_ABSOLUTE_TTL_SECONDS)}]`,
    );
  }
  if (req.idleTtlSeconds > req.absoluteTtlSeconds) {
    throw new Error("idleTtlSeconds must not exceed absoluteTtlSeconds");
  }
  validateSessionNavigationPolicy(req.navigation, req.domain);
}

export function validateSessionBinding(
  session: AuthenticatedSession,
  caller: SessionCallerBinding,
): void {
  if (
    session.principalId !== caller.principalId ||
    session.site !== caller.site ||
    session.accountId !== caller.accountId
  ) {
    throw new Error("Owner mismatch: caller is not bound to this session");
  }
}

/**
 * Exclusive lease arbitration: a free lease can be acquired, the current
 * holder may re-enter, any other requester is rejected.
 */
export function acquireExclusiveLease(
  currentHolder: string | null,
  requester: string,
): string {
  if (!requester) {
    throw new Error("lease requester is required");
  }
  if (currentHolder === null || currentHolder === requester) {
    return requester;
  }
  throw new Error(
    `Session exclusive lease held by another holder; "${requester}" cannot acquire it`,
  );
}

function sessionAbsoluteExpiryMs(session: AuthenticatedSession): number {
  const createdMs = new Date(session.createdAt).getTime();
  if (Number.isNaN(createdMs)) {
    throw new Error("Session createdAt must be a valid timestamp");
  }
  return createdMs + session.absoluteTtlSeconds * 1000;
}

function sessionIdleExpiryMs(session: AuthenticatedSession): number {
  const activityMs = new Date(session.lastActivityAt).getTime();
  if (Number.isNaN(activityMs)) {
    throw new Error("Session lastActivityAt must be a valid timestamp");
  }
  return activityMs + session.idleTtlSeconds * 1000;
}

export function isSessionExpired(
  session: AuthenticatedSession,
  now: Date,
): boolean {
  return (
    sessionAbsoluteExpiryMs(session) <= now.getTime() ||
    sessionIdleExpiryMs(session) <= now.getTime()
  );
}

export function resolveSessionExpiry(session: AuthenticatedSession): string {
  return new Date(
    Math.min(sessionAbsoluteExpiryMs(session), sessionIdleExpiryMs(session)),
  ).toISOString();
}

const SESSION_TRANSITIONS: Record<
  AuthenticatedSessionStatus,
  readonly AuthenticatedSessionStatus[]
> = {
  pending_login: ["active", "expired", "deleted"],
  active: ["released", "expired", "deleted"],
  released: ["deleted"],
  expired: ["deleted"],
  deleted: [],
};

export function validateSessionStatusTransition(
  from: AuthenticatedSessionStatus,
  to: AuthenticatedSessionStatus,
): void {
  if (from === to) {
    throw new Error(`Status is already "${from}"; no transition needed`);
  }
  const allowed = SESSION_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid authenticated session transition from "${from}" to "${to}"`,
    );
  }
}

export function releaseAuthenticatedSession(
  session: AuthenticatedSession,
): AuthenticatedSession {
  validateSessionStatusTransition(session.status, "released");
  return { ...session, status: "released" };
}

export function deleteAuthenticatedSession(
  session: AuthenticatedSession,
): AuthenticatedSession {
  validateSessionStatusTransition(session.status, "deleted");
  return { ...session, status: "deleted", profileRef: null };
}

export function validateNavigationRequest(
  session: AuthenticatedSession,
  req: SessionNavigationRequest,
  navigationsUsed: number,
): void {
  if (req.method !== "GET") {
    throw new Error(
      `Session navigation is read-only: method "${req.method}" rejected`,
    );
  }
  if (navigationsUsed >= session.navigation.maxNavigations) {
    throw new Error(
      `Session navigation budget exceeded: ${String(navigationsUsed)} >= ${String(session.navigation.maxNavigations)}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    throw new Error("Session navigation URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Session navigation URL must use HTTPS");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Session navigation URL must not contain credentials");
  }
  const host = parsed.hostname.toLowerCase();
  const inScope = session.navigation.allowedDomains
    .map(normalizeDomain)
    .includes(host);
  if (!inScope) {
    throw new Error(
      `Session navigation to "${parsed.hostname}" is not within session navigation scope`,
    );
  }
}

// -- Stateless boundary: web_fetch stays stateless ----------------------------

export const AUTHENTICATED_BROWSING_TOOL_PREFIX = "authenticated_browse_";

export const WEB_FETCH_STATELESS_INPUT_KEYS: readonly string[] = [
  "url",
  "format",
  "selector",
  "waitFor",
  "render",
  "timeoutMs",
  "maxBytes",
  "maxOutputChars",
] as const;

const WEB_FETCH_FORBIDDEN_INPUT_KEYS: readonly string[] = [
  "sessionId",
  "session",
  "auth",
  "profileRef",
  "profile",
  "credentials",
  "cookies",
  "cookieSnapshot",
  "storageSnapshot",
  "accountId",
  "loginMode",
  "leaseHolder",
] as const;

export function assertWebFetchInputStateless(input: object): void {
  for (const key of Object.keys(input)) {
    if ((WEB_FETCH_FORBIDDEN_INPUT_KEYS).includes(key)) {
      throw new Error(
        `web_fetch input must not contain session/auth field "${key}"; ` +
          "authenticated browsing requires a separate explicit opt-in tool",
      );
    }
  }
}

export function isAuthenticatedBrowsingTool(toolName: string): boolean {
  return toolName.startsWith(AUTHENTICATED_BROWSING_TOOL_PREFIX);
}

export function validateToolFamilyAssignment(
  toolName: string,
  family: "stateless" | "authenticated",
): void {
  const prefixed = isAuthenticatedBrowsingTool(toolName);
  if (family === "stateless" && prefixed) {
    throw new Error(
      `Tool "${toolName}" carries the authenticated prefix but is assigned to the stateless family; ` +
        "authenticated browsing requires a separate explicit opt-in tool family",
    );
  }
  if (family === "authenticated" && !prefixed) {
    throw new Error(
      `Tool "${toolName}" lacks the "${AUTHENTICATED_BROWSING_TOOL_PREFIX}" prefix; ` +
        "authenticated browsing requires a separate explicit opt-in tool family",
    );
  }
}
