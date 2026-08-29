import assert from "node:assert/strict";
import test from "node:test";

import type {
  MapProvider,
  MapProviderId,
  MapProviderResult,
  MapRequest,
} from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { MapRouter } from "../../src/core/map-router.js";

function mapResult(id: MapProviderId): MapProviderResult {
  return {
    provider: id,
    url: "https://example.com",
    links: [
      { url: `https://example.com/${id}`, provider: id },
      { url: "https://example.com/shared", provider: id },
    ],
    durationMs: 1,
    warnings: [],
  };
}

function provider(id: MapProviderId, behavior: "ok" | "retry" | "fatal", supports = true): MapProvider {
  return {
    id,
    supports: () => supports,
    map(): Promise<MapProviderResult> {
      if (behavior === "retry") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_map", "down", true));
      }
      if (behavior === "fatal") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_map", "bad request"));
      }
      return Promise.resolve(mapResult(id));
    },
  };
}

const request: MapRequest = {
  url: "https://example.com",
  maxLinks: 10,
};

void test("MapRouter fans out to multiple providers in parallel and dedupes links", async () => {
  const calls: MapProviderId[] = [];
  const makeProvider = (id: MapProviderId): MapProvider => ({
    id,
    supports: () => true,
    map(): Promise<MapProviderResult> {
      calls.push(id);
      return Promise.resolve(mapResult(id));
    },
  });

  const result = await new MapRouter(
    [makeProvider("firecrawl"), makeProvider("tavily")],
    ["firecrawl", "tavily"],
  ).map(request, new AbortController().signal);

  assert.deepEqual(calls.sort(), ["firecrawl", "tavily"]);
  assert.equal(result.strategy, "parallel");
  assert.deepEqual(result.providersSelected, ["firecrawl", "tavily"]);
  assert.deepEqual(result.providersAttempted, ["firecrawl", "tavily"]);
  assert.deepEqual(result.providersSucceeded, ["firecrawl", "tavily"]);
  assert.equal(result.links.filter((link) => link.url === "https://example.com/shared").length, 1);
});

void test("MapRouter returns partial success with sanitized warnings", async () => {
  const result = await new MapRouter(
    [provider("firecrawl", "ok"), provider("tavily", "retry")],
    ["firecrawl", "tavily"],
  ).map(request, new AbortController().signal);

  assert.deepEqual(result.providersSucceeded, ["firecrawl"]);
  assert.deepEqual(result.warnings, ["tavily unavailable"]);
});

void test("MapRouter fallback stops at first successful provider", async () => {
  const result = await new MapRouter(
    [provider("firecrawl", "retry"), provider("tavily", "ok")],
    ["firecrawl", "tavily"],
  ).map({ ...request, strategy: "fallback" }, new AbortController().signal);

  assert.equal(result.strategy, "fallback");
  assert.deepEqual(result.providersAttempted, ["firecrawl", "tavily"]);
  assert.deepEqual(result.providersSucceeded, ["tavily"]);
});

void test("MapRouter rejects unsafe URLs and conflicting selectors", async () => {
  await assert.rejects(
    new MapRouter([provider("firecrawl", "ok")], ["firecrawl"]).map(
      { ...request, url: "http://127.0.0.1/" },
      new AbortController().signal,
    ),
    { code: "URL_BLOCKED" },
  );
  await assert.rejects(
    new MapRouter([provider("firecrawl", "ok")], ["firecrawl"]).map(
      { ...request, provider: "firecrawl", providers: ["firecrawl"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("MapRouter explicit provider propagates non-retryable errors", async () => {
  await assert.rejects(
    new MapRouter([provider("firecrawl", "fatal")], ["firecrawl"]).map(
      { ...request, provider: "firecrawl" },
      new AbortController().signal,
    ),
    /bad request/u,
  );
});
