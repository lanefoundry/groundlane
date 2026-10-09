import assert from "node:assert/strict";
import test from "node:test";
import type { ContentResult } from "../../src/core/contracts.js";
import { paginateContentResult } from "../../src/core/content-pagination.js";

function source(content: string, truncated = false): ContentResult {
  return { url: "https://example.com/video", strategy: "fallback", providersSelected: ["tavily"], providersAttempted: ["tavily"], providersSucceeded: ["tavily"], contents: [{ provider: "tavily", url: "https://example.com/video", finalUrl: "https://example.com/video", content, format: "markdown", truncated, durationMs: 1, warnings: [] }], durationMs: 1, warnings: [] };
}

void test("content pagination reconstructs long Unicode transcript without missing or duplicate characters", () => {
  const original = "[00:01] 字幕😀 & text\n".repeat(8_000);
  const result = source(original);
  let offset = 0;
  let hash: string | undefined;
  let assembled = "";
  let pages = 0;
  while (true) {
    const page = paginateContentResult(result, { offset, maxContentChars: 20_000, maxOutputChars: 10_000, ...(hash === undefined ? {} : { expectedContentHash: hash }) });
    assert.ok(Array.from(JSON.stringify(page)).length <= 10_000);
    const item = page.contents[0]!;
    assert.equal(item.contentOffset, offset);
    assert.equal(item.totalContentChars, Array.from(original).length);
    assert.equal(item.sourceTruncated, false);
    assert.ok(item.content.length > 0);
    hash = item.contentHash;
    assembled += item.content;
    pages++;
    if (item.nextContentOffset === null) break;
    assert.ok(item.nextContentOffset > offset);
    offset = item.nextContentOffset;
  }
  assert.ok(pages > 1);
  assert.equal(assembled, original);
});

void test("content pagination fails closed when source changes or final URL changes", () => {
  const first = paginateContentResult(source("original transcript"), { offset: 0, maxContentChars: 5, maxOutputChars: 2_000 });
  const options = { offset: 5, maxContentChars: 5, maxOutputChars: 2_000, expectedContentHash: first.contents[0]!.contentHash };
  assert.throws(() => paginateContentResult(source("modified transcript"), options), /changed/);
  const moved = source("original transcript");
  moved.contents[0]!.finalUrl = "https://example.com/other";
  assert.throws(() => paginateContentResult(moved, options), /changed/);
});

void test("source truncation remains visible even on the last page", () => {
  const page = paginateContentResult(source("partial", true), { offset: 0, maxContentChars: 20, maxOutputChars: 2_000 });
  assert.equal(page.contents[0]!.nextContentOffset, null);
  assert.equal(page.contents[0]!.sourceTruncated, true);
  assert.equal(page.contents[0]!.truncated, true);
});

void test("pagination bounds JSON escaping rather than only raw text length", () => {
  const result = source('"\\\n'.repeat(10_000));
  const page = paginateContentResult(result, { offset: 0, maxContentChars: 10_000, maxOutputChars: 2_000 });
  assert.ok(Array.from(JSON.stringify(page)).length <= 2_000);
  assert.ok(page.contents[0]!.nextContentOffset !== null);
  assert.ok(page.contents[0]!.content.length < 1_000);
});

void test("pagination validates offsets, hash, limits, provider count, and metadata budget", () => {
  const result = source("hello");
  const options = { offset: 0, maxContentChars: 5, maxOutputChars: 2_000 };
  for (const offset of [-1, 0.5, 6]) assert.throws(() => paginateContentResult(result, { ...options, offset }));
  assert.throws(() => paginateContentResult(result, { ...options, offset: 1 }), /hash/i);
  assert.throws(() => paginateContentResult(result, { ...options, expectedContentHash: "bad" }));
  assert.throws(() => paginateContentResult(result, { ...options, maxContentChars: 0 }));
  assert.throws(() => paginateContentResult(result, { ...options, maxOutputChars: 20 }));
  assert.throws(() => paginateContentResult({ ...result, contents: [] }, options));
  assert.throws(() => paginateContentResult({ ...result, contents: [...result.contents, ...result.contents] }, options));
});

void test("empty content and offset at end terminate with no next page", () => {
  const empty = paginateContentResult(source(""), { offset: 0, maxContentChars: 5, maxOutputChars: 2_000 });
  assert.equal(empty.contents[0]!.nextContentOffset, null);
  const first = paginateContentResult(source("hello"), { offset: 0, maxContentChars: 5, maxOutputChars: 2_000 });
  const end = paginateContentResult(source("hello"), { offset: 5, maxContentChars: 5, maxOutputChars: 2_000, expectedContentHash: first.contents[0]!.contentHash });
  assert.equal(end.contents[0]!.content, "");
  assert.equal(end.contents[0]!.nextContentOffset, null);
});
