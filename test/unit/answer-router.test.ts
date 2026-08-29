import assert from "node:assert/strict";
import test from "node:test";

import type {
  AnswerProvider,
  AnswerProviderId,
  AnswerProviderResult,
  AnswerRequest,
} from "../../src/core/contracts.js";
import { GroundlaneError } from "../../src/core/errors.js";
import { AnswerRouter } from "../../src/core/answer-router.js";

function answerResult(id: AnswerProviderId): AnswerProviderResult {
  return {
    provider: id,
    answer: `${id} answer`,
    citations: [],
    results: [],
    durationMs: 1,
    warnings: [],
  };
}

function provider(id: AnswerProviderId, behavior: "ok" | "retry" | "fatal", supports = true): AnswerProvider {
  return {
    id,
    supports: () => supports,
    answer(): Promise<AnswerProviderResult> {
      if (behavior === "retry") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_answer", "down", true));
      }
      if (behavior === "fatal") {
        return Promise.reject(new GroundlaneError("UPSTREAM_ERROR", "web_answer", "bad request"));
      }
      return Promise.resolve(answerResult(id));
    },
  };
}

const request: AnswerRequest = {
  query: "groundlane",
  maxResults: 2,
};

void test("AnswerRouter fans out to multiple providers in parallel and keeps attribution", async () => {
  const calls: AnswerProviderId[] = [];
  const makeProvider = (id: AnswerProviderId): AnswerProvider => ({
    id,
    supports: () => true,
    answer(): Promise<AnswerProviderResult> {
      calls.push(id);
      return Promise.resolve(answerResult(id));
    },
  });

  const result = await new AnswerRouter(
    [makeProvider("linkup"), makeProvider("you")],
    ["linkup", "you"],
  ).answer(request, new AbortController().signal);

  assert.deepEqual(calls.sort(), ["linkup", "you"]);
  assert.equal(result.strategy, "parallel");
  assert.deepEqual(result.providersSelected, ["linkup", "you"]);
  assert.deepEqual(result.providersAttempted, ["linkup", "you"]);
  assert.deepEqual(result.providersSucceeded, ["linkup", "you"]);
  assert.deepEqual(result.answers.map((answer) => answer.provider), ["linkup", "you"]);
});

void test("AnswerRouter returns partial success with sanitized provider warnings", async () => {
  const result = await new AnswerRouter(
    [provider("linkup", "ok"), provider("you", "retry")],
    ["linkup", "you"],
  ).answer(request, new AbortController().signal);

  assert.deepEqual(result.providersSucceeded, ["linkup"]);
  assert.deepEqual(result.warnings, ["you unavailable"]);
});

void test("AnswerRouter fallback stops at first successful provider", async () => {
  const result = await new AnswerRouter(
    [provider("linkup", "retry"), provider("you", "ok")],
    ["linkup", "you"],
  ).answer({ ...request, strategy: "fallback" }, new AbortController().signal);

  assert.equal(result.strategy, "fallback");
  assert.deepEqual(result.providersAttempted, ["linkup", "you"]);
  assert.deepEqual(result.providersSucceeded, ["you"]);
  assert.deepEqual(result.warnings, ["linkup unavailable"]);
});

void test("AnswerRouter rejects unsupported and conflicting requests", async () => {
  const router = new AnswerRouter([provider("linkup", "ok", false)], ["linkup"]);
  await assert.rejects(router.answer(request, new AbortController().signal), {
    code: "PROVIDER_UNAVAILABLE",
  });
  await assert.rejects(
    new AnswerRouter([provider("linkup", "ok")], ["linkup"]).answer(
      { ...request, provider: "linkup", providers: ["linkup"] },
      new AbortController().signal,
    ),
    { code: "INVALID_INPUT" },
  );
});

void test("AnswerRouter explicit provider propagates non-retryable errors", async () => {
  await assert.rejects(
    new AnswerRouter([provider("you", "fatal")], ["you"]).answer(
      { ...request, provider: "you" },
      new AbortController().signal,
    ),
    /bad request/u,
  );
});
