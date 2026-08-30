import assert from "node:assert/strict";
import test from "node:test";

import { ErrorRecorder, formatEntry, sanitizeInput, withErrorLog, type ToolResult } from "../../examples/groundlane-debug.js";

void test("sanitizeInput strips query string and credentials from a URL field", () => {
  const out = sanitizeInput({ url: "https://user:pass@example.com/path?token=abc&q=foo" });
  assert.equal(out.url, "https://example.com/path");
});

void test("sanitizeInput redacts obvious secret-shaped keys", () => {
  const out = sanitizeInput({ apiKey: "sk-12345", name: "foo", token: "abc", password: "p" });
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.name, "foo");
});

void test("sanitizeInput redacts inline http URLs in string values", () => {
  const out = sanitizeInput({ source: "see https://user:pass@x.com/p?secret=1" });
  assert.equal(out.source, "see https://x.com/p");
});

void test("ErrorRecorder records + queries newest first", () => {
  const r = new ErrorRecorder();
  r.record({ timestamp: "2026-01-01T00:00:00.000Z", tool: "web_search", input: {}, error: { code: "OUTPUT_LIMIT", stage: "search", message: "a", retryable: false }, latencyMs: 1 });
  r.record({ timestamp: "2026-01-02T00:00:00.000Z", tool: "web_fetch", input: {}, error: { code: "URL_BLOCKED", stage: "url", message: "b", retryable: false }, latencyMs: 2 });
  r.record({ timestamp: "2026-01-03T00:00:00.000Z", tool: "web_extract", input: {}, error: { code: "INVALID_INPUT", stage: "extract", message: "c", retryable: false }, latencyMs: 3 });
  const all = r.query({});
  assert.equal(all.length, 3);
  assert.equal(all[0]!.tool, "web_extract");
  assert.equal(all[2]!.tool, "web_search");
});

void test("ErrorRecorder filters by tool / code / hintCode / since", () => {
  const r = new ErrorRecorder();
  r.record({ timestamp: "2026-01-01T00:00:00.000Z", tool: "web_search", input: {}, error: { code: "OUTPUT_LIMIT", stage: "search", message: "a", hintCode: "search.output_too_large", retryable: false }, latencyMs: 1 });
  r.record({ timestamp: "2026-01-02T00:00:00.000Z", tool: "web_extract", input: {}, error: { code: "INVALID_INPUT", stage: "extract", message: "b", hintCode: "extract.pattern.invalid_flags", retryable: false }, latencyMs: 2 });
  r.record({ timestamp: "2026-01-03T00:00:00.000Z", tool: "web_search", input: {}, error: { code: "URL_BLOCKED", stage: "url", message: "c", hintCode: "url.blocked.invalid_protocol", retryable: false }, latencyMs: 3 });

  assert.equal(r.query({ tool: "web_search" }).length, 2);
  assert.equal(r.query({ code: "OUTPUT_LIMIT" }).length, 1);
  assert.equal(r.query({ hintCode: "url.blocked.invalid_protocol" }).length, 1);
  assert.equal(r.query({ since: new Date("2026-01-02T12:00:00.000Z") }).length, 1);
});

void test("ErrorRecorder caps buffer at maxEntries and drops oldest", () => {
  const r = new ErrorRecorder(3);
  for (let i = 0; i < 5; i++) {
    r.record({ timestamp: new Date(2026, 0, i + 1).toISOString(), tool: `t${i}`, input: {}, error: { code: "X", stage: "x", message: "m", retryable: false }, latencyMs: 1 });
  }
  assert.equal(r.size, 3);
  const all = r.query({});
  assert.equal(all[0]!.tool, "t4");
  assert.equal(all[2]!.tool, "t2");
});

void test("withErrorLog records failed envelope and returns result", async () => {
  const r = new ErrorRecorder();
  const fail: ToolResult = { ok: false, error: { code: "OUTPUT_LIMIT", stage: "search", message: "too big", retryable: false, hint: { code: "search.output_too_large", text: "..." } } };
  const result = await withErrorLog(r, "web_search", { query: "x" }, () => Promise.resolve(fail));
  assert.equal(result.ok, false);
  assert.equal(r.size, 1);
  const entry = r.query({})[0]!;
  assert.equal(entry.tool, "web_search");
  assert.equal(entry.error.code, "OUTPUT_LIMIT");
  assert.equal(entry.error.hintCode, "search.output_too_large");
  assert.match(String(entry.input.query), /x/);
});

void test("withErrorLog does NOT record successful results", async () => {
  const r = new ErrorRecorder();
  const ok: ToolResult<{ hits: number }> = { ok: true, data: { hits: 7 } };
  const result = await withErrorLog(r, "web_search", { query: "x" }, () => Promise.resolve(ok));
  assert.equal(result.ok, true);
  assert.equal(r.size, 0);
});

void test("withErrorLog records thrown errors as UPSTREAM_ERROR and re-throws", async () => {
  const r = new ErrorRecorder();
  await assert.rejects(
    () => withErrorLog(r, "web_search", { query: "x" }, () => Promise.reject(new Error("rpc timeout"))),
    /rpc timeout/,
  );
  const entry = r.query({})[0]!;
  assert.equal(entry.error.code, "UPSTREAM_ERROR");
  assert.equal(entry.error.message, "rpc timeout");
  assert.equal(entry.error.retryable, true);
});

void test("formatEntry produces a one-line summary", () => {
  const r = new ErrorRecorder();
  r.record({ timestamp: "2026-01-01T00:00:00.000Z", tool: "web_search", input: {}, error: { code: "OUTPUT_LIMIT", stage: "search", message: "too big", hintCode: "search.output_too_large", retryable: false }, latencyMs: 100 });
  const line = formatEntry(r.query({})[0]!);
  assert.match(line, /web_search/);
  assert.match(line, /OUTPUT_LIMIT/);
  assert.match(line, /search\.output_too_large/);
  assert.match(line, /100ms/);
});