import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentAdmissionInput } from "../../src/core/document-admission.js";
import { D1DocumentAdmission } from "../../src/worker/d1-document-admission.js";
import { SqliteD1 } from "../support/sqlite-d1-admission.js";

function setup() {
  const db = new SqliteD1();
  const value = JSON.stringify({ status: "active", expiresAt: 2_000, ownerId: "owner", credentialBinding: "private-binding" });
  db.db.prepare("INSERT INTO durable_records VALUES(?,?,?,1,1000,1000,2000)").run("uploads", "source", value);
  const input: DocumentAdmissionInput = {
    source: { namespace: "uploads", key: "source", revision: 1, value }, nowMs: 1_001,
    writes: ["job", "snapshot", "outbox"].map((name) => ({ namespace: name, record: { key: name, value: JSON.stringify({ name }), nowMs: 1_001, expiresAt: 1_999 } })),
  };
  return { db, input, admission: new D1DocumentAdmission(db), rows: () => db.db.prepare("SELECT * FROM durable_records WHERE namespace != 'uploads'").all() };
}

void test("atomic source admission publishes all metadata and outbox, replay is conflict", async () => {
  const f = setup();
  try {
    assert.equal(await f.admission.commit(f.input), "committed"); assert.equal(f.rows().length, 3);
    assert.ok(f.db.sessions > 0); assert.equal(await f.admission.commit(f.input), "conflict"); assert.equal(f.rows().length, 3);
  } finally { f.db.db.close(); }
});

void test("delete between source inspection and batch leaves no admitted metadata", async () => {
  const f = setup();
  try {
    f.db.beforeBatch = () => { f.db.db.prepare("UPDATE durable_records SET value=?,revision=2 WHERE namespace='uploads'").run(JSON.stringify({ status: "deleted", expiresAt: 2_000 })); };
    assert.equal(await f.admission.commit(f.input), "source_unavailable"); assert.equal(f.rows().length, 0);
  } finally { f.db.db.close(); }
});

void test("source expiry, changed revision, changed value and malformed JSON all fail closed", async () => {
  for (const kind of ["expiry", "revision", "value", "malformed", "string-expiry"]) {
    const f = setup();
    try {
      let input = f.input;
      if (kind === "expiry") input = { ...input, nowMs: 2_000, writes: input.writes.map((write) => ({ ...write, record: { ...write.record, nowMs: 2_000, expiresAt: 3_000 } })) };
      else if (kind === "revision") f.db.db.exec("UPDATE durable_records SET revision=2 WHERE namespace='uploads'");
      else {
        const value = kind === "value" ? JSON.stringify({ status: "active", expiresAt: 2_000, different: true })
          : kind === "malformed" ? "not-json" : JSON.stringify({ status: "active", expiresAt: "9999" });
        f.db.db.prepare("UPDATE durable_records SET value=? WHERE namespace='uploads'").run(value);
        if (kind !== "value") input = { ...input, source: { ...input.source, value } };
      }
      assert.equal(await f.admission.commit(input), "source_unavailable", kind); assert.equal(f.rows().length, 0);
    } finally { f.db.db.close(); }
  }
});

void test("collision on any write prevents all other writes", async () => {
  const f = setup();
  try {
    f.db.db.exec("INSERT INTO durable_records VALUES('outbox','outbox','existing',1,1000,1000,NULL)");
    assert.equal(await f.admission.commit(f.input), "conflict"); assert.equal(f.rows().length, 1);
  } finally { f.db.db.close(); }
});

void test("mid-batch SQL failure rolls back earlier inserts and never exposes private error", async () => {
  const f = setup();
  try {
    f.db.failAt = 2;
    await assert.rejects(f.admission.commit(f.input), (error: unknown) => error instanceof Error && !error.message.includes("private"));
    assert.equal(f.rows().length, 0);
  } finally { f.db.db.close(); }
});

void test("admission rejects unbounded or ambiguous write sets before database I/O", async () => {
  const f = setup();
  try {
    for (const input of [
      { ...f.input, writes: [] },
      { ...f.input, writes: [...f.input.writes, ...f.input.writes] },
      { ...f.input, writes: [{ namespace: "uploads", record: { key: "source", value: "{}", nowMs: 1_001 } }] },
      { ...f.input, writes: [{ namespace: "jobs", record: { key: "job", value: "x".repeat(65_537), nowMs: 1_001 } }] },
    ]) await assert.rejects(f.admission.commit(input));
    assert.equal(f.db.sessions, 0); assert.equal(f.rows().length, 0);
  } finally { f.db.db.close(); }
});
