import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createGroundlaneServices } from "../../src/composition.js";
import { parseConfig } from "../../src/config.js";
import { createContainerApp } from "../../src/container/app.js";
import { DurableUploadArtifactService } from "../../src/core/durable-upload-flow.js";
import { createEdgeDocumentAsyncRuntime } from "../../src/worker/document-async-runtime.js";
import { configuredDocumentJobRuntime, maybeHandleEdgeDocumentJobs, runDocumentJobTick } from "../../src/worker/document-job-runtime.js";
import { scheduledDocumentWork } from "../../src/worker/document-schedule.js";
import { D1DurableRecordStore } from "../../src/worker/d1-durable-store.js";
import { R2ImmutableBlobStore } from "../../src/worker/r2-immutable-blob.js";
import { SqliteD1 } from "../support/sqlite-d1-admission.js";
import { FakeR2 } from "../support/document-output-bindings.js";

void test("actual MCP composition advertises exact document fallback inventory and fails closed without backend", async (t) => {
  const token = "document-job-public-inventory-auth";
  const services = createGroundlaneServices(parseConfig({ GROUNDLANE_AUTH_TOKEN: token }));
  const server = createServer(createContainerApp({ authToken: token, registryFactory: services.registryFactory }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "document-job-public", version: "1" });
  t.after(async () => { await client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await services.close(); });
  const anonymous = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "document_job_create", arguments: {} } }) });
  assert.equal(anonymous.status, 401);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith("document_job_")).sort(),
    ["document_job_cancel", "document_job_create", "document_job_status"]);
  const unavailable = await client.callTool({ name: "document_job_status", arguments: { jobId: "job" } });
  z.object({ ok: z.literal(false), error: z.object({ code: z.literal("PROVIDER_UNAVAILABLE") }) }).parse(unavailable.structuredContent);
});

void test("authenticated edge fallback supports atomic create, scheduler restart, credential isolation and cancel", async (t) => {
  let now = 1_800_000_000_000; let creates = 0;
  const caller = { ownerId: "owner", credentialBinding: "private-credential" };
  const principal = { principalId: "owner" as const, authMethod: "static_bearer" as const, scopes: ["mcp"] };
  const env = { MANAGED_TOKEN_D1: new SqliteD1(), GROUNDLANE_ARTIFACTS: new FakeR2() };
  t.after(() => env.MANAGED_TOKEN_D1.db.close());
  const upload = new DurableUploadArtifactService(new D1DurableRecordStore(env.MANAGED_TOKEN_D1, "artifact-upload-v1"), new R2ImmutableBlobStore(env.GROUNDLANE_ARTIFACTS));
  const bytes = new TextEncoder().encode("fixture source");
  const intent = await upload.createIntent({ idempotencyKey: "upload", declaredMime: "text/plain", declaredSize: bytes.length, filename: "source.txt", nowMs: now }, caller);
  const source = await upload.finalize({ intentId: intent.intentId, bytes, observedMime: "text/plain", nowMs: now }, caller);
  const provider = { providerId: "private-provider", create: () => { creates++; return Promise.resolve("private-provider-task"); },
    poll: () => Promise.resolve({ status: "pending" as const }), cancel: () => Promise.resolve({ acknowledged: false }) };
  const factory = () => createEdgeDocumentAsyncRuntime(env, provider, { now: () => now });
  const request = (name: string, args: unknown) => new Request("https://worker.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const call = async (name: string, args: unknown, credential = caller.credentialBinding) => {
    const service = factory();
    const response = await maybeHandleEdgeDocumentJobs(request(name, args), env, principal, credential, "request", { runtime: { submit: service.submit.bind(service), ...service.runtime }, now: () => now });
    assert.ok(response); const result: unknown = await response.json();
    assert.equal(JSON.stringify(result).includes("private-"), false); return result;
  };
  const input = { mode: "async", sourceRefId: source.refId, idempotencyKey: "create", expiresAt: now + 600_000, executionDeadlineAt: now + 600_000 };
  const created = z.object({ result: z.object({ structuredContent: z.object({ ok: z.literal(true), data: z.object({ jobId: z.string(), snapshot: z.object({ expiresAt: z.number() }) }) }) }) }).parse(await call("document_job_create", input));
  const jobId = created.result.structuredContent.data.jobId; assert.equal(creates, 0);
  assert.equal(created.result.structuredContent.data.snapshot.expiresAt, input.expiresAt);
  now++;
  assert.equal((await runDocumentJobTick({}, { runtime: factory() })).advanced, 1); assert.equal(creates, 1);
  const status = await call("document_job_status", { jobId });
  assert.ok(JSON.stringify(status).includes('"status":"running"'));
  assert.ok(JSON.stringify(await call("document_job_status", { jobId }, "other-binding")).includes('"ok":false'));
  assert.ok(JSON.stringify(await call("document_job_create", { ...input, credentialBinding: "caller-injection" })).includes('"ok":false'));
  const cancelled = await call("document_job_cancel", { jobId, upstream: true });
  assert.ok(JSON.stringify(cancelled).includes('"status":"cancelled"')); assert.ok(JSON.stringify(cancelled).includes('"upstreamAcknowledged":false'));
  now += 60_000; await runDocumentJobTick({}, { runtime: factory() }); assert.equal(creates, 1);
});

void test("async dispatch is opt-in and minute cadence cannot invoke hourly cleanup", async () => {
  assert.equal(configuredDocumentJobRuntime({}), undefined);
  assert.equal(configuredDocumentJobRuntime({ DOCUMENT_ASYNC_EDGE_ENABLED: "false", REDUCTO_API_KEY: "private-key" }), undefined);
  assert.equal(configuredDocumentJobRuntime({ DOCUMENT_ASYNC_EDGE_ENABLED: "true", REDUCTO_API_KEY: "private-key" }), undefined);
  assert.deepEqual(await runDocumentJobTick({}), { enabled: false, scanned: 0, advanced: 0 });
  assert.deepEqual(scheduledDocumentWork("* * * * *"), { asyncTick: true, hourlyCleanup: false });
  assert.deepEqual(scheduledDocumentWork("0 * * * *"), { asyncTick: false, hourlyCleanup: true });
  assert.deepEqual(scheduledDocumentWork("unknown"), { asyncTick: false, hourlyCleanup: false });
});
