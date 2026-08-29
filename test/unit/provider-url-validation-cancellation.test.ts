import assert from "node:assert/strict";
import test from "node:test";
import { validateAnswerCitations, validateAnswerItems } from "../../src/adapters/answer/common.js";
import { normalizedContentResult } from "../../src/adapters/content/common.js";
import { normalizeCrawlPages } from "../../src/adapters/crawl/common.js";
import { normalizeImageItems } from "../../src/adapters/images/common.js";
import { normalizeMapLinks } from "../../src/adapters/map/common.js";
import { normalizeNewsItems } from "../../src/adapters/news/common.js";
import { validateResearchCitations } from "../../src/adapters/research/common.js";
import { validateItems } from "../../src/adapters/search/common.js";
import { GroundlaneError } from "../../src/core/errors.js";

function deadlineAbort(): { controller: AbortController; reason: GroundlaneError } {
  return {
    controller: new AbortController(),
    reason: new GroundlaneError(
      "DEADLINE_EXCEEDED",
      "provider-url",
      "Provider URL validation deadline exceeded",
      true,
    ),
  };
}

void test("provider URL normalization loops propagate aborted validation instead of dropping candidates", async () => {
  const cases: readonly [string, (validator: (url: string, signal?: AbortSignal) => Promise<void>, signal: AbortSignal) => Promise<unknown>][] = [
    [
      "search",
      (validator, signal) => validateItems(
        [
          { title: "one", url: "https://example.com/1", snippet: "", provider: "brave" },
          { title: "two", url: "https://example.com/2", snippet: "", provider: "brave" },
        ],
        validator,
        signal,
      ),
    ],
    [
      "map",
      (validator, signal) => normalizeMapLinks(
        "tavily",
        [
          { url: "https://example.com/1", provider: "tavily" },
          { url: "https://example.com/2", provider: "tavily" },
        ],
        validator,
        signal,
      ),
    ],
    [
      "crawl",
      (validator, signal) => normalizeCrawlPages(
        "tavily",
        [
          { url: "https://example.com/1", contentChars: 0, truncated: false, provider: "tavily" },
          { url: "https://example.com/2", contentChars: 0, truncated: false, provider: "tavily" },
        ],
        10,
        validator,
        signal,
      ),
    ],
    [
      "images",
      (validator, signal) => normalizeImageItems(
        "brave",
        [
          { title: "one", imageUrl: "https://example.com/1.jpg", sourceUrl: "https://example.com/1", provider: "brave" },
          { title: "two", imageUrl: "https://example.com/2.jpg", sourceUrl: "https://example.com/2", provider: "brave" },
        ],
        validator,
        signal,
      ),
    ],
    [
      "news",
      (validator, signal) => normalizeNewsItems(
        "brave",
        [
          { title: "one", url: "https://example.com/1", snippet: "", provider: "brave" },
          { title: "two", url: "https://example.com/2", snippet: "", provider: "brave" },
        ],
        validator,
        signal,
      ),
    ],
    [
      "answer-citations",
      (validator, signal) => validateAnswerCitations(
        [
          { url: "https://example.com/1", excerpts: [] },
          { url: "https://example.com/2", excerpts: [] },
        ],
        validator,
        signal,
      ),
    ],
    [
      "answer-items",
      (validator, signal) => validateAnswerItems(
        [
          { title: "one", url: "https://example.com/1", snippet: "", provider: "linkup" },
          { title: "two", url: "https://example.com/2", snippet: "", provider: "linkup" },
        ],
        validator,
        signal,
      ),
    ],
    [
      "research",
      (validator, signal) => validateResearchCitations(
        [
          { url: "https://example.com/1", excerpts: [] },
          { url: "https://example.com/2", excerpts: [] },
        ],
        validator,
        signal,
      ),
    ],
  ];

  for (const [name, run] of cases) {
    const { controller, reason } = deadlineAbort();
    let calls = 0;
    await assert.rejects(
      run((_url, signal) => {
        assert.equal(signal, controller.signal, name);
        calls += 1;
        controller.abort(reason);
        return Promise.reject(new Error("unsafe provider URL"));
      }, controller.signal),
      { code: "DEADLINE_EXCEEDED" },
      name,
    );
    assert.equal(calls, 1, name);
  }
});

void test("provider URL normalization still drops ordinary invalid URLs", async () => {
  const result = await validateItems(
    [
      { title: "blocked", url: "http://127.0.0.1/", snippet: "", provider: "brave" },
      { title: "ok", url: "https://example.com/", snippet: "", provider: "brave" },
    ],
    (url) => url.includes("127.0.0.1") ? Promise.reject(new Error("blocked")) : Promise.resolve(),
    new AbortController().signal,
  );

  assert.deepEqual(result.map((item) => item.title), ["ok"]);
});

void test("content final URL validation receives the request signal", async () => {
  const { controller, reason } = deadlineAbort();
  let calls = 0;
  await assert.rejects(
    normalizedContentResult(
      "you",
      "https://example.com/request",
      "https://example.com/final",
      undefined,
      "content",
      "markdown",
      100,
      performance.now(),
      (_url, signal) => {
        assert.equal(signal, controller.signal);
        calls += 1;
        controller.abort(reason);
        return Promise.reject(reason);
      },
      [],
      controller.signal,
    ),
    { code: "DEADLINE_EXCEEDED" },
  );
  assert.equal(calls, 1);
});
