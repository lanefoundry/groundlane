import assert from "node:assert/strict";
import test from "node:test";

import type {
  ResearchProvider,
  ResearchProviderId,
  ResearchProviderResult,
  ResearchRequest,
} from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { ResearchRouter } from "../../src/core/research-router.js";

function researchResult(id: ResearchProviderId): ResearchProviderResult {
  return {
    provider: id,
    report: `${id} report`,
    citations: [],
    durationMs: 1,
    warnings: [],
  };
}

function provider(id: ResearchProviderId, behavior: "ok" | "retry" | "fatal", supports = true): ResearchProvider {
  return {
    id,
    supports: () => supports,
    research(): Promise<ResearchProviderResult> {
      if (behavior === "retry") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_research", "down", true));
      }
      if (behavior === "fatal") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_research", "bad request"));
      }
      return Promise.resolve(researchResult(id));
    },
  };
}

const request: ResearchRequest = {
  query: "groundlane",
  effort: "standard",
};

void test("ResearchRouter fans out to multiple providers in parallel and keeps attribution", async () => {
  const calls: ResearchProviderId[] = [];
  const makeProvider = (id: ResearchProviderId): ResearchProvider => ({
    id,
    supports: () => true,
    research(): Promise<ResearchProviderResult> {
      calls.push(id);
      return Promise.resolve(researchResult(id));
    },
  });

  const result = await new ResearchRouter(
    [makeProvider("you"), makeProvider("parallel")],
    ["you", "parallel"],
  ).research(request, new AbortController().signal);

  assert.deepEqual(calls.sort(), ["parallel", "you"]);
  assert.equal(result.strategy, "parallel");
  assert.deepEqual(result.providersSelected, ["you", "parallel"]);
  assert.deepEqual(result.providersAttempted, ["you", "parallel"]);
  assert.deepEqual(result.providersSucceeded, ["you", "parallel"]);
  assert.deepEqual(result.reports.map((report) => report.provider), ["you", "parallel"]);
});

void test("ResearchRouter returns partial success with sanitized provider warnings", async () => {
  const result = await new ResearchRouter(
    [provider("you", "ok"), provider("parallel", "retry")],
    ["you", "parallel"],
  ).research(request, new AbortController().signal);

  assert.deepEqual(result.providersSucceeded, ["you"]);
  assert.deepEqual(result.warnings, ["parallel unavailable"]);
});

void test("ResearchRouter fallback stops at first successful provider", async () => {
  const result = await new ResearchRouter(
    [provider("you", "retry"), provider("parallel", "ok")],
    ["you", "parallel"],
  ).research({ ...request, strategy: "fallback" }, new AbortController().signal);

  assert.equal(result.strategy, "fallback");
  assert.deepEqual(result.providersAttempted, ["you", "parallel"]);
  assert.deepEqual(result.providersSucceeded, ["parallel"]);
  assert.deepEqual(result.warnings, ["you unavailable"]);
});

void test("ResearchRouter rejects unsupported and conflicting requests", async () => {
  const router = new ResearchRouter([provider("you", "ok", false)], ["you"]);
  await assert.rejects(router.research(request, new AbortController().signal), {
    code: "PROVIDER_UNAVAILABLE",
  });
  await assert.rejects(
    new ResearchRouter([provider("you", "ok")], ["you"]).research(
      { ...request, provider: "you", providers: ["you"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
  await assert.rejects(
    new ResearchRouter([provider("you", "ok")], ["you"]).research(
      { ...request, domains: ["example.com"], excludeDomains: ["ads.example.com"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("ResearchRouter explicit provider propagates non-retryable errors", async () => {
  await assert.rejects(
    new ResearchRouter([provider("parallel", "fatal")], ["parallel"]).research(
      { ...request, provider: "parallel" },
      new AbortController().signal,
    ),
    /bad request/u,
  );
});
