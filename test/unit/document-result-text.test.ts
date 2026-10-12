import assert from "node:assert/strict";
import test from "node:test";

import { paginateDocumentProjection } from "../../src/core/document-result-text.js";

const projection = { kind: "markdown" as const, content: "漢😀\\\"\n".repeat(400), lossy: true,
  omissions: ["layout flattened"], warnings: ["formula recognition is not certified"] };
const hash = `sha256-${"a".repeat(64)}`;

void test("text result pagination preserves Unicode, fits JSON budgets, and supplies exact continuations", () => {
  let offset: number | null = 0;
  const pages: string[] = [];
  while (offset !== null) {
    const page = paginateDocumentProjection("art_test", hash, projection, offset, 8000, 1000);
    assert.ok(JSON.stringify({ ok: true, data: page }).length <= 1000);
    assert.equal(page.contentOffset, offset);
    assert.equal(page.totalContentChars, Array.from(projection.content).length);
    assert.equal(page.lossy, true);
    assert.deepEqual(page.omissions, projection.omissions);
    assert.deepEqual(page.warnings, projection.warnings);
    assert.equal(page.contentHash, hash);
    assert.ok(!page.content.includes("\ufffd"));
    if (page.nextContentOffset !== null) {
      assert.ok(page.nextContentOffset > offset);
      assert.deepEqual(page.nextAction, { tool: "document_result_read_text", arguments: {
        refId: "art_test", contentOffset: page.nextContentOffset, maxContentChars: 8000,
      } });
    } else assert.equal(page.nextAction, undefined);
    pages.push(page.content);
    offset = page.nextContentOffset;
  }
  assert.equal(pages.join(""), projection.content);
});

void test("text pagination bounds metadata, handles EOF and rejects invalid ranges or impossible budgets", () => {
  const huge = { ...projection, omissions: ["x".repeat(10000)], warnings: Array<string>(50).fill("y".repeat(10000)) };
  const page = paginateDocumentProjection("art_test", hash, huge, 0, 10, 1000);
  assert.equal(page.metadataTruncated, true);
  assert.ok(JSON.stringify({ ok: true, data: page }).length <= 1000);
  const eof = paginateDocumentProjection("art_test", hash, { ...projection, content: "" }, 0, 10, 1000);
  assert.equal(eof.content, "");
  assert.equal(eof.nextContentOffset, null);
  for (const [offset, size, budget] of [[-1, 1, 1000], [0.5, 1, 1000], [99999, 1, 1000], [0, 0, 1000], [0, 50001, 1000], [0, 1, 1]]) {
    assert.throws(() => paginateDocumentProjection("art_test", hash, projection, offset ?? -1, size ?? -1, budget ?? -1));
  }
});

void test("a complete final page can fit even when continuation metadata would exceed the budget", () => {
  const small = { kind: "text" as const, content: "ab", lossy: false, omissions: [], warnings: [] };
  const complete = paginateDocumentProjection("art_one", hash, small, 0, 10, 1000);
  const exactBudget = JSON.stringify({ ok: true, data: complete }).length;
  assert.deepEqual(paginateDocumentProjection("art_one", hash, small, 0, 10, exactBudget), complete);
});
