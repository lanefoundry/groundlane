import assert from "node:assert/strict";
import test from "node:test";

import type {
  ContentProvider,
  ContentProviderId,
  ContentProviderResult,
  ContentRequest,
} from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { ContentRouter } from "../../src/core/content-router.js";

function contentResult(id: ContentProviderId): ContentProviderResult {
  return {
    provider: id,
    url: "https://example.com",
    finalUrl: "https://example.com",
    content: `${id} content`,
    format: "markdown",
    truncated: false,
    durationMs: 1,
    warnings: [],
  };
}

function provider(id: ContentProviderId, behavior: "ok" | "retry" | "fatal", supports = true): ContentProvider {
  return {
    id,
    supports: () => supports,
    fetchContent(): Promise<ContentProviderResult> {
      if (behavior === "retry") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_content", "down", true));
      }
      if (behavior === "fatal") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_content", "bad request"));
      }
      return Promise.resolve(contentResult(id));
    },
  };
}

const request: ContentRequest = {
  url: "https://example.com",
  maxContentChars: 100,
};

void test("ContentRouter fans out to multiple providers in parallel and keeps attribution", async () => {
  const calls: ContentProviderId[] = [];
  const makeProvider = (id: ContentProviderId): ContentProvider => ({
    id,
    supports: () => true,
    fetchContent(): Promise<ContentProviderResult> {
      calls.push(id);
      return Promise.resolve(contentResult(id));
    },
  });

  const result = await new ContentRouter(
    [makeProvider("linkup"), makeProvider("you"), makeProvider("exa")],
    ["linkup", "you", "exa"],
  ).fetchContent(request, new AbortController().signal);

  assert.deepEqual(calls.sort(), ["exa", "linkup", "you"]);
  assert.equal(result.strategy, "parallel");
  assert.deepEqual(result.providersSelected, ["linkup", "you", "exa"]);
  assert.deepEqual(result.providersAttempted, ["linkup", "you", "exa"]);
  assert.deepEqual(result.providersSucceeded, ["linkup", "you", "exa"]);
});

void test("ContentRouter returns partial success with sanitized warnings", async () => {
  const result = await new ContentRouter(
    [provider("linkup", "ok"), provider("you", "retry")],
    ["linkup", "you"],
  ).fetchContent(request, new AbortController().signal);

  assert.deepEqual(result.providersSucceeded, ["linkup"]);
  assert.deepEqual(result.warnings, ["you unavailable"]);
});

void test("ContentRouter fallback stops at first successful provider", async () => {
  const result = await new ContentRouter(
    [provider("linkup", "retry"), provider("you", "ok")],
    ["linkup", "you"],
  ).fetchContent({ ...request, strategy: "fallback" }, new AbortController().signal);

  assert.equal(result.strategy, "fallback");
  assert.deepEqual(result.providersAttempted, ["linkup", "you"]);
  assert.deepEqual(result.providersSucceeded, ["you"]);
});

void test("ContentRouter rejects unsafe URLs and conflicting selectors", async () => {
  await assert.rejects(
    new ContentRouter([provider("linkup", "ok")], ["linkup"]).fetchContent(
      { ...request, url: "http://127.0.0.1/" },
      new AbortController().signal,
    ),
    { code: "URL_BLOCKED" },
  );
  await assert.rejects(
    new ContentRouter([provider("linkup", "ok")], ["linkup"]).fetchContent(
      { ...request, provider: "linkup", providers: ["linkup"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("ContentRouter explicit provider propagates non-retryable errors", async () => {
  await assert.rejects(
    new ContentRouter([provider("exa", "fatal")], ["exa"]).fetchContent(
      { ...request, provider: "exa" },
      new AbortController().signal,
    ),
    /bad request/u,
  );
});
