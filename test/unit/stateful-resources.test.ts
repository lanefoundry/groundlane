import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTHENTICATED_BROWSING_TOOL_PREFIX,
  acquireExclusiveLease,
  assertNoCaptchaBypassClaim,
  assertNoForbiddenSessionMaterial,
  assertWebFetchInputStateless,
  deleteAuthenticatedSession,
  isAuthenticatedBrowsingTool,
  isSessionExpired,
  isStatefulResourceExpired,
  releaseAuthenticatedSession,
  resolveSessionExpiry,
  validateAbuseControls,
  validateAuthenticatedSessionRequest,
  validateCredentialBindingRef,
  validateDataDeletion,
  validateNavigationRequest,
  validateNotificationConfig,
  validateOwnerBinding,
  validateQuotaBillingProvenance,
  validateSessionBinding,
  validateSessionStatusTransition,
  validateStatefulResourceDefinition,
  validateStatefulStatusTransition,
  validateToolFamilyAssignment,
  validateTtlRetention,
  type AuthenticatedSession,
  type AuthenticatedSessionRequest,
  type AuthenticatedSessionStatus,
  type SessionGatePolicy,
  type StatefulResourceDefinition,
  type StatefulResourceStatus,
} from "../../src/core/stateful-resources.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(
  overrides?: Partial<StatefulResourceDefinition>,
): StatefulResourceDefinition {
  return {
    kind: "authenticated_session",
    owner: { ownerId: "owner-abc", principalId: "owner" },
    credentialBinding: {
      credentialId: "cred-001",
      fundingSource: "operator-account",
    },
    ttlRetention: {
      ttlSeconds: 3600,
      retentionSeconds: 0,
      expiresAt: "2026-12-31T23:59:59Z",
    },
    statusResultCancel: {
      status: "active",
      resultRef: null,
      cancelKinds: ["caller", "groundlane", "upstream"],
    },
    notification: { mode: "none" },
    abuseControls: {
      maxInstancesPerOwner: 3,
      maxOperationsPerSession: 50,
      requireExplicitOptIn: true,
    },
    quotaBilling: {
      providerId: "browser-provider",
      billedUnits: 0,
      billedAt: null,
    },
    dataDeletion: {
      onRelease: "delete",
      retentionAfterReleaseSeconds: 0,
      physicalCleanupPending: false,
    },
    ...overrides,
  };
}

function makeGatePolicy(overrides?: Partial<SessionGatePolicy>): SessionGatePolicy {
  return {
    allowlistedDomains: ["app.example.com"],
    authorizedAccounts: ["ops-readonly@example.com"],
    ...overrides,
  };
}

function makeSessionRequest(
  overrides?: Partial<AuthenticatedSessionRequest>,
): AuthenticatedSessionRequest {
  return {
    domain: "app.example.com",
    accountId: "ops-readonly@example.com",
    loginMode: "human-in-the-loop",
    mfaRequired: true,
    profileKind: "provider-owned-opaque",
    principalId: "owner",
    site: "app.example.com",
    accountBinding: "ops-readonly@example.com",
    leaseHolder: "agent-run-001",
    idleTtlSeconds: 600,
    absoluteTtlSeconds: 3600,
    navigation: {
      mode: "read-only",
      maxNavigations: 20,
      allowedDomains: ["app.example.com"],
    },
    ...overrides,
  };
}

function makeSession(overrides?: Partial<AuthenticatedSession>): AuthenticatedSession {
  return {
    sessionId: "sess-001",
    principalId: "owner",
    site: "app.example.com",
    accountId: "ops-readonly@example.com",
    domain: "app.example.com",
    leaseHolder: "agent-run-001",
    idleTtlSeconds: 600,
    absoluteTtlSeconds: 3600,
    createdAt: "2026-01-15T00:00:00Z",
    lastActivityAt: "2026-01-15T00:05:00Z",
    status: "active",
    profileKind: "provider-owned-opaque",
    profileRef: "opaque-provider-ctx-abc",
    navigation: {
      mode: "read-only",
      maxNavigations: 20,
      allowedDomains: ["app.example.com"],
    },
    billingProvenance: {
      providerId: "browser-provider",
      billedUnits: 2,
      billedAt: "2026-01-15T00:05:00Z",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 686: generic stateful resource gate — all dimensions required
// ---------------------------------------------------------------------------

void test("PRD 686: complete stateful resource definition passes", () => {
  assert.doesNotThrow(() => validateStatefulResourceDefinition(makeDefinition()));
});

void test("PRD 686: missing ownerId rejected", () => {
  const def = makeDefinition({
    owner: { ownerId: "", principalId: "owner" },
  });
  assert.throws(() => validateStatefulResourceDefinition(def), {
    message: /ownerId is required/,
  });
});

void test("PRD 686: missing principalId rejected", () => {
  const def = makeDefinition({
    owner: { ownerId: "owner-abc", principalId: "" },
  });
  assert.throws(() => validateOwnerBinding(def.owner), {
    message: /principalId is required/,
  });
});

void test("PRD 686: missing credentialId rejected", () => {
  const def = makeDefinition({
    credentialBinding: { credentialId: "", fundingSource: "operator-account" },
  });
  assert.throws(() => validateCredentialBindingRef(def.credentialBinding), {
    message: /credentialId is required/,
  });
});

void test("PRD 686: credential binding must not carry secret values", () => {
  const tainted = {
    credentialId: "cred-001",
    fundingSource: "operator-account",
    secretValue: "super-secret",
  };
  assert.throws(() => validateCredentialBindingRef(tainted), {
    message: /must not carry secret value/,
  });
});

void test("PRD 686: non-positive TTL rejected", () => {
  assert.throws(
    () =>
      validateTtlRetention({
        ttlSeconds: 0,
        retentionSeconds: 0,
        expiresAt: "2026-12-31T23:59:59Z",
      }),
    { message: /ttlSeconds must be positive/ },
  );
});

void test("PRD 686: empty cancel kinds rejected — three cancels must be expressible", () => {
  const def = makeDefinition({
    statusResultCancel: { status: "active", resultRef: null, cancelKinds: [] },
  });
  assert.throws(() => validateStatefulResourceDefinition(def), {
    message: /cancelKinds/,
  });
});

void test("PRD 686: partial cancel kinds rejected — caller/groundlane/upstream are independent", () => {
  const def = makeDefinition({
    statusResultCancel: {
      status: "active",
      resultRef: null,
      cancelKinds: ["caller"],
    },
  });
  assert.throws(() => validateStatefulResourceDefinition(def), {
    message: /cancelKinds/,
  });
});

void test("PRD 686: non-https webhook rejected", () => {
  assert.throws(
    () =>
      validateNotificationConfig({
        mode: "webhook",
        webhookUrl: "http://hooks.example.com/notify",
      }),
    { message: /webhook/i },
  );
});

void test("PRD 686: webhook URL with embedded credentials rejected", () => {
  assert.throws(
    () =>
      validateNotificationConfig({
        mode: "webhook",
        webhookUrl: "https://user:pass@hooks.example.com/notify",
      }),
    { message: /credentials/ },
  );
});

void test("PRD 686: webhook mode without URL rejected", () => {
  assert.throws(() => validateNotificationConfig({ mode: "webhook" }), {
    message: /webhookUrl is required/,
  });
});

void test("PRD 686: abuse controls without explicit opt-in rejected", () => {
  assert.throws(
    () =>
      validateAbuseControls({
        maxInstancesPerOwner: 3,
        maxOperationsPerSession: 50,
        requireExplicitOptIn: false,
      }),
    { message: /requireExplicitOptIn must be true/ },
  );
});

void test("PRD 686: abuse controls with non-positive instance cap rejected", () => {
  assert.throws(
    () =>
      validateAbuseControls({
        maxInstancesPerOwner: 0,
        maxOperationsPerSession: 50,
        requireExplicitOptIn: true,
      }),
    { message: /maxInstancesPerOwner must be positive/ },
  );
});

void test("PRD 686: quota/billing provenance without providerId rejected", () => {
  assert.throws(
    () =>
      validateQuotaBillingProvenance({
        providerId: "",
        billedUnits: 0,
        billedAt: null,
      }),
    { message: /providerId is required/ },
  );
});

void test("PRD 686: negative billed units rejected", () => {
  assert.throws(
    () =>
      validateQuotaBillingProvenance({
        providerId: "browser-provider",
        billedUnits: -1,
        billedAt: null,
      }),
    { message: /billedUnits must be non-negative/ },
  );
});

void test("PRD 686: data deletion with negative retention rejected", () => {
  assert.throws(
    () =>
      validateDataDeletion({
        onRelease: "delete",
        retentionAfterReleaseSeconds: -1,
        physicalCleanupPending: false,
      }),
    { message: /retentionAfterReleaseSeconds must be non-negative/ },
  );
});

void test("PRD 686: expired resource detected via expiresAt", () => {
  const def = makeDefinition({
    ttlRetention: {
      ttlSeconds: 60,
      retentionSeconds: 0,
      expiresAt: "2020-01-01T00:00:00Z",
    },
  });
  assert.equal(
    isStatefulResourceExpired(def, new Date("2026-01-01T00:00:00Z")),
    true,
  );
});

void test("PRD 686: non-expired resource passes", () => {
  assert.equal(
    isStatefulResourceExpired(
      makeDefinition(),
      new Date("2026-01-01T00:00:00Z"),
    ),
    false,
  );
});

void test("PRD 686: lifecycle proposed -> pending_approval -> active is valid", () => {
  assert.doesNotThrow(() =>
    validateStatefulStatusTransition("proposed", "pending_approval"),
  );
  assert.doesNotThrow(() =>
    validateStatefulStatusTransition("pending_approval", "active"),
  );
});

void test("PRD 686: backward transition active -> proposed rejected", () => {
  assert.throws(() => validateStatefulStatusTransition("active", "proposed"), {
    message: /Invalid stateful resource status transition/,
  });
});

void test("PRD 686: terminal deleted status cannot transition", () => {
  assert.throws(() => validateStatefulStatusTransition("deleted", "active"), {
    message: /Invalid stateful resource status transition/,
  });
});

void test("PRD 686: same-state transition rejected", () => {
  const statuses: StatefulResourceStatus[] = [
    "proposed",
    "pending_approval",
    "active",
    "suspended",
    "released",
    "expired",
    "deleted",
  ];
  assert.equal(new Set(statuses).size, 7);
  assert.throws(() => validateStatefulStatusTransition("active", "active"), {
    message: /already/,
  });
});

// ---------------------------------------------------------------------------
// PRD 689: authenticated session v1 gate
// ---------------------------------------------------------------------------

void test("PRD 689: valid session request passes the gate", () => {
  assert.doesNotThrow(() =>
    validateAuthenticatedSessionRequest(makeSessionRequest(), makeGatePolicy()),
  );
});

void test("PRD 689: non-allowlisted domain rejected", () => {
  assert.throws(
    () =>
      validateAuthenticatedSessionRequest(
        makeSessionRequest({ domain: "evil.example.net" }),
        makeGatePolicy(),
      ),
    { message: /not allowlisted/ },
  );
});

void test("PRD 689: operator-unauthorized account rejected", () => {
  assert.throws(
    () =>
      validateAuthenticatedSessionRequest(
        makeSessionRequest({ accountId: "attacker@example.com" }),
        makeGatePolicy(),
      ),
    { message: /not operator-authorized/ },
  );
});

void test("PRD 689: non-human-in-the-loop login mode rejected", () => {
  assert.throws(
    () =>
      validateAuthenticatedSessionRequest(
        makeSessionRequest({ loginMode: "stored-password" }),
        makeGatePolicy(),
      ),
    { message: /human-in-the-loop/ },
  );
});

void test("PRD 689: session without MFA rejected", () => {
  assert.throws(
    () =>
      validateAuthenticatedSessionRequest(
        makeSessionRequest({ mfaRequired: false }),
        makeGatePolicy(),
      ),
    { message: /mfaRequired must be true/ },
  );
});

void test("PRD 689: non-opaque profile reference kind rejected", () => {
  assert.throws(
    () =>
      validateAuthenticatedSessionRequest(
        makeSessionRequest({ profileKind: "exported-cookies" }),
        makeGatePolicy(),
      ),
    { message: /provider-owned-opaque/ },
  );
});

void test("PRD 689: raw password material rejected", () => {
  assert.throws(
    () =>
      assertNoForbiddenSessionMaterial({
        domain: "app.example.com",
        rawPassword: "hunter2",
      }),
    { message: /rawPassword.*must never be stored/ },
  );
});

void test("PRD 689: TOTP seed rejected", () => {
  assert.throws(
    () => assertNoForbiddenSessionMaterial({ totpSeed: "JBSWY3DP" }),
    { message: /totpSeed.*must never be stored/ },
  );
});

void test("PRD 689: passkey material rejected", () => {
  assert.throws(
    () => assertNoForbiddenSessionMaterial({ passkey: "sk-..." }),
    { message: /passkey.*must never be stored/ },
  );
});

void test("PRD 689: exportable cookie snapshot rejected", () => {
  assert.throws(
    () => assertNoForbiddenSessionMaterial({ cookieSnapshot: "a=b; c=d" }),
    { message: /cookieSnapshot.*must never be stored/ },
  );
});

void test("PRD 689: storage snapshot rejected", () => {
  assert.throws(
    () => assertNoForbiddenSessionMaterial({ storageSnapshot: "{}" }),
    { message: /storageSnapshot.*must never be stored/ },
  );
});

void test("PRD 689: forbidden material error never echoes the secret value", () => {
  const secretMarker = "unique-secret-marker-002";
  try {
    assertNoForbiddenSessionMaterial({ rawPassword: secretMarker });
    assert.fail("expected assertNoForbiddenSessionMaterial to throw");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(
      !error.message.includes(secretMarker),
      "error message must not echo secret values",
    );
  }
});

void test("PRD 689: CAPTCHA bypass claim rejected", () => {
  assert.throws(
    () => assertNoCaptchaBypassClaim({ captchaBypass: false }),
    { message: /CAPTCHA bypass must not/ },
  );
});

void test("PRD 689: managed-challenge bypass claim rejected", () => {
  assert.throws(
    () => assertNoCaptchaBypassClaim({ managedChallengeBypass: true }),
    { message: /managed-challenge bypass must not/ },
  );
});

void test("PRD 689: principal/site/account binding mismatch rejected", () => {
  const session = makeSession();
  assert.throws(
    () =>
      validateSessionBinding(session, {
        principalId: "intruder",
        site: "app.example.com",
        accountId: "ops-readonly@example.com",
      }),
    { message: /Owner mismatch/ },
  );
});

void test("PRD 689: matching principal/site/account binding accepted", () => {
  const session = makeSession();
  assert.doesNotThrow(() =>
    validateSessionBinding(session, {
      principalId: "owner",
      site: "app.example.com",
      accountId: "ops-readonly@example.com",
    }),
  );
});

void test("PRD 689: exclusive lease — free lease can be acquired", () => {
  assert.equal(acquireExclusiveLease(null, "agent-run-001"), "agent-run-001");
});

void test("PRD 689: exclusive lease — conflicting holder rejected", () => {
  assert.throws(
    () => acquireExclusiveLease("agent-run-001", "agent-run-002"),
    { message: /exclusive lease held/ },
  );
});

void test("PRD 689: exclusive lease — same holder re-entry accepted", () => {
  assert.equal(
    acquireExclusiveLease("agent-run-001", "agent-run-001"),
    "agent-run-001",
  );
});

void test("PRD 689: idle TTL expiry detected", () => {
  const session = makeSession({
    lastActivityAt: "2026-01-15T00:00:00Z",
    idleTtlSeconds: 600,
  });
  assert.equal(
    isSessionExpired(session, new Date("2026-01-15T00:11:00Z")),
    true,
  );
});

void test("PRD 689: absolute TTL expiry detected", () => {
  const session = makeSession({
    createdAt: "2026-01-15T00:00:00Z",
    lastActivityAt: "2026-01-15T00:50:00Z",
    idleTtlSeconds: 3600,
    absoluteTtlSeconds: 3600,
  });
  assert.equal(
    isSessionExpired(session, new Date("2026-01-15T01:00:00Z")),
    true,
  );
});

void test("PRD 689: session within idle and absolute TTL is not expired", () => {
  assert.equal(
    isSessionExpired(makeSession(), new Date("2026-01-15T00:06:00Z")),
    false,
  );
});

void test("PRD 689: session expiry resolves to the earlier of idle/absolute", () => {
  const session = makeSession({
    createdAt: "2026-01-15T00:00:00Z",
    lastActivityAt: "2026-01-15T00:05:00Z",
    idleTtlSeconds: 600,
    absoluteTtlSeconds: 3600,
  });
  // idle expiry 00:15 is earlier than absolute expiry 01:00
  assert.equal(resolveSessionExpiry(session), "2026-01-15T00:15:00.000Z");
});

void test("PRD 689: idle TTL exceeding absolute TTL rejected at request time", () => {
  assert.throws(
    () =>
      validateAuthenticatedSessionRequest(
        makeSessionRequest({ idleTtlSeconds: 1800, absoluteTtlSeconds: 1200 }),
        makeGatePolicy(),
      ),
    { message: /idleTtlSeconds must not exceed absoluteTtlSeconds/ },
  );
});

void test("PRD 689: session status lifecycle pending_login -> active -> released -> deleted", () => {
  assert.doesNotThrow(() =>
    validateSessionStatusTransition("pending_login", "active"),
  );
  assert.doesNotThrow(() => validateSessionStatusTransition("active", "released"));
  assert.doesNotThrow(() =>
    validateSessionStatusTransition("released", "deleted"),
  );
});

void test("PRD 689: session backward transition active -> pending_login rejected", () => {
  assert.throws(
    () => validateSessionStatusTransition("active", "pending_login"),
    { message: /Invalid authenticated session transition/ },
  );
});

void test("PRD 689: terminal deleted session cannot transition", () => {
  assert.throws(() => validateSessionStatusTransition("deleted", "active"), {
    message: /Invalid authenticated session transition/,
  });
});

void test("PRD 689: all five session statuses are distinct", () => {
  const statuses: AuthenticatedSessionStatus[] = [
    "pending_login",
    "active",
    "released",
    "expired",
    "deleted",
  ];
  assert.equal(new Set(statuses).size, 5);
});

void test("PRD 689: explicit release keeps owner/billing provenance", () => {
  const released = releaseAuthenticatedSession(makeSession());
  assert.equal(released.status, "released");
  assert.equal(released.principalId, "owner");
  assert.equal(released.billingProvenance.providerId, "browser-provider");
  assert.equal(released.billingProvenance.billedUnits, 2);
});

void test("PRD 689: explicit delete clears the opaque profile reference", () => {
  const deleted = deleteAuthenticatedSession(makeSession());
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.profileRef, null);
});

void test("PRD 689: read-only GET navigation within budget accepted", () => {
  assert.doesNotThrow(() =>
    validateNavigationRequest(
      makeSession(),
      { url: "https://app.example.com/docs/page", method: "GET" },
      3,
    ),
  );
});

void test("PRD 689: non-GET navigation rejected — read-only boundary", () => {
  assert.throws(
    () =>
      validateNavigationRequest(
        makeSession(),
        { url: "https://app.example.com/docs/page", method: "POST" },
        0,
      ),
    { message: /read-only/ },
  );
});

void test("PRD 689: cross-domain navigation rejected — bounded navigation", () => {
  assert.throws(
    () =>
      validateNavigationRequest(
        makeSession(),
        { url: "https://other.example.net/page", method: "GET" },
        0,
      ),
    { message: /not within session navigation scope/ },
  );
});

void test("PRD 689: navigation beyond maxNavigations rejected", () => {
  assert.throws(
    () =>
      validateNavigationRequest(
        makeSession(),
        { url: "https://app.example.com/docs/page", method: "GET" },
        20,
      ),
    { message: /navigation budget exceeded/ },
  );
});

// ---------------------------------------------------------------------------
// Stateless boundary: web_fetch stays stateless; authenticated browsing is a
// separate explicit opt-in tool family
// ---------------------------------------------------------------------------

void test("stateless boundary: plain web_fetch input passes the gate", () => {
  assert.doesNotThrow(() =>
    assertWebFetchInputStateless({
      url: "https://example.com/page",
      format: "markdown",
      render: "auto",
    }),
  );
});

void test("stateless boundary: web_fetch input with sessionId rejected", () => {
  assert.throws(
    () =>
      assertWebFetchInputStateless({
        url: "https://example.com/page",
        sessionId: "sess-001",
      }),
    { message: /must not contain session\/auth field "sessionId"/ },
  );
});

void test("stateless boundary: web_fetch input with profileRef rejected", () => {
  assert.throws(
    () =>
      assertWebFetchInputStateless({
        url: "https://example.com/page",
        profileRef: "opaque-ctx",
      }),
    { message: /must not contain session\/auth field/ },
  );
});

void test("stateless boundary: web_fetch input with cookies rejected", () => {
  assert.throws(
    () =>
      assertWebFetchInputStateless({
        url: "https://example.com/page",
        cookies: "a=b",
      }),
    { message: /must not contain session\/auth field/ },
  );
});

void test("stateless boundary: authenticated tools use the explicit opt-in prefix", () => {
  assert.equal(
    isAuthenticatedBrowsingTool(`${AUTHENTICATED_BROWSING_TOOL_PREFIX}session`),
    true,
  );
  assert.equal(isAuthenticatedBrowsingTool("web_fetch"), false);
});

void test("stateless boundary: web_fetch assigned to authenticated family rejected", () => {
  assert.throws(
    () => validateToolFamilyAssignment("web_fetch", "authenticated"),
    { message: /separate explicit opt-in tool family/ },
  );
});

void test("stateless boundary: prefixed tool assigned to stateless family rejected", () => {
  assert.throws(
    () =>
      validateToolFamilyAssignment(
        `${AUTHENTICATED_BROWSING_TOOL_PREFIX}session`,
        "stateless",
      ),
    { message: /separate explicit opt-in tool family/ },
  );
});

void test("stateless boundary: web_fetch tool source carries no session/auth fields", () => {
  const source = readFileSync(
    new URL("../../src/tools/web-fetch.ts", import.meta.url),
    "utf8",
  );
  const forbidden = [
    "sessionId",
    "profileRef",
    "rawPassword",
    "totpSeed",
    "passkey",
    "cookieSnapshot",
    "storageSnapshot",
    "leaseHolder",
    "authenticated_browse_",
  ];
  for (const token of forbidden) {
    assert.ok(
      !source.includes(token),
      `web_fetch source must not contain ${token}`,
    );
  }
});
