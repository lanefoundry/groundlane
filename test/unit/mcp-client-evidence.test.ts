import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { z } from "zod";
import { boundedProcess, localEndpoint, sanitize, summarizeCapture } from "../../scripts/mcp-client-evidence.mjs";

void test("client evidence restricts live destinations to literal loopback without URL credentials", () => {
  assert.equal(localEndpoint("http://127.0.0.1:8787/mcp"), "http://127.0.0.1:8787/mcp");
  assert.equal(localEndpoint("http://[::1]:8787/mcp"), "http://[::1]:8787/mcp");
  for (const value of ["https://example.com/mcp", "http://localhost/mcp", "http://127.0.0.1/mcp?token=x", "http://user:pass@127.0.0.1/mcp", "file:///tmp/mcp"]) {
    assert.throws(() => localEndpoint(value));
  }
});

void test("client transcript removes known credentials, auth fields and signed query material", () => {
  const credential = "synthetic+credential/only";
  const input = JSON.stringify({ authorization: "Bearer unlisted-credential", cookie: "session=private", api_key: "unlisted-api-key" })
    + ` ${credential} ${encodeURIComponent(credential)} https://user:pass@example.test/blob?X-Amz-Signature=private&key=private`;
  const sanitized = sanitize(input, [credential, undefined, ""]);
  for (const forbidden of [credential, encodeURIComponent(credential), "unlisted-credential", "session=private", "unlisted-api-key", "user:pass", "X-Amz-Signature", "key=private"]) {
    assert.equal(sanitized.includes(forbidden), false, forbidden);
  }
});

void test("successful model prose never becomes a compatibility pass", () => {
  const result = summarizeCapture({ code: 0, signal: null, stopReason: undefined, stdout: "all tests passed", stderr: "" }, "sanitized evidence");
  assert.equal(result.captureStatus, "captured");
  assert.equal(result.status, "not_run");
  assert.ok(result.scenarios.every((scenario) => scenario.status === "not_run"));
  assert.match(result.transcriptSha256, /^[a-f0-9]{64}$/);
});

void test("bounded client runner stops hanging and excessively noisy processes", async () => {
  const options = { cwd: process.cwd(), env: {}, timeoutMs: 200, maxBytes: 128 };
  const hung = await boundedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
  assert.equal(hung.stopReason, "timeout");
  assert.equal(summarizeCapture(hung, "").status, "fail");
  const noisy = await boundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024));setInterval(() => {},1000)"], { ...options, timeoutMs: 2000 });
  assert.equal(noisy.stopReason, "output_limit");
  assert.ok(noisy.stdout.length <= 128);
});

void test("bounded client runner captures stdin and handles missing executables", async () => {
  const options = { cwd: process.cwd(), env: {}, timeoutMs: 2000, maxBytes: 1024, input: "fixture" };
  const echo = await boundedProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], options);
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout, "fixture");
  const absent = await boundedProcess("/groundlane-fixture-no-such-executable", [], options);
  assert.equal(absent.stopReason, "spawn_error");
});

void test("client probe rejects a substitute executable and never treats its exit as acceptance", async () => {
  const output = await mkdtemp(join(tmpdir(), "groundlane-client-test-"));
  let workspace: string | undefined;
  try {
    const run = await boundedProcess(process.execPath, [
      "scripts/mcp-client-run.mjs", "--client", "Codex", "--executable", process.execPath, "--output", output,
    ], { cwd: process.cwd(), env: {}, timeoutMs: 5000, maxBytes: 8192 });
    assert.equal(run.code, 0, run.stderr);
    const report = z.object({ status: z.string(), workspace: z.string(), reason: z.string() }).parse(JSON.parse(await readFile(join(output, "result.json"), "utf8")));
    workspace = report.workspace;
    assert.equal(report.status, "unsupported");
    assert.match(report.reason, /identity/);
    await assert.rejects(readFile(join(output, "transcript.json")));
  } finally {
    await rm(output, { recursive: true, force: true });
    if (workspace && resolve(workspace).startsWith(join(tmpdir(), "groundlane-client-workspace-"))) await rm(workspace, { recursive: true, force: true });
  }
});
