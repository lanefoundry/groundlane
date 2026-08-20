import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrencyLimiter, Deadline, truncateUnicode, withinDeadline } from "../../src/core/limits.js";

void test("Deadline retains one decreasing budget", async () => {
  const deadline = new Deadline(100); const first = deadline.remainingMs();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(deadline.remainingMs() < first);
});

void test("withinDeadline cancels an operation at the shared deadline", async () => {
  await assert.rejects(withinDeadline(() => new Promise(() => {}), new Deadline(5), undefined, "test"), { code: "DEADLINE_EXCEEDED", stage: "test" });
});

void test("ConcurrencyLimiter bounds active work, queue and releases once", async () => {
  const limiter = new ConcurrencyLimiter(1, 1); const deadline = new Deadline(1_000);
  const release = await limiter.acquire(deadline); const waiting = limiter.acquire(deadline);
  await assert.rejects(limiter.acquire(deadline), { code: "CONCURRENCY_LIMIT" });
  release(); release(); const releaseWaiting = await waiting;
  assert.equal(limiter.active, 1); releaseWaiting(); assert.equal(limiter.active, 0);
});

void test("ConcurrencyLimiter removes cancelled queued entries", async () => {
  const limiter = new ConcurrencyLimiter(1, 1); const release = await limiter.acquire(new Deadline(1_000)); const controller = new AbortController();
  const waiting = limiter.acquire(new Deadline(1_000), controller.signal); controller.abort();
  await assert.rejects(waiting, { code: "CANCELLED" }); assert.equal(limiter.queued, 0); release();
});

void test("truncateUnicode never splits surrogate pairs", () => {
  assert.deepEqual(truncateUnicode("A😀B", 2), { value: "A😀", truncated: true, originalLength: 3, returnedLength: 2 });
});
