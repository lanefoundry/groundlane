import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { HttpFetchRequest, HttpFetcher } from "../../src/core/contracts.js";
import { ReductoAsyncDocumentProvider } from "../../src/adapters/document/reducto-async.js";

const source = new TextEncoder().encode("%PDF-1.7 synthetic");
const signal = new AbortController().signal;
const full = { type: "full", chunks: [{ content: "hello", embed: "hello", enriched: null, blocks: [
  { type: "Text", content: "hello", bbox: { left: 0, top: 0, width: 1, height: 1, page: 1 } },
] }] };
function completed(result: unknown = full) { return { status: "Completed", result: { job_id: "job-1", duration: 2, usage: { num_pages: 1, credits: 3 }, result } }; }
function fixture(responses: unknown[], options: { maxInputBytes?: number; maxResponseBytes?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new ReductoAsyncDocumentProvider({ apiKey: "test-secret", ...options,
    fetch: (url, init) => { calls.push({ url, init }); const item = responses.shift(); return Promise.resolve(item instanceof Response ? item : Response.json(item)); },
  });
  return { provider, calls };
}
void test("Reducto uploads bytes and submits provider-owned parse with restart-safe source identity", async () => {
  const { provider, calls } = fixture([{ file_id: "reducto://file-1" }, { job_id: "job-1" }]);
  const receipt = await provider.create(source, "stable-key", signal);
  assert.equal(calls[0]?.url, "https://platform.reducto.ai/upload");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer test-secret");
  assert.equal(calls[0]?.init.redirect, "error");
  const form = calls[0]?.init.body;
  assert.ok(form instanceof FormData);
  const file = form.get("file"); assert.ok(file instanceof Blob);
  assert.equal(file.type, "application/pdf");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), source);
  assert.equal(calls[1]?.url, "https://platform.reducto.ai/parse_async");
  const body = calls[1]?.init.body; assert.equal(typeof body, "string");
  const submitted: unknown = JSON.parse(body as string);
  assert.ok(submitted && typeof submitted === "object");
  assert.equal(Reflect.get(submitted, "input"), "reducto://file-1");
  const restarted = fixture([completed()]).provider;
  const result = await restarted.poll(receipt, signal);
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.envelope.sourceIdentity.contentHash, `sha256-${createHash("sha256").update(source).digest("hex")}`);
    assert.equal(result.envelope.blocks[0]?.type, "text");
    assert.ok(JSON.stringify(result.envelope.metadata).includes("credits"));
    assert.ok(!JSON.stringify(result.envelope).includes("test-secret"));
  }
});
void test("Reducto refuses oversized input before upload", async () => {
  const { provider, calls } = fixture([], { maxInputBytes: 2 });
  await assert.rejects(provider.create(source, "key", signal), { code: "INVALID_INPUT" });
  assert.equal(calls.length, 0);
});
void test("Reducto cancellation never equates artifact deletion with upstream cancellation", async () => {
  const { provider, calls } = fixture([]);
  assert.deepEqual(await provider.cancel("unused", signal), { acknowledged: false });
  assert.equal(calls.length, 0);
});

const receipt = JSON.stringify(["job-1", `sha256-${createHash("sha256").update(source).digest("hex")}`]);
for (const [status, expected] of [["Pending", "pending"], ["Idle", "pending"], ["InProgress", "running"], ["Completing", "running"], ["Failed", "failed"]]) {
  void test(`Reducto maps ${status} without exposing provider errors`, async () => {
    const { provider } = fixture([{ status, reason: "test-secret", error: { message: "test-secret" } }]);
    assert.deepEqual(await provider.poll(receipt, signal), { status: expected });
  });
}
for (const malformed of [{ status: "Invented" }, { status: "Completed" }, completed({ type: "full", chunks: [{}] }),
  { ...completed(), result: { ...completed().result, job_id: "different" } }]) {
  void test("Reducto rejects malformed or mismatched status responses", async () => {
    await assert.rejects(fixture([malformed]).provider.poll(receipt, signal), { code: "UPSTREAM_ERROR" });
  });
}
for (const [status, code] of [[429, "RATE_LIMITED"], [401, "UPSTREAM_ERROR"], [500, "UPSTREAM_ERROR"], [302, "UPSTREAM_ERROR"]] as const) {
  void test(`Reducto sanitizes HTTP ${status} without reading error payload`, async () => {
    const { provider } = fixture([new Response("test-secret", { status, headers: { location: "http://127.0.0.1/" } })]);
    await assert.rejects(provider.poll(receipt, signal), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(Reflect.get(error, "code"), code);
      assert.ok(!JSON.stringify(error).includes("test-secret")); return true;
    });
  });
}
void test("Reducto rejects invalid upload IDs before submission", async () => {
  const { provider, calls } = fixture([{ file_id: "http://127.0.0.1/private" }]);
  await assert.rejects(provider.create(source, "key", signal), { code: "UPSTREAM_ERROR" });
  assert.equal(calls.length, 1);
});
void test("Reducto rejects path injection in durable receipts", async () => {
  const { provider, calls } = fixture([]);
  await assert.rejects(provider.poll(JSON.stringify(["../secret", "sha256-" + "0".repeat(64)]), signal), { code: "INVALID_INPUT" });
  assert.equal(calls.length, 0);
});
void test("Reducto bounds declared and streaming response bytes", async () => {
  for (const headers of [{ "content-length": "999999" }, {}]) {
    const { provider } = fixture([new Response("x".repeat(50), { headers })], { maxResponseBytes: 20 });
    await assert.rejects(provider.poll(receipt, signal), { code: "OUTPUT_LIMIT" });
  }
});
void test("Reducto does not advertise flattened tables or discarded assets as preserved", async () => {
  const result = structuredClone(full);
  result.chunks[0]!.blocks[0]!.type = "Table";
  const status = await fixture([completed(result)]).provider.poll(receipt, signal);
  assert.equal(status.status, "completed");
  if (status.status === "completed") {
    assert.equal(status.envelope.status, "partial");
    assert.equal(status.envelope.capabilityStates.tables, "unsupported");
    assert.equal(status.envelope.capabilityStates.assets, "unsupported");
    assert.equal(status.envelope.provenance.cost, null);
    assert.equal(status.envelope.provenance.confidence, null);
  }
});
void test("Reducto result download passes shared deadline, no credential, and byte/redirect bounds", async () => {
  const requests: HttpFetchRequest[] = [];
  const resultFetcher: HttpFetcher = { fetch: (request, parent) => {
    requests.push(request); assert.ok(parent); assert.ok(!parent.aborted);
    assert.equal(request.headers, undefined);
    return Promise.resolve({ requestedUrl: request.url, finalUrl: request.url, status: 200, headers: {}, contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(full.chunks)), engine: "http", backend: "fake" });
  } };
  const provider = new ReductoAsyncDocumentProvider({ apiKey: "test-secret", resultFetcher,
    fetch: () => Promise.resolve(Response.json(completed({ type: "url", url: "https://storage.example/result?signature=sensitive", result_id: "r" }))),
  });
  const result = await provider.poll(receipt, signal);
  assert.equal(result.status, "completed");
  assert.equal(requests[0]?.maxRedirects, 3);
  assert.equal(requests[0]?.maxBytes, 2_000_000);
  assert.ok(requests[0].deadline.remainingMs() <= 30_000);
  assert.ok(!JSON.stringify(result).includes("sensitive"));
});
for (const url of ["http://127.0.0.1/private", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "https://user:password@example.com/"]) {
  void test(`Reducto default result fetcher rejects unsafe returned URL ${url}`, async () => {
    const provider = fixture([completed({ type: "url", url, result_id: "r" })]).provider;
    await assert.rejects(provider.poll(receipt, signal));
  });
}
void test("Reducto parent cancellation prevents any request", async () => {
  const abort = new AbortController(); abort.abort();
  const { provider, calls } = fixture([]);
  await assert.rejects(provider.create(source, "key", abort.signal), { code: "CANCELLED" });
  await assert.rejects(provider.poll(receipt, abort.signal), { code: "CANCELLED" });
  assert.equal(calls.length, 0);
});
void test("Reducto shared attempt deadline aborts a stalled provider response", async () => {
  let observed: AbortSignal | null | undefined;
  const provider = new ReductoAsyncDocumentProvider({ apiKey: "test-secret", timeoutMs: 10,
    fetch: async (_url, init) => { observed = init.signal; return new Promise<Response>(() => undefined); },
  });
  await assert.rejects(provider.create(source, "key", signal), { code: "DEADLINE_EXCEEDED" });
  assert.equal(observed?.aborted, true);
});
void test("Reducto rejects degenerate bounds as sanitized provider errors", async () => {
  const result = structuredClone(full); result.chunks[0]!.blocks[0]!.bbox.width = 0;
  await assert.rejects(fixture([completed(result)]).provider.poll(receipt, signal), { code: "UPSTREAM_ERROR" });
});
void test("Reducto validates credentials and every bound before I/O", () => {
  for (const apiKey of ["", "  ", "secret\nheader"]) {
    assert.throws(() => new ReductoAsyncDocumentProvider({ apiKey }), { code: "INVALID_INPUT" });
  }
  for (const bound of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const name of ["maxInputBytes", "maxResponseBytes", "timeoutMs"] as const) {
      assert.throws(() => new ReductoAsyncDocumentProvider({ apiKey: "test-secret", [name]: bound }), { code: "INVALID_INPUT" });
    }
  }
});
void test("Reducto rejects an unknown source format before contacting provider", async () => {
  const { provider, calls } = fixture([]);
  await assert.rejects(provider.create(new TextEncoder().encode("unsupported source"), "key", signal), { code: "INVALID_INPUT" });
  assert.equal(calls.length, 0);
});
void test("Reducto deadline cancels a stalled body reader", async () => {
  let cancelled = false;
  const provider = new ReductoAsyncDocumentProvider({ apiKey: "test-secret", timeoutMs: 10,
    fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }))),
  });
  await assert.rejects(provider.poll(receipt, signal), { code: "DEADLINE_EXCEEDED" });
  assert.equal(cancelled, true);
});
