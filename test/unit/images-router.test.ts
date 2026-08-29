import assert from "node:assert/strict";
import test from "node:test";

import type {
  ImagesProvider,
  ImagesProviderId,
  ImagesProviderResult,
  ImagesRequest,
} from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { ImagesRouter } from "../../src/core/images-router.js";

function imagesResult(id: ImagesProviderId): ImagesProviderResult {
  return {
    provider: id,
    query: "groundlane",
    results: [
      {
        title: `${id} image`,
        imageUrl: `https://images.example.com/${id}.jpg`,
        sourceUrl: `https://example.com/${id}`,
        provider: id,
      },
      {
        title: "shared",
        imageUrl: "https://images.example.com/shared.jpg",
        sourceUrl: "https://example.com/shared",
        provider: id,
      },
    ],
    durationMs: 1,
    warnings: [],
  };
}

function provider(id: ImagesProviderId, behavior: "ok" | "retry" | "fatal", supports = true): ImagesProvider {
  return {
    id,
    supports: () => supports,
    images(): Promise<ImagesProviderResult> {
      if (behavior === "retry") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_images", "down", true));
      }
      if (behavior === "fatal") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_images", "bad request"));
      }
      return Promise.resolve(imagesResult(id));
    },
  };
}

const request: ImagesRequest = {
  query: "groundlane",
  maxResults: 10,
};

void test("ImagesRouter fans out to multiple providers in parallel and dedupes results", async () => {
  const calls: ImagesProviderId[] = [];
  const makeProvider = (id: ImagesProviderId): ImagesProvider => ({
    id,
    supports: () => true,
    images(): Promise<ImagesProviderResult> {
      calls.push(id);
      return Promise.resolve(imagesResult(id));
    },
  });

  const result = await new ImagesRouter(
    [makeProvider("brave"), makeProvider("serper"), makeProvider("serpapi")],
    ["brave", "serper", "serpapi"],
  ).images(request, new AbortController().signal);

  assert.deepEqual(calls.sort(), ["brave", "serpapi", "serper"]);
  assert.equal(result.strategy, "parallel");
  assert.deepEqual(result.providersSelected, ["brave", "serper", "serpapi"]);
  assert.deepEqual(result.providersAttempted, ["brave", "serper", "serpapi"]);
  assert.deepEqual(result.providersSucceeded, ["brave", "serper", "serpapi"]);
  assert.equal(result.results.filter((item) => item.imageUrl === "https://images.example.com/shared.jpg").length, 1);
});

void test("ImagesRouter returns partial success with sanitized warnings", async () => {
  const result = await new ImagesRouter(
    [provider("brave", "ok"), provider("serper", "retry")],
    ["brave", "serper"],
  ).images(request, new AbortController().signal);

  assert.deepEqual(result.providersSucceeded, ["brave"]);
  assert.deepEqual(result.warnings, ["serper unavailable"]);
});

void test("ImagesRouter fallback stops at first successful provider", async () => {
  const result = await new ImagesRouter(
    [provider("brave", "retry"), provider("serpapi", "ok")],
    ["brave", "serpapi"],
  ).images({ ...request, strategy: "fallback" }, new AbortController().signal);

  assert.equal(result.strategy, "fallback");
  assert.deepEqual(result.providersAttempted, ["brave", "serpapi"]);
  assert.deepEqual(result.providersSucceeded, ["serpapi"]);
});

void test("ImagesRouter rejects invalid input and conflicting provider selectors", async () => {
  await assert.rejects(
    new ImagesRouter([provider("brave", "ok")], ["brave"]).images(
      { ...request, country: "usa" },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
  await assert.rejects(
    new ImagesRouter([provider("brave", "ok")], ["brave"]).images(
      { ...request, provider: "brave", providers: ["brave"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("ImagesRouter explicit provider propagates non-retryable errors", async () => {
  await assert.rejects(
    new ImagesRouter([provider("brave", "fatal")], ["brave"]).images(
      { ...request, provider: "brave" },
      new AbortController().signal,
    ),
    /bad request/u,
  );
});
