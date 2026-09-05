import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { InMemoryDurableRecordStore } from "../../src/core/durable-store.js";
import type { ImmutableBlobPort } from "../../src/core/immutable-blob.js";
import { runArtifactCleanup } from "../../src/worker/artifact-cleanup.js";

void test("reference deployment schedules artifact cleanup at least hourly", async () => {
  const config = await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"crons"\s*:\s*\[[^\]]*"0 \* \* \* \*"/u);
});

void test("scheduled artifact cleanup keeps metadata and staging scans independently bounded", async () => {
  const cursors: Array<string | null> = [];
  const records = new InMemoryDurableRecordStore();
  const immutableBlobs: ImmutableBlobPort = {
    putIfAbsent: () => Promise.reject(new Error("unused")),
    stat: () => Promise.resolve(null),
    get: () => Promise.resolve(null),
    deleteIfOwner: () => Promise.resolve("missing"),
  };
  const staging = {
    cleanupExpiredPage(_nowMs: number, cursor: string | null, limit: number) {
      assert.equal(limit, 2);
      cursors.push(cursor);
      return Promise.resolve(cursor === null
        ? { scanned: 2, deleted: 1, failures: [] as string[], nextCursor: "cursor-1" }
        : { scanned: 1, deleted: 1, failures: ["staging/bad"], nextCursor: null });
    },
  };

  const result = await runArtifactCleanup({}, {
    now: () => 1_800_000_000_000,
    records,
    immutableBlobs,
    staging,
    pageSize: 2,
    maxPages: 2,
  });
  assert.deepEqual(cursors, [null, "cursor-1"]);
  assert.equal(result.stagingScanned, 3);
  assert.equal(result.stagingDeleted, 2);
  assert.deepEqual(result.failures, ["staging/bad"]);
});
