import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import type { OutboundHandlerContext } from "@cloudflare/containers";

import type {
  BillingProvenance,
  DocumentCacheIdentity,
  ParsedPayloadCacheKey,
} from "../../src/core/document-cache-contract.js";
import {
  buildDocumentCacheBridgeRequest,
  DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES,
  DOCUMENT_CACHE_BRIDGE_VERSION,
  DOCUMENT_CACHE_COMMIT_PATH,
  DOCUMENT_CACHE_LOOKUP_PATH,
  DOCUMENT_CACHE_REVOKE_PATH,
  documentCacheCommitBridgeResponseSchema,
  documentCacheLookupBridgeResponseSchema,
  type DocumentCacheBridgePath,
  type DocumentCacheCommitBridgeRequest,
} from "../../src/mcp/document-cache-bridge.js";
import type { TimingSafeSubtleCrypto } from "../../src/worker/auth.js";
import {
  createDocumentCacheOutboundHandler,
  handleDocumentCacheOutbound,
  type DocumentCacheOutboundEnv,
} from "../../src/worker/document-cache-runtime.js";
import type {
  D1DatabaseLike,
  D1StatementLike,
} from "../../src/worker/d1-managed-store.js";
import { FakeClock } from "../../src/worker/managed-tokens.js";
import type {
  R2BucketLike,
  R2ObjectBodyLike,
  R2ObjectLike,
} from "../../src/worker/r2-immutable-blob.js";

const NOW = 1_800_000_000_000;
const SIGNING_SECRET = "cache-bridge-signing-secret-0123456789";
const BACKEND_SECRET = "never-return-backend-secret";
const CREDENTIAL_BINDING = "managed:credential-private";
const principal = {
  principalId: "owner",
  authMethod: "managed_token",
  scopes: ["mcp"],
} as const;
const context: OutboundHandlerContext = {
  className: "GroundlaneContainer",
  containerId: "container-one",
};

function bytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

const subtle: TimingSafeSubtleCrypto = {
  digest: (algorithm, data) => crypto.subtle.digest(algorithm, data),
  timingSafeEqual: (left, right) =>
    timingSafeEqual(Buffer.from(bytes(left)), Buffer.from(bytes(right))),
};

const provenance: BillingProvenance = {
  isOriginal: true,
  originalCost: 0,
  engine: "groundlane",
  model: "none",
};

function cacheKey(): ParsedPayloadCacheKey {
  return {
    ownershipScope: "owner",
    contentHash: `sha256-${"a".repeat(64)}`,
    engineId: "groundlane",
    engineVersion: "1",
    modelId: "none",
    modelVersion: "none",
    normalizedOptions: "{}",
    schemaVersion: "canonical-document-v1",
    policyVersion: "document-policy-v1",
  };
}

function identity(
  overrides: Partial<DocumentCacheIdentity> = {},
): DocumentCacheIdentity {
  return {
    mode: "use",
    key: cacheKey(),
    sourceIdentity: "source-private-binding",
    sourceVersion: `sha256-${"a".repeat(64)}`,
    ownershipScope: "owner",
    nowMs: NOW,
    toolName: "document_parse",
    networkPolicyChecked: true,
    ...overrides,
  };
}

class FakeDocumentCacheD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly sessionConstraints: string[] = [];
  reads = 0;
  writes = 0;
  failAll = false;
  onRead: (() => void) | undefined;

  prepare(query: string): D1StatementLike {
    return new FakeDocumentCacheStatement(this, query);
  }

  batch(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  withSession(constraint: string): D1DatabaseLike {
    this.sessionConstraints.push(constraint);
    return this;
  }

  rowKey(namespace: unknown, key: unknown): string {
    return `${String(namespace)}\u0000${String(key)}`;
  }

  assertAvailable(): void {
    if (this.failAll) throw new Error(`D1 unavailable ${BACKEND_SECRET}`);
  }
}

class FakeDocumentCacheStatement implements D1StatementLike {
  private bound: readonly unknown[] = [];

  constructor(
    private readonly db: FakeDocumentCacheD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    this.bound = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    this.db.assertAvailable();
    this.db.reads += 1;
    this.db.onRead?.();
    const row = this.db.rows.get(this.db.rowKey(this.bound[0], this.bound[1]));
    if (row === undefined) return Promise.resolve(null);
    const { namespace: ignored, ...selected } = row;
    void ignored;
    return Promise.resolve({ ...selected } as T);
  }

  all<T>(): Promise<{ results: readonly T[] }> {
    this.db.assertAvailable();
    return Promise.resolve({ results: [] });
  }

  run(): Promise<{ success: boolean; meta: { changes: number } }> {
    this.db.assertAvailable();
    this.db.writes += 1;
    if (this.query.startsWith("INSERT INTO durable_records")) {
      const [namespace, key, value, createdAt, updatedAt, expiresAt] = this.bound;
      const id = this.db.rowKey(namespace, key);
      if (this.db.rows.has(id)) {
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.rows.set(id, {
        namespace,
        key,
        value,
        revision: 1,
        created_at: createdAt,
        updated_at: updatedAt,
        expires_at: expiresAt,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith("UPDATE durable_records")) {
      const [value, updatedAt, expiresAt, namespace, key, expectedRevision] =
        this.bound;
      const id = this.db.rowKey(namespace, key);
      const row = this.db.rows.get(id);
      if (row === undefined || row.revision !== expectedRevision) {
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.rows.set(id, {
        ...row,
        value,
        revision: Number(row.revision) + 1,
        updated_at: updatedAt,
        expires_at: expiresAt,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (this.query.startsWith("DELETE FROM durable_records")) {
      const [namespace, key, expectedRevision] = this.bound;
      const id = this.db.rowKey(namespace, key);
      const row = this.db.rows.get(id);
      if (row === undefined || row.revision !== expectedRevision) {
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.rows.delete(id);
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    throw new Error("unexpected D1 statement");
  }
}

class FakeDocumentCacheR2 implements R2BucketLike {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; metadata: Record<string, string> }
  >();
  reads = 0;
  writes = 0;
  deletes = 0;
  failReads = false;
  failWrites = false;

  head(key: string): Promise<R2ObjectLike | null> {
    this.reads += 1;
    if (this.failReads) throw new Error(`R2 read unavailable ${BACKEND_SECRET}`);
    const object = this.objects.get(key);
    return Promise.resolve(
      object === undefined
        ? null
        : {
            size: object.bytes.byteLength,
            customMetadata: { ...object.metadata },
          },
    );
  }

  get(key: string): Promise<R2ObjectBodyLike | null> {
    this.reads += 1;
    if (this.failReads) throw new Error(`R2 read unavailable ${BACKEND_SECRET}`);
    const object = this.objects.get(key);
    if (object === undefined) return Promise.resolve(null);
    return Promise.resolve({
      size: object.bytes.byteLength,
      customMetadata: { ...object.metadata },
      bytes: () => Promise.resolve(object.bytes.slice()),
    });
  }

  put(
    key: string,
    value: Uint8Array,
    options: {
      onlyIf: { etagDoesNotMatch: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<R2ObjectLike | null> {
    this.writes += 1;
    if (this.failWrites) throw new Error(`R2 write unavailable ${BACKEND_SECRET}`);
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.objects.has(key)) return Promise.resolve(null);
    this.objects.set(key, {
      bytes: value.slice(),
      metadata: { ...options.customMetadata },
    });
    return Promise.resolve({
      size: value.byteLength,
      customMetadata: { ...options.customMetadata },
    });
  }

  delete(key: string): Promise<void> {
    this.deletes += 1;
    this.objects.delete(key);
    return Promise.resolve();
  }
}

function fixture(overrides: Partial<DocumentCacheOutboundEnv> = {}) {
  const db = new FakeDocumentCacheD1();
  const bucket = new FakeDocumentCacheR2();
  const clock = new FakeClock(NOW);
  const env: DocumentCacheOutboundEnv = {
    GROUNDLANE_INTERNAL_SIGNING_SECRET: SIGNING_SECRET,
    MANAGED_TOKEN_D1: db,
    GROUNDLANE_ARTIFACTS: bucket,
    DOCUMENT_CACHE_EDGE_ENABLED: "true",
    DOCUMENT_CACHE_DEFAULT_TTL_SECONDS: "120",
    DOCUMENT_CACHE_MAX_TTL_SECONDS: "300",
    ...overrides,
  };
  return {
    db,
    bucket,
    clock,
    env,
    handler: createDocumentCacheOutboundHandler({ subtle, clock }),
  };
}

async function signedRequest(
  clock: FakeClock,
  path: DocumentCacheBridgePath,
  body: unknown,
  signal?: AbortSignal,
): Promise<Request> {
  return buildDocumentCacheBridgeRequest({
    path,
    body: new TextEncoder().encode(JSON.stringify(body)),
    signingSecret: SIGNING_SECRET,
    requestId: `cache-${String(clock.now())}`,
    principal,
    credentialBinding: CREDENTIAL_BINDING,
    subtle,
    clock,
    ...(signal === undefined ? {} : { signal }),
  });
}

function lookupBody(
  clock: FakeClock,
  cacheIdentity: DocumentCacheIdentity,
  deadlineAt = clock.now() + 20_000,
) {
  return {
    version: DOCUMENT_CACHE_BRIDGE_VERSION,
    operation: "lookup" as const,
    deadlineAt,
    identity: cacheIdentity,
  };
}

function commitBody(
  clock: FakeClock,
  cacheIdentity: DocumentCacheIdentity,
  decision: DocumentCacheCommitBridgeRequest["decision"],
  data: unknown,
  deadlineAt = clock.now() + 20_000,
) {
  return {
    version: DOCUMENT_CACHE_BRIDGE_VERSION,
    operation: "commit" as const,
    deadlineAt,
    identity: cacheIdentity,
    execution: { data, provenance },
    decision,
  };
}

async function lookup(
  fx: ReturnType<typeof fixture>,
  cacheIdentity: DocumentCacheIdentity,
  deadlineAt?: number,
) {
  const response = await fx.handler(
    await signedRequest(
      fx.clock,
      DOCUMENT_CACHE_LOOKUP_PATH,
      lookupBody(fx.clock, cacheIdentity, deadlineAt),
    ),
    fx.env,
    context,
  );
  const value: unknown = await response.clone().json();
  return { response, parsed: documentCacheLookupBridgeResponseSchema.parse(value) };
}

async function commit(
  fx: ReturnType<typeof fixture>,
  cacheIdentity: DocumentCacheIdentity,
  decision: DocumentCacheCommitBridgeRequest["decision"],
  data: unknown,
) {
  const response = await fx.handler(
    await signedRequest(
      fx.clock,
      DOCUMENT_CACHE_COMMIT_PATH,
      commitBody(fx.clock, cacheIdentity, decision, data),
    ),
    fx.env,
    context,
  );
  const value: unknown = await response.clone().json();
  return { response, parsed: documentCacheCommitBridgeResponseSchema.parse(value) };
}

void test("document cache outbound handler is directly routable from GroundlaneContainer", () => {
  assert.equal(typeof handleDocumentCacheOutbound, "function");
});

void test("signed revoke invalidates one source across parser options and rejects tampering", async () => {
  const fx = fixture();
  for (const source of [identity(), identity({ sourceIdentity: "other-source" }), identity({ key: { ...cacheKey(), normalizedOptions: "alternate" } })]) {
    const miss = await lookup(fx, source);
    if (!miss.parsed.ok) assert.fail("expected successful lookup");
    if (!miss.parsed.result.cached) await commit(fx, source, miss.parsed.result, { blocks: ["payload"] });
  }
  const body = { version: 1, operation: "revoke", deadlineAt: NOW + 20_000, sourceIdentity: identity().sourceIdentity };
  const request = await signedRequest(fx.clock, DOCUMENT_CACHE_REVOKE_PATH, body);
  const tampered = new Request(request, { body: JSON.stringify({ ...body, sourceIdentity: "other-source" }) });
  assert.equal((await fx.handler(tampered, fx.env, context)).status, 401);
  const response = await fx.handler(await signedRequest(fx.clock, DOCUMENT_CACHE_REVOKE_PATH, body), fx.env, context);
  assert.deepEqual(await response.json(), { version: 1, ok: true, result: "revoked" });
  for (const source of [identity(), identity({ key: { ...cacheKey(), normalizedOptions: "alternate" } })]) {
    const result = await lookup(fx, source);
    assert.ok(result.parsed.ok && !result.parsed.result.cached && result.parsed.result.disposition === "revoked");
  }
  const other = await lookup(fx, identity({ sourceIdentity: "other-source" }));
  assert.ok(other.parsed.ok && other.parsed.result.cached);
  assert.equal((await fx.handler(await signedRequest(fx.clock, DOCUMENT_CACHE_LOOKUP_PATH, body), fx.env, context)).status, 403);
  assert.equal((await fx.handler(await signedRequest(fx.clock, DOCUMENT_CACHE_REVOKE_PATH, { ...body, deadlineAt: NOW }), fx.env, context)).status, 503);
});

void test("verified lookup, commit, and later lookup persist and return one provenance-preserving hit", async () => {
  const fx = fixture();
  const cacheIdentity = identity();
  const first = await lookup(fx, cacheIdentity);
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("cache-control"), "no-store");
  assert.equal(first.parsed.ok, true);
  if (!first.parsed.ok || first.parsed.result.cached) {
    assert.fail("first lookup did not return a miss");
  }

  const written = await commit(fx, cacheIdentity, first.parsed.result, {
    blocks: ["persisted"],
  });
  assert.equal(written.parsed.ok, true);
  if (!written.parsed.ok) assert.fail("commit was rejected");
  assert.equal(written.parsed.result.stored, true);
  assert.equal(written.parsed.result.expiresAt, NOW + 120_000);
  assert.equal(fx.bucket.objects.size, 1);

  const second = await lookup(fx, identity({ nowMs: NOW + 1_000 }));
  assert.equal(second.parsed.ok, true);
  if (!second.parsed.ok || !second.parsed.result.cached) {
    assert.fail("second lookup did not return a hit");
  }
  assert.deepEqual(second.parsed.result.data, { blocks: ["persisted"] });
  assert.deepEqual(second.parsed.result.hit.billingProvenance, provenance);
  assert.equal(second.parsed.result.hit.ageSeconds, 1);
  assert.ok(
    new TextEncoder().encode(await second.response.clone().text()).byteLength <=
      DOCUMENT_CACHE_BRIDGE_MAX_BODY_BYTES,
  );
  assert.ok(
    fx.db.sessionConstraints.every(
      (constraint) => constraint === "first-primary",
    ),
  );
});

void test("Worker recomputes cache TTL from the transported absolute source expiry", async () => {
  const fx = fixture();
  const cacheIdentity = identity({ sourceExpiresAt: NOW + 90_999 });
  const first = await lookup(fx, cacheIdentity);
  if (!first.parsed.ok || first.parsed.result.cached) assert.fail("expected cache miss");
  const written = await commit(fx, cacheIdentity, first.parsed.result, "source-bounded");
  assert.equal(written.parsed.ok, true);
  if (!written.parsed.ok) assert.fail("commit was rejected");
  assert.equal(written.parsed.result.expiresAt, NOW + 90_000);
});

void test("refresh and bypass use their two-phase dispositions without lookup I/O", async () => {
  const fx = fixture();
  const bypassIdentity = identity({ mode: "bypass" });
  const bypass = await lookup(fx, bypassIdentity);
  assert.equal(bypass.parsed.ok, true);
  if (!bypass.parsed.ok || bypass.parsed.result.cached) {
    assert.fail("bypass did not return a miss");
  }
  assert.equal(bypass.parsed.result.disposition, "bypass");
  assert.equal(fx.db.reads + fx.db.writes, 0);
  assert.equal(fx.bucket.reads + fx.bucket.writes, 0);

  const ordinary = await lookup(fx, identity());
  if (!ordinary.parsed.ok || ordinary.parsed.result.cached) {
    assert.fail("ordinary lookup did not miss");
  }
  const old = await commit(fx, identity(), ordinary.parsed.result, "old");
  assert.equal(old.parsed.ok, true);
  const d1OperationsBeforeRefresh = fx.db.reads + fx.db.writes;
  const r2OperationsBeforeRefresh = fx.bucket.reads + fx.bucket.writes;

  const refreshIdentity = identity({ mode: "refresh", nowMs: NOW + 1_000 });
  const refresh = await lookup(fx, refreshIdentity);
  assert.equal(refresh.parsed.ok, true);
  if (!refresh.parsed.ok || refresh.parsed.result.cached) {
    assert.fail("refresh did not return a miss");
  }
  assert.equal(refresh.parsed.result.disposition, "refresh");
  assert.equal(fx.db.reads + fx.db.writes, d1OperationsBeforeRefresh);
  assert.equal(fx.bucket.reads + fx.bucket.writes, r2OperationsBeforeRefresh);

  const written = await commit(
    fx,
    refreshIdentity,
    refresh.parsed.result,
    "replacement",
  );
  assert.equal(written.parsed.ok, true);
  if (!written.parsed.ok) assert.fail("refresh commit was rejected");
  assert.equal(written.parsed.result.stored, true);
  const hit = await lookup(fx, identity({ nowMs: NOW + 2_000 }));
  assert.equal(hit.parsed.ok, true);
  if (!hit.parsed.ok || !hit.parsed.result.cached) {
    assert.fail("replacement did not hit");
  }
  assert.equal(hit.parsed.result.data, "replacement");
});

void test("wrong host, class context, body, path, operation, owner, and schema are rejected", async () => {
  const fx = fixture();
  const body = lookupBody(fx.clock, identity());
  const valid = await signedRequest(fx.clock, DOCUMENT_CACHE_LOOKUP_PATH, body);

  const wrongClass = await fx.handler(
    await signedRequest(fx.clock, DOCUMENT_CACHE_LOOKUP_PATH, body),
    fx.env,
    {
    className: "OtherContainer",
    containerId: "container-one",
    },
  );
  assert.equal(wrongClass.status, 403);

  const wrongContext = await fx.handler(
    await signedRequest(fx.clock, DOCUMENT_CACHE_LOOKUP_PATH, body),
    fx.env,
    {
      ...context,
      params: { untrusted: true },
    },
  );
  assert.equal(wrongContext.status, 403);

  const wrongHost = new Request("http://example.com/v1/lookup", {
    method: "POST",
    headers: valid.headers,
    body: await valid.clone().arrayBuffer(),
  });
  assert.equal((await fx.handler(wrongHost, fx.env, context)).status, 400);

  const tampered = new Request(valid, {
    body: JSON.stringify({ ...body, deadlineAt: body.deadlineAt + 1 }),
  });
  assert.equal((await fx.handler(tampered, fx.env, context)).status, 401);

  const wrongPath = new Request("http://groundlane-cache.internal/v1/nope", {
    method: "POST",
    headers: valid.headers,
    body: await valid.clone().arrayBuffer(),
  });
  assert.equal((await fx.handler(wrongPath, fx.env, context)).status, 400);

  const operationMismatch = await fx.handler(
    await signedRequest(fx.clock, DOCUMENT_CACHE_LOOKUP_PATH, {
      ...body,
      operation: "commit",
      execution: { data: "fresh", provenance },
      decision: { cached: false, disposition: "refresh" },
    }),
    fx.env,
    context,
  );
  assert.equal(operationMismatch.status, 400);

  const wrongOwner = await fx.handler(
    await signedRequest(
      fx.clock,
      DOCUMENT_CACHE_LOOKUP_PATH,
      lookupBody(fx.clock, identity({ ownershipScope: "not-owner" })),
    ),
    fx.env,
    context,
  );
  assert.equal(wrongOwner.status, 403);

  const bodyPolicyOverride = await fx.handler(
    await signedRequest(fx.clock, DOCUMENT_CACHE_LOOKUP_PATH, {
      ...body,
      config: { enabled: true, defaultTtlSeconds: 1, operatorMaxTtlSeconds: 1 },
    }),
    fx.env,
    context,
  );
  assert.equal(bodyPolicyOverride.status, 400);

  for (const response of [wrongClass, wrongContext, operationMismatch, wrongOwner, bodyPolicyOverride]) {
    const responseText = await response.text();
    assert.doesNotMatch(responseText, /credential-private|source-private|not-owner/u);
  }
  assert.equal(fx.db.reads + fx.db.writes, 0);
  assert.equal(fx.bucket.reads + fx.bucket.writes, 0);
});

void test("missing bindings, signing secret, and invalid operator configuration return stable unavailable", async () => {
  const fx = fixture();
  function without(
    key: "MANAGED_TOKEN_D1" | "GROUNDLANE_ARTIFACTS" | "GROUNDLANE_INTERNAL_SIGNING_SECRET",
  ): DocumentCacheOutboundEnv {
    const value: DocumentCacheOutboundEnv = { ...fx.env };
    delete value[key];
    return value;
  }
  const variants: DocumentCacheOutboundEnv[] = [
    without("MANAGED_TOKEN_D1"),
    without("GROUNDLANE_ARTIFACTS"),
    without("GROUNDLANE_INTERNAL_SIGNING_SECRET"),
    { ...fx.env, DOCUMENT_CACHE_EDGE_ENABLED: "yes" },
    {
      ...fx.env,
      DOCUMENT_CACHE_DEFAULT_TTL_SECONDS: "301",
      DOCUMENT_CACHE_MAX_TTL_SECONDS: "300",
    },
  ];
  for (const env of variants) {
    const response = await fx.handler(
      await signedRequest(
        fx.clock,
        DOCUMENT_CACHE_LOOKUP_PATH,
        lookupBody(fx.clock, identity()),
      ),
      env,
      context,
    );
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /DOCUMENT_CACHE_UNAVAILABLE/u);
    assert.doesNotMatch(text, /SIGNING_SECRET|D1|R2|credential-private/u);
  }
});

void test("operator maximum TTL is rejected rather than trusted or silently clamped", async () => {
  const fx = fixture();
  const response = await lookup(
    fx,
    identity({ requestedTtlSeconds: 301 }),
  );
  assert.equal(response.response.status, 400);
  assert.equal(response.parsed.ok, false);
  if (response.parsed.ok) assert.fail("over-cap TTL was accepted");
  assert.equal(response.parsed.error.code, "DOCUMENT_CACHE_INVALID_REQUEST");
  assert.equal(fx.db.reads + fx.db.writes, 0);
  assert.equal(fx.bucket.reads + fx.bucket.writes, 0);

  const belowMinimum = await lookup(
    fx,
    identity({ requestedTtlSeconds: 59 }),
  );
  assert.equal(belowMinimum.response.status, 400);
  assert.equal(belowMinimum.parsed.ok, false);
  assert.equal(fx.db.reads + fx.db.writes, 0);
  assert.equal(fx.bucket.reads + fx.bucket.writes, 0);
});

void test("D1 and R2 faults preserve the fail-open shape and never disclose backend errors", async () => {
  const originalError = console.error;
  const originalLog = console.log;
  const logs: unknown[][] = [];
  console.error = (...values: unknown[]) => { logs.push(values); };
  console.log = (...values: unknown[]) => { logs.push(values); };
  try {
    const d1Fx = fixture();
    d1Fx.db.failAll = true;
    const d1 = await lookup(d1Fx, identity());
    assert.equal(d1.parsed.ok, true);
    if (!d1.parsed.ok || d1.parsed.result.cached) {
      assert.fail("D1 failure did not return a fail-open miss");
    }
    assert.equal(d1.parsed.result.cacheError, "Document cache unavailable");
    assert.doesNotMatch(await d1.response.clone().text(), new RegExp(BACKEND_SECRET, "u"));

    const r2Fx = fixture();
    const initial = await lookup(r2Fx, identity());
    if (!initial.parsed.ok || initial.parsed.result.cached) {
      assert.fail("initial lookup did not miss");
    }
    r2Fx.bucket.failWrites = true;
    const r2 = await commit(
      r2Fx,
      identity(),
      initial.parsed.result,
      "fresh-output",
    );
    assert.equal(r2.parsed.ok, true);
    if (!r2.parsed.ok) assert.fail("R2 fail-open response was rejected");
    assert.equal(r2.parsed.result.data, "fresh-output");
    assert.equal(r2.parsed.result.stored, false);
    assert.equal(r2.parsed.result.cacheError, "Document cache unavailable");
    assert.doesNotMatch(await r2.response.clone().text(), new RegExp(BACKEND_SECRET, "u"));
    assert.deepEqual(logs, []);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

void test("disabled policy performs no cache I/O and returns an honest degraded disposition", async () => {
  const fx = fixture({ DOCUMENT_CACHE_EDGE_ENABLED: "false" });
  const response = await lookup(fx, identity());
  assert.equal(response.parsed.ok, true);
  if (!response.parsed.ok || response.parsed.result.cached) {
    assert.fail("disabled cache did not miss");
  }
  assert.equal(response.parsed.result.disposition, "disabled");
  assert.equal(response.parsed.result.degraded, true);
  assert.equal(fx.db.reads + fx.db.writes, 0);
  assert.equal(fx.bucket.reads + fx.bucket.writes, 0);
});

void test("abort and deadline expiry never return a cache hit", async () => {
  const fx = fixture();
  const first = await lookup(fx, identity());
  if (!first.parsed.ok || first.parsed.result.cached) {
    assert.fail("initial lookup did not miss");
  }
  const written = await commit(fx, identity(), first.parsed.result, "cached");
  assert.equal(written.parsed.ok, true);

  const controller = new AbortController();
  const abortedRequest = await signedRequest(
    fx.clock,
    DOCUMENT_CACHE_LOOKUP_PATH,
    lookupBody(fx.clock, identity()),
    controller.signal,
  );
  controller.abort();
  const aborted = await fx.handler(abortedRequest, fx.env, context);
  assert.equal(aborted.status, 503);
  assert.match(await aborted.text(), /DOCUMENT_CACHE_UNAVAILABLE/u);

  let advanced = false;
  fx.db.onRead = () => {
    if (advanced) return;
    advanced = true;
    fx.clock.advance(25_000);
  };
  const deadline = fx.clock.now() + 20_000;
  const expired = await lookup(fx, identity({ nowMs: NOW + 1_000 }), deadline);
  assert.equal(expired.response.status, 503);
  assert.equal(expired.parsed.ok, false);
  if (expired.parsed.ok) assert.fail("expired cache operation returned a hit");
  assert.equal(expired.parsed.error.code, "DOCUMENT_CACHE_UNAVAILABLE");
});
