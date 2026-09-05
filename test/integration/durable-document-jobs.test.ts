import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import {
  DurableDocumentJobRepository,
  type CreateDurableDocumentJobInput,
  type DurableDocumentEffectIdentity,
} from "../../src/core/durable-document-jobs.js";
import { DurableEffectJournal } from "../../src/core/durable-effects.js";
import { GroundlaneError } from "../../src/core/errors.js";

async function databaseFixture(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-jobs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "state.sqlite");
}

function openRepository(path: string): {
  store: SqliteDurableRecordStore;
  repository: DurableDocumentJobRepository;
} {
  const store = new SqliteDurableRecordStore(path, "document-runtime");
  return {
    store,
    repository: new DurableDocumentJobRepository(
      store,
      new DurableEffectJournal(store),
    ),
  };
}

const CALLER = {
  ownerId: "owner-one",
  credentialBinding: "managed:credential-one",
};

function createInput(
  overrides: Partial<CreateDurableDocumentJobInput> = {},
): CreateDurableDocumentJobInput {
  return {
    ...CALLER,
    idempotencyKey: "request-one",
    requestFingerprint: "sha256-request-one",
    nowMs: 1_000,
    expiresAt: 100_000,
    ...overrides,
  };
}

void test("document job survives close/reopen and resumes from its persisted revision", async (t) => {
  const path = await databaseFixture(t);
  const first = openRepository(path);
  const created = await first.repository.createIfAbsent(createInput());
  assert.equal(created.status, "created");
  const pending = await first.repository.transition(
    created.value.job.jobId,
    CALLER,
    created.value.revision,
    "pending",
    2_000,
  );
  assert.equal(pending.status, "updated");
  first.store.close();

  const reopened = openRepository(path);
  t.after(() => reopened.store.close());
  const resumed = await reopened.repository.resume(
    created.value.job.jobId,
    CALLER,
    3_000,
  );
  assert.equal(resumed.job.status, "pending");
  assert.equal(resumed.revision, 2);
  assert.equal(resumed.job.createdAt, 1_000);
  assert.equal(resumed.job.expiresAt, 100_000);
});

void test("concurrent idempotent create has one durable winner and one provider-effect claim", async (t) => {
  const path = await databaseFixture(t);
  const left = openRepository(path);
  const right = openRepository(path);
  t.after(() => {
    left.store.close();
    right.store.close();
  });

  const [a, b] = await Promise.all([
    left.repository.createIfAbsent(createInput()),
    right.repository.createIfAbsent(createInput()),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ["created", "reused"]);
  assert.equal(a.value.job.jobId, b.value.job.jobId);
  await assert.rejects(
    left.repository.createIfAbsent(
      createInput({ requestFingerprint: "sha256-different-request" }),
    ),
    /different document request/u,
  );

  const effect: DurableDocumentEffectIdentity = {
    jobId: a.value.job.jobId,
    effectKind: "provider_task_create",
    operationKey: "provider-create-one",
  };
  const [firstClaim, secondClaim] = await Promise.all([
    left.repository.beginEffect(effect, CALLER, 2_000),
    right.repository.beginEffect(effect, CALLER, 2_000),
  ]);
  assert.deepEqual(
    [firstClaim.status, secondClaim.status].sort(),
    ["blocked", "execute"],
  );
  const blocked = firstClaim.status === "blocked" ? firstClaim : secondClaim;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "claimed");
});

void test("CAS transition fences stale writers and enforces owner and credential binding", async (t) => {
  const path = await databaseFixture(t);
  const opened = openRepository(path);
  t.after(() => opened.store.close());
  const created = await opened.repository.createIfAbsent(createInput());
  const pending = await opened.repository.transition(
    created.value.job.jobId,
    CALLER,
    created.value.revision,
    "pending",
    2_000,
  );
  assert.equal(pending.status, "updated");

  const stale = await opened.repository.transition(
    created.value.job.jobId,
    CALLER,
    created.value.revision,
    "running",
    3_000,
  );
  assert.equal(stale.status, "conflict");
  assert.equal(stale.value.job.status, "pending");
  assert.equal(stale.value.revision, 2);

  await assert.rejects(
    opened.repository.get(
      created.value.job.jobId,
      { ...CALLER, ownerId: "owner-other" },
      3_000,
    ),
    (error: unknown) =>
      error instanceof GroundlaneError && /Owner mismatch/u.test(error.message),
  );
  await assert.rejects(
    opened.repository.get(
      created.value.job.jobId,
      { ...CALLER, credentialBinding: "managed:credential-other" },
      3_000,
    ),
    (error: unknown) =>
      error instanceof GroundlaneError && /Credential binding mismatch/u.test(error.message),
  );
});

void test("expiry is materialized durably and remains terminal after restart", async (t) => {
  const path = await databaseFixture(t);
  const first = openRepository(path);
  const created = await first.repository.createIfAbsent(
    createInput({ expiresAt: 2_000 }),
  );
  first.store.close();

  const second = openRepository(path);
  const expired = await second.repository.get(
    created.value.job.jobId,
    CALLER,
    2_001,
  );
  assert.equal(expired.job.status, "expired");
  assert.equal(expired.revision, 2);
  second.store.close();

  const third = openRepository(path);
  t.after(() => third.store.close());
  const resumed = await third.repository.resume(
    created.value.job.jobId,
    CALLER,
    3_000,
  );
  assert.equal(resumed.job.status, "expired");
  await assert.rejects(
    third.repository.beginEffect(
      {
        jobId: created.value.job.jobId,
        effectKind: "paid_upstream_call",
        operationKey: "too-late",
      },
      CALLER,
      3_000,
    ),
    /terminal document job/u,
  );
});

void test("provider crash gap becomes uncertain while paid calls and artifact writes replay", async (t) => {
  const path = await databaseFixture(t);
  const first = openRepository(path);
  const created = await first.repository.createIfAbsent(createInput());
  const providerEffect: DurableDocumentEffectIdentity = {
    jobId: created.value.job.jobId,
    effectKind: "provider_task_create",
    operationKey: "provider-create-crash",
  };
  const providerClaim = await first.repository.beginEffect(
    providerEffect,
    CALLER,
    2_000,
  );
  assert.equal(providerClaim.status, "execute");
  if (providerClaim.status !== "execute") assert.fail("provider effect was not claimed");
  const providerInflight = await first.repository.markEffectInflight(
    providerEffect,
    CALLER,
    providerClaim.revision,
    2_100,
  );
  first.store.close();

  const afterCrash = openRepository(path);
  const blocked = await afterCrash.repository.beginEffect(
    providerEffect,
    CALLER,
    3_000,
  );
  assert.equal(blocked.status, "blocked");
  if (blocked.status !== "blocked") assert.fail("inflight provider effect was replayed");
  assert.equal(blocked.reason, "inflight");
  const uncertain = await afterCrash.repository.markEffectUncertain(
    providerEffect,
    CALLER,
    blocked.revision,
    3_100,
  );
  assert.equal(uncertain.effect.status, "uncertain");
  await assert.rejects(
    afterCrash.repository.markEffectSucceeded(
      providerEffect,
      CALLER,
      providerInflight.revision,
      3_200,
      "late-provider-receipt",
    ),
    /revision conflict/u,
  );
  afterCrash.store.close();

  const final = openRepository(path);
  t.after(() => final.store.close());
  const stillUncertain = await final.repository.beginEffect(
    providerEffect,
    CALLER,
    4_000,
  );
  assert.equal(stillUncertain.status, "blocked");
  if (stillUncertain.status === "blocked") {
    assert.equal(stillUncertain.reason, "uncertain");
  }

  for (const [effectKind, operationKey, receipt] of [
    ["paid_upstream_call", "paid-call-one", "billing-receipt-one"],
    ["artifact_write", "artifact-write-one", "artifact-ref-one"],
  ] as const) {
    const identity: DurableDocumentEffectIdentity = {
      jobId: created.value.job.jobId,
      effectKind,
      operationKey,
    };
    const claim = await final.repository.beginEffect(identity, CALLER, 4_100);
    assert.equal(claim.status, "execute");
    if (claim.status !== "execute") assert.fail("effect was not claimed");
    const inflight = await final.repository.markEffectInflight(
      identity,
      CALLER,
      claim.revision,
      4_200,
    );
    await final.repository.markEffectSucceeded(
      identity,
      CALLER,
      inflight.revision,
      4_300,
      receipt,
    );
    const replay = await final.repository.beginEffect(identity, CALLER, 4_400);
    assert.equal(replay.status, "replay");
    if (replay.status === "replay") assert.equal(replay.receipt, receipt);
  }
});
