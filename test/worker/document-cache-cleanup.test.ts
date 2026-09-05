import assert from "node:assert/strict";
import test from "node:test";

import { runDocumentCacheCleanup } from "../../src/worker/document-cache-cleanup.js";

void test("document cache cleanup is disabled without explicit edge configuration", async () => {
  assert.deepEqual(await runDocumentCacheCleanup({}), {
    configured: false,
    scanned: 0,
    removed: 0,
    pages: 0,
    retryPending: false,
  });
});

void test("document cache cleanup stops at its page budget and reports pending work", async () => {
  const cursors: Array<string | null> = [];
  const result = await runDocumentCacheCleanup({}, {
    now: () => 1_800_000_000_000,
    pageSize: 2,
    maxPages: 2,
    runtime: {
      sweepExpiredPage(_nowMs, cursor, limit) {
        cursors.push(cursor);
        assert.equal(limit, 2);
        return Promise.resolve({ scanned: 2, removed: 1, nextCursor: `page-${String(cursors.length)}` });
      },
    },
  });
  assert.deepEqual(cursors, [null, "page-1"]);
  assert.deepEqual(result, {
    configured: true,
    scanned: 4,
    removed: 2,
    pages: 2,
    retryPending: true,
  });
});
