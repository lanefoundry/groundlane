import assert from "node:assert/strict";
import test from "node:test";
import { DocumentAdmissionStagingStore } from "../../src/core/document-admission-staging.js";
import { InMemoryDurableRecordStore } from "../../src/core/durable-store.js";

void test("admission staging reads existing records and collects create-only writes without publishing", async () => {
  const durable = new InMemoryDurableRecordStore();
  await durable.createIfAbsent({ key: "existing", value: "original", nowMs: 1000 });
  const stage = new DocumentAdmissionStagingStore(durable);
  assert.equal((await stage.get("existing"))?.value, "original");
  assert.equal((await stage.createIfAbsent({ key: "existing", value: "replacement", nowMs: 1001 })).status, "exists");
  const write = { key: "new", value: "staged", nowMs: 1001 };
  assert.equal((await stage.createIfAbsent(write)).status, "created");
  assert.equal((await stage.createIfAbsent(write)).status, "exists");
  assert.equal((await stage.get("new"))?.value, "staged");
  assert.equal(await durable.get("new"), null);
  assert.deepEqual(stage.records(), [write]);
  await assert.rejects(stage.compareAndSwap());
  await assert.rejects(stage.deleteIfRevision());
  await assert.rejects(stage.scanExpired());
});
