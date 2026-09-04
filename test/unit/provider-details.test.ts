import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProviderDetail,
  SearchProvider,
  SearchRequest,
  SearchResult,
} from "../../src/core/contracts.js";
import { SearchRouter } from "../../src/core/search-router.js";

function makeProvider(id: string): SearchProvider {
  return {
    id,
    supports: () => true,
    search(request): Promise<SearchResult> {
      return Promise.resolve({
        query: request.query,
        provider: id,
        results: [
          { title: "A", url: "https://example.com", snippet: "S", provider: id },
        ],
        durationMs: 1,
        warnings: [],
      });
    },
  };
}

const request: SearchRequest = {
  query: "test",
  maxResults: 5,
  provider: "auto",
  strategy: "fallback",
};

// ── Schema snapshot ──

void test("ProviderDetail schema snapshot: built-in provider shape", () => {
  const detail: ProviderDetail = {
    providerId: "tavily",
    backend: "api",
    ownership: "built-in",
    protocolVersion: "1",
  };
  assert.deepEqual(Object.keys(detail).sort(), [
    "backend",
    "ownership",
    "protocolVersion",
    "providerId",
  ]);
  assert.equal(typeof detail.providerId, "string");
  assert.equal(typeof detail.backend, "string");
  assert.equal(typeof detail.ownership, "string");
  assert.equal(typeof detail.protocolVersion, "string");
});

// ── Populated correctly ──

void test("providerDetails is present on fallback results", async () => {
  const router = new SearchRouter(
    [makeProvider("tavily")],
    ["tavily"],
  );
  const result = await router.search(request, new AbortController().signal);

  assert.ok(result.providerDetails, "providerDetails should be defined");
  assert.equal(result.providerDetails.length, 1);
  assert.deepEqual(result.providerDetails[0], {
    providerId: "tavily",
    backend: "api",
    ownership: "built-in",
    protocolVersion: "1",
  });
});

void test("providerDetails is present on federated/balanced results", async () => {
  const router = new SearchRouter(
    [makeProvider("tavily"), makeProvider("exa")],
    ["tavily", "exa"],
  );
  const result = await router.search(
    { query: "test", maxResults: 5, provider: "auto", strategy: "balanced" },
    new AbortController().signal,
  );

  assert.ok(result.providerDetails, "providerDetails should be defined");
  assert.ok(result.providerDetails.length >= 1, "should have at least one detail entry");
  for (const detail of result.providerDetails) {
    assert.equal(detail.backend, "api");
    assert.equal(detail.ownership, "built-in");
    assert.equal(detail.protocolVersion, "1");
    assert.ok(
      result.providersSucceeded?.includes(detail.providerId),
      `providerId ${detail.providerId} should match a succeeded provider`,
    );
  }
});

// ── No endpoint/secret leak ──

void test("providerDetails does not contain endpoint URLs or secret references", async () => {
  const router = new SearchRouter(
    [makeProvider("brave"), makeProvider("tavily")],
    ["brave", "tavily"],
  );
  const result = await router.search(
    { query: "test", maxResults: 5, provider: "auto", strategy: "balanced" },
    new AbortController().signal,
  );

  assert.ok(result.providerDetails);
  const serialized = JSON.stringify(result.providerDetails);
  assert.ok(!serialized.includes("http://"), "must not contain http:// URLs");
  assert.ok(!serialized.includes("https://"), "must not contain https:// URLs");
  assert.ok(!/secret/iu.test(serialized), "must not contain secret references");
  assert.ok(!/key/iu.test(serialized), "must not contain key references");
  assert.ok(!/token/iu.test(serialized), "must not contain token references");
  assert.ok(!/password/iu.test(serialized), "must not contain password references");

  for (const detail of result.providerDetails) {
    const keys = Object.keys(detail);
    assert.deepEqual(keys.sort(), [
      "backend",
      "ownership",
      "protocolVersion",
      "providerId",
    ]);
  }
});

// ── Built-in providers correctly identified ──

void test("built-in providers are marked with ownership=built-in", async () => {
  const router = new SearchRouter(
    [makeProvider("exa")],
    ["exa"],
  );
  const result = await router.search(
    { ...request, provider: "exa" },
    new AbortController().signal,
  );

  assert.ok(result.providerDetails);
  assert.equal(result.providerDetails.length, 1);
  assert.equal(result.providerDetails[0]?.ownership, "built-in");
  assert.equal(result.providerDetails[0]?.providerId, "exa");
});

// ── Backward compatibility ──

void test("providerDetails is optional and does not break existing results", () => {
  const result: SearchResult = {
    query: "test",
    provider: "tavily",
    results: [],
    durationMs: 1,
    warnings: [],
  };
  assert.equal(result.providerDetails, undefined);

  const withDetails: SearchResult = {
    ...result,
    providerDetails: [
      {
        providerId: "tavily",
        backend: "api",
        ownership: "built-in",
        protocolVersion: "1",
      },
    ],
  };
  assert.ok(withDetails.providerDetails);
  assert.equal(withDetails.providerDetails.length, 1);
});

void test("fallback with multiple providers only reports the succeeded provider", async () => {
  const failProvider: SearchProvider = {
    id: "broken",
    supports: () => true,
    search() {
      return Promise.reject(
        new Error("down"),
      );
    },
  };
  const router = new SearchRouter(
    [failProvider, makeProvider("exa")],
    ["broken", "exa"],
  );
  const result = await router.search(request, new AbortController().signal);

  assert.ok(result.providerDetails);
  assert.equal(result.providerDetails.length, 1);
  assert.equal(result.providerDetails[0]?.providerId, "exa");
});
