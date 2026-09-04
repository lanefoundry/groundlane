import assert from "node:assert/strict";
import test from "node:test";

import {
  CrawlJobManager,
  InMemoryCrawlJobStore,
  type CrawlProviderPort,
} from "../../src/core/crawl-jobs.js";
import { GroundlaneError } from "../../src/core/errors.js";

// ---------------------------------------------------------------------------
// Helpers: deterministic fake crawl provider (no network, no live bindings)
// ---------------------------------------------------------------------------

interface FakeCrawlProvider extends CrawlProviderPort {
  readonly started: string[];
  readonly cancelled: string[];
  ackNextCancel: boolean;
  failNextFetchWith: unknown;
  pages: { url: string; contentChars: number }[];
}

function makeFakeCrawlProvider(): FakeCrawlProvider {
  const started: string[] = [];
  const cancelled: string[] = [];
  let counter = 0;
  const port: FakeCrawlProvider = {
    started,
    cancelled,
    ackNextCancel: true,
    failNextFetchWith: null,
    pages: [
      { url: "https://example.com/a", contentChars: 1000 },
      { url: "https://example.com/b", contentChars: 2000 },
      { url: "https://example.com/c", contentChars: 3000 },
      { url: "https://example.com/d", contentChars: 4000 },
      { url: "https://example.com/e", contentChars: 5000 },
    ],
    startCrawl: () => {
      counter += 1;
      const id = `prov-crawl-${String(counter).padStart(3, "0")}`;
      started.push(id);
      return id;
    },
    fetchUpstreamPages: (providerJobId: string, cursor: string | null) => {
      void providerJobId;
      if (port.failNextFetchWith !== null) {
        const failure: unknown = port.failNextFetchWith;
        port.failNextFetchWith = null;
        throw failure;
      }
      const offset = cursor === null ? 0 : Number(cursor.split(":")[1]);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`malformed upstream cursor "${cursor ?? ""}"`);
      }
      const page = port.pages[offset];
      if (page === undefined) {
        return { pages: [], nextCursor: null };
      }
      const fetchedAt = "2026-02-01T00:01:00.000Z";
      const nextOffset = offset + 1;
      return {
        pages: [
          { url: page.url, contentChars: page.contentChars, fetchedAt },
        ],
        nextCursor: nextOffset < port.pages.length ? `offset:${String(nextOffset)}` : null,
      };
    },
    cancelUpstream: (providerJobId: string) => {
      cancelled.push(providerJobId);
      if (port.ackNextCancel) {
        return {
          providerResponseCode: 200,
          acknowledgedAt: "2026-02-01T00:05:00.000Z",
        };
      }
      return null;
    },
  };
  return port;
}

const NOW = new Date("2026-02-01T00:00:00.000Z");
const CALLER = { ownerId: "owner-abc", credentialBinding: "CRAWL-BINDING-1" };
const BUDGETS = { maxPages: 10, maxBytes: 1_000_000, maxOutputChars: 100_000 };

function makeManager(): { manager: CrawlJobManager; provider: FakeCrawlProvider } {
  const provider = makeFakeCrawlProvider();
  const manager = new CrawlJobManager({
    store: new InMemoryCrawlJobStore(),
    provider,
  });
  return { manager, provider };
}

function expectGroundlaneError(fn: () => unknown, code: string, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GroundlaneError, "expected a GroundlaneError");
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return;
  }
  assert.fail("expected function to throw");
}

// ---------------------------------------------------------------------------
// PRD 644: durable crawl job runtime — deterministic integration tests
// ---------------------------------------------------------------------------

void test("PRD 644 runtime: create/status/ingest/result round trip", () => {
  const { manager, provider } = makeManager();
  const { job, reused } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  assert.equal(reused, false);
  assert.equal(job.status, "created");
  assert.ok(!JSON.stringify(job).includes(provider.started[0] ?? "prov-crawl-"), "provider job ID leaked at create");

  manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  const status = manager.status(job.groundlaneJobId, CALLER, NOW);
  assert.equal(status.status, "crawling");
  assert.equal(status.totalPages, 2);
  assert.equal(status.partialResults?.length, 2);

  const result = manager.result(job.groundlaneJobId, CALLER, { pageSize: 10 }, NOW);
  assert.equal(result.items.length, 2);
  assert.equal(result.nextCursor, null);
  assert.ok(!JSON.stringify(result).includes(provider.started[0] ?? "prov-crawl-"), "provider job ID leaked at result");
});

void test("PRD 644 runtime: owner mismatch rejected", () => {
  const { manager } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  expectGroundlaneError(
    () => manager.status(job.groundlaneJobId, { ...CALLER, ownerId: "owner-evil" }, NOW),
    "INVALID_INPUT",
    /Owner mismatch/,
  );
});

void test("PRD 644 runtime: expired and unknown jobs rejected", () => {
  const { manager } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 60,
    now: NOW,
  });
  expectGroundlaneError(
    () => manager.status(job.groundlaneJobId, CALLER, new Date("2026-02-01T02:00:00.000Z")),
    "DEADLINE_EXCEEDED",
    /expired/,
  );
  expectGroundlaneError(
    () => manager.status("gl-crawl-999999", CALLER),
    "INVALID_INPUT",
    /Unknown crawl job/,
  );
});

void test("PRD 644 runtime: credential binding enforced", () => {
  const { manager } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  expectGroundlaneError(
    () => manager.result(job.groundlaneJobId, { ...CALLER, credentialBinding: "OTHER" }, {}, NOW),
    "INVALID_INPUT",
    /Credential binding mismatch/,
  );
});

void test("PRD 644 runtime: pagination over partial results", () => {
  const { manager } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  for (let i = 0; i < 5; i += 1) {
    manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  }
  const first = manager.result(job.groundlaneJobId, CALLER, { pageSize: 2 }, NOW);
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor !== null, "expected a next cursor");
  const second = manager.result(job.groundlaneJobId, CALLER, {
    pageSize: 2,
    cursor: first.nextCursor,
  }, NOW);
  assert.equal(second.items.length, 2);
  const third = manager.result(job.groundlaneJobId, CALLER, {
    pageSize: 2,
    cursor: second.nextCursor,
  }, NOW);
  assert.equal(third.items.length, 1);
  assert.equal(third.nextCursor, null);
  expectGroundlaneError(
    () => manager.result(job.groundlaneJobId, CALLER, { cursor: "bogus" }, NOW),
    "INVALID_INPUT",
    /cursor/i,
  );
});

void test("PRD 644 runtime: page budget exceeded fails job but keeps partials", () => {
  const { manager } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: { maxPages: 2, maxBytes: 1_000_000, maxOutputChars: 100_000 },
    ttlSeconds: 3600,
    now: NOW,
  });
  manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  expectGroundlaneError(
    () => manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW),
    "OUTPUT_LIMIT",
    /Page budget exceeded/,
  );
  const status = manager.status(job.groundlaneJobId, CALLER, NOW);
  assert.equal(status.status, "failed");
  assert.equal(status.partialResults?.length, 2);
});

void test("PRD 644 runtime: output char budget exceeded fails job", () => {
  const { manager } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: { maxPages: 10, maxBytes: 1_000_000, maxOutputChars: 2500 },
    ttlSeconds: 3600,
    now: NOW,
  });
  manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  expectGroundlaneError(
    () => manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW),
    "OUTPUT_LIMIT",
    /Output char budget exceeded/,
  );
});

void test("PRD 644 runtime: upstream cancel without ack stays crawling", () => {
  const { manager, provider } = makeManager();
  provider.ackNextCancel = false;
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  const outcome = manager.requestUpstreamCancel(job.groundlaneJobId, CALLER, NOW);
  assert.equal(outcome.cancelResult.upstreamCancelled, false);
  assert.equal(outcome.job.status, "crawling");
  assert.equal(provider.cancelled.length, 1);
});

void test("PRD 644 runtime: upstream cancel with ack transitions status", () => {
  const { manager } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW);
  const outcome = manager.requestUpstreamCancel(job.groundlaneJobId, CALLER, NOW);
  assert.equal(outcome.cancelResult.upstreamCancelled, true);
  assert.equal(outcome.cancelResult.providerAcknowledgment?.providerResponseCode, 200);
  assert.equal(outcome.job.status, "cancelled_by_upstream");
});

void test("PRD 644 runtime: caller cancel and groundlane cancel are independent", () => {
  const first = makeManager();
  const created = first.manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  const callerOnly = first.manager.cancelCallerWait(created.job.groundlaneJobId, CALLER, NOW);
  assert.equal(callerOnly.status, "cancelled_by_caller");

  const second = makeManager();
  const created2 = second.manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  const groundlaneOnly = second.manager.cancelGroundlanePolling(created2.job.groundlaneJobId, CALLER, NOW);
  assert.equal(groundlaneOnly.status, "cancelled_by_groundlane");
});

void test("PRD 644 runtime: sanitized upstream failures", () => {
  const { manager, provider } = makeManager();
  const { job } = manager.create({
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    now: NOW,
  });
  provider.failNextFetchWith = new Error("crawl backend exploded api_key=live-secret-999\n    at hidden (/srv/x.ts:9:9)");
  expectGroundlaneError(
    () => manager.ingestUpstream(job.groundlaneJobId, CALLER, NOW),
    "UPSTREAM_ERROR",
    /upstream/i,
  );
  const status = manager.status(job.groundlaneJobId, CALLER, NOW);
  assert.equal(status.status, "failed");
  const serialised = JSON.stringify(status);
  assert.ok(!serialised.includes("live-secret-999"), "upstream secret leaked");
  assert.ok(!serialised.includes(provider.started[0] ?? "prov-crawl-"), "provider job ID leaked");
});

void test("PRD 722 runtime: idempotent crawl create issues one provider task", () => {
  const { manager, provider } = makeManager();
  const input = {
    ownerId: CALLER.ownerId,
    credentialBinding: CALLER.credentialBinding,
    seedUrl: "https://example.com/",
    budgets: BUDGETS,
    ttlSeconds: 3600,
    idempotencyKey: "crawl-idem-1",
    now: NOW,
  };
  const first = manager.create(input);
  const second = manager.create(input);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.job.groundlaneJobId, first.job.groundlaneJobId);
  assert.equal(provider.started.length, 1);
});

void test("PRD 644 runtime: invalid seed URLs rejected", () => {
  const { manager } = makeManager();
  expectGroundlaneError(
    () => manager.create({
      ownerId: CALLER.ownerId,
      credentialBinding: CALLER.credentialBinding,
      seedUrl: "https://user:pass@example.com/",
      budgets: BUDGETS,
      ttlSeconds: 3600,
      now: NOW,
    }),
    "INVALID_INPUT",
    /credentials/,
  );
  expectGroundlaneError(
    () => manager.create({
      ownerId: CALLER.ownerId,
      credentialBinding: CALLER.credentialBinding,
      seedUrl: "gopher://example.com/",
      budgets: BUDGETS,
      ttlSeconds: 3600,
      now: NOW,
    }),
    "INVALID_INPUT",
    /HTTP/,
  );
});

void test("PRD 644 runtime: invalid budgets rejected before provider task", () => {
  const { manager, provider } = makeManager();
  expectGroundlaneError(
    () => manager.create({
      ownerId: CALLER.ownerId,
      credentialBinding: CALLER.credentialBinding,
      seedUrl: "https://example.com/",
      budgets: { maxPages: 0, maxBytes: 1000, maxOutputChars: 1000 },
      ttlSeconds: 3600,
      now: NOW,
    }),
    "INVALID_INPUT",
    /maxPages/,
  );
  assert.equal(provider.started.length, 0);
});
