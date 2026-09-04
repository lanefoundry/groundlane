import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCredentialsCliArgs,
  redactCredentialDisplay,
} from "../../src/worker/admin-credentials.js";

const ADMIN_SENTINEL = "TEST-ADMIN-SENTINEL-9f8e7d6c5b4a";
const FILE_SENTINEL = "TEST-FILE-SENTINEL-1a2b3c4d5e6f";

function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/groundlane-credentials.mts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, GROUNDLANE_ADMIN_TOKEN: ADMIN_SENTINEL, ...env },
  });
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Async spawn variant. Required whenever the CLI must reach the in-process
 * stub server: spawnSync would block the event loop and deadlock the server.
 */
function runCliAsync(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/groundlane-credentials.mts", ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, GROUNDLANE_ADMIN_TOKEN: ADMIN_SENTINEL, ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 25000);
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function parseStdoutJson(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout) as unknown;
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body: string;
}

function startStub(
  handler: (seen: SeenRequest) => { readonly status: number; readonly payload: unknown },
): Promise<{
  readonly baseUrl: string;
  readonly seen: SeenRequest[];
  readonly close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const seen: SeenRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        const current: SeenRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: Array.isArray(req.headers.authorization)
            ? req.headers.authorization.join(",")
            : (req.headers.authorization ?? ""),
          body,
        };
        seen.push(current);
        const { status, payload } = handler(current);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub server failed to listen"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        seen,
        close: () =>
          new Promise<void>((done, failed) => {
            server.close((error: Error | undefined) => {
              if (error !== undefined) failed(error);
              else done();
            });
          }),
      });
    });
  });
}

void test("credentials CLI create dry-run maps to POST /admin/credentials", () => {
  const result = runCli([
    "create",
    "--label",
    "agent-a",
    "--scopes",
    "mcp",
    "--expires-at",
    "4102444800000",
    "--dry-run",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const preview = parseStdoutJson(result.stdout);
  assert.equal(preview["method"], "POST");
  assert.match(asText(preview["url"]), /\/admin\/credentials$/u);
  assert.deepEqual(preview["body"], {
    label: "agent-a",
    scopes: ["mcp"],
    expiresAt: 4102444800000,
  });
  // Display argv carries no secrets and aligns with the worker arg builder.
  assert.deepEqual(
    preview["argv"],
    buildCredentialsCliArgs("create", {
      label: "agent-a",
      expiresAt: 4102444800000,
      scopes: "mcp",
    }),
  );
  assert.doesNotMatch(result.stdout, /SENTINEL/u);
});

void test("credentials CLI list dry-run supports pagination on defaults", () => {
  const result = runCli(["list", "--limit", "10", "--cursor", "20", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const preview = parseStdoutJson(result.stdout);
  assert.equal(preview["method"], "GET");
  const url = asText(preview["url"]);
  assert.match(url, /^http:\/\/127\.0\.0\.1:8787\/admin\/credentials\?/u);
  assert.match(url, /limit=10/u);
  assert.match(url, /cursor=20/u);
  assert.deepEqual(
    preview["argv"],
    buildCredentialsCliArgs("list", { limit: 10, cursor: "20" }),
  );
});

void test("credentials CLI rotate dry-run defaults overlap to 3600 with auto key", () => {
  const result = runCli(["rotate", "--id", "cred_test12", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const preview = parseStdoutJson(result.stdout);
  assert.equal(preview["method"], "POST");
  assert.match(asText(preview["url"]), /\/admin\/credentials\/rotate$/u);
  const body = preview["body"] as Record<string, unknown>;
  assert.equal(body["id"], "cred_test12");
  assert.equal(body["overlapSeconds"], 3600);
  assert.match(asText(body["idempotencyKey"]), /^[A-Za-z0-9_-]{1,128}$/u);
});

void test("credentials CLI rotate reuses an explicit idempotency key verbatim", () => {
  const first = runCli(["rotate", "--id", "cred_test12", "--idempotency-key", "reuse-key_123", "--dry-run"]);
  const second = runCli(["rotate", "--id", "cred_test12", "--idempotency-key", "reuse-key_123", "--dry-run"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstBody = (parseStdoutJson(first.stdout)["body"] ?? {}) as Record<string, unknown>;
  const secondBody = (parseStdoutJson(second.stdout)["body"] ?? {}) as Record<string, unknown>;
  assert.equal(firstBody["idempotencyKey"], "reuse-key_123");
  assert.equal(secondBody["idempotencyKey"], "reuse-key_123");
  assert.deepEqual(
    parseStdoutJson(first.stdout)["argv"],
    buildCredentialsCliArgs("rotate", {
      id: "cred_test12",
      overlapSeconds: 3600,
      idempotencyKey: "reuse-key_123",
    }),
  );
});

void test("credentials CLI auto idempotency keys differ per invocation", () => {
  const first = runCli(["rotate", "--id", "cred_test12", "--dry-run"]);
  const second = runCli(["rotate", "--id", "cred_test12", "--dry-run"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstBody = parseStdoutJson(first.stdout)["body"] as Record<string, unknown> | undefined;
  const secondBody = parseStdoutJson(second.stdout)["body"] as Record<string, unknown> | undefined;
  const firstKey = asText(firstBody?.["idempotencyKey"]);
  const secondKey = asText(secondBody?.["idempotencyKey"]);
  assert.match(firstKey, /^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(secondKey, /^[A-Za-z0-9_-]{1,128}$/u);
  assert.notEqual(firstKey, secondKey);
});

void test("credentials CLI accepts overlap boundary 0 and 86400", () => {
  for (const value of ["0", "86400"]) {
    const result = runCli(["rotate", "--id", "cred_test12", "--overlap-seconds", value, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    const body = (parseStdoutJson(result.stdout)["body"] ?? {}) as Record<string, unknown>;
    assert.equal(body["overlapSeconds"], Number(value));
  }
});

void test("credentials CLI rejects out-of-range overlap locally with exit 2", () => {
  for (const bad of ["-1", "86401", "1.5", "NaN", "abc"]) {
    const result = runCli(["rotate", "--id", "cred_test12", "--overlap-seconds", bad]);
    assert.equal(result.status, 2, bad);
    assert.match(result.stderr, /overlap/i, bad);
  }
});

void test("credentials CLI enforces list limit 1..100 with exit 2", () => {
  for (const good of ["1", "100"]) {
    const result = runCli(["list", "--limit", good, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
  }
  for (const bad of ["0", "101", "1000", "1.5", "abc"]) {
    const result = runCli(["list", "--limit", bad]);
    assert.equal(result.status, 2, bad);
    assert.match(result.stderr, /limit/i, bad);
  }
});

void test("credentials CLI rejects unbounded idempotency keys with exit 2", () => {
  const cases: readonly string[] = ["has space", "bad key!", "x".repeat(129)];
  for (const bad of cases) {
    const result = runCli(["rotate", "--id", "cred_test12", "--idempotency-key", bad]);
    assert.equal(result.status, 2, bad);
    assert.match(result.stderr, /idempotency/i, bad);
  }
  const emptyFlag = runCli(["rotate", "--id", "cred_test12", "--idempotency-key", ""]);
  assert.equal(emptyFlag.status, 2);
  assert.match(emptyFlag.stderr, /idempotency/i);
});

void test("credentials CLI has no token flag; usage errors exit 2", () => {
  for (const flag of ["--token", "--admin-token", "--bearer"]) {
    const result = runCli(["create", flag, "SECRET"]);
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /Unknown argument/u, flag);
  }
  const unknown = runCli(["audit"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown subcommand/u);
  const missingRotate = runCli(["rotate"]);
  assert.equal(missingRotate.status, 2);
  assert.match(missingRotate.stderr, /requires --id/u);
  const missingRevoke = runCli(["revoke"]);
  assert.equal(missingRevoke.status, 2);
  assert.match(missingRevoke.stderr, /requires --id/u);
  const bare = runCli([]);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /Usage/u);
});

void test("credentials CLI revoke dry-run maps to POST /admin/credentials/revoke", () => {
  const result = runCli(["revoke", "--id", "cred_test12", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const preview = parseStdoutJson(result.stdout);
  assert.equal(preview["method"], "POST");
  assert.match(asText(preview["url"]), /\/admin\/credentials\/revoke$/u);
  assert.deepEqual(preview["body"], { id: "cred_test12" });
});

void test("credentials CLI endpoint validation rejects unsafe targets with exit 2", () => {
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "http://user:pass@127.0.0.1:8787"]) {
    const result = runCli(["list", "--endpoint", bad]);
    assert.equal(result.status, 2, bad);
  }
  const fileEndpoint = runCli(["list", "--endpoint", "file:///etc/passwd"]);
  assert.match(fileEndpoint.stderr, /http/i);
});

void test("credentials CLI create prints the raw token once with a save reminder", async () => {
  const stub = await startStub(() => ({
    status: 201,
    payload: {
      id: "cred_new11",
      token: "glmt_cred_new11_single-output",
      secretAvailable: true,
      expiresAt: 4102444800000,
      scopes: ["mcp"],
    },
  }));
  try {
    const result = await runCliAsync([
      "--endpoint",
      stub.baseUrl,
      "create",
      "--label",
      "t",
      "--expires-at",
      "4102444800000",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /glmt_cred_new11_single-output/u);
    assert.match(result.stderr, /only.*once|save/i);
    // The admin bearer authorizes the call but never appears in output.
    assert.equal(stub.seen.length, 1);
    assert.equal(stub.seen[0]?.authorization, `Bearer ${ADMIN_SENTINEL}`);
    assert.equal(result.stdout.includes(ADMIN_SENTINEL), false);
    assert.equal(result.stderr.includes(ADMIN_SENTINEL), false);
  } finally {
    await stub.close();
  }
});

void test("credentials CLI list output strips leaked token and verifier fields", async () => {
  const workerRedacted = redactCredentialDisplay({
    id: "a",
    verifier: "v1",
    token: "glmt_a_secret",
    label: "x",
  });
  const stub = await startStub(() => ({
    status: 200,
    payload: {
      credentials: [
        { id: "a", verifier: "v1", token: "glmt_a_secret", label: "x" },
        { id: "b", verifier: "v2", secret: "s", authorization: "Bearer z" },
      ],
    },
  }));
  try {
    const result = await runCliAsync(["--endpoint", stub.baseUrl, "list", "--limit", "5"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /glmt_/u);
    assert.doesNotMatch(result.stdout, /verifier/u);
    assert.doesNotMatch(result.stdout, /authorization/u);
    assert.equal(result.stdout.includes(ADMIN_SENTINEL), false);
    const payload = parseStdoutJson(result.stdout);
    const credentials = payload["credentials"] as unknown[];
    assert.equal(credentials.length, 2);
    assert.deepEqual(credentials[0], workerRedacted);
  } finally {
    await stub.close();
  }
});

void test("credentials CLI revoke output never contains raw token or verifier", async () => {
  const stub = await startStub(() => ({
    status: 200,
    payload: { id: "cred_test12", status: "revoked", token: "glmt_leak", verifier: "v9" },
  }));
  try {
    const result = await runCliAsync(["--endpoint", stub.baseUrl, "revoke", "--id", "cred_test12"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /glmt_/u);
    assert.doesNotMatch(result.stdout, /verifier/u);
    assert.match(result.stdout, /cred_test12/u);
  } finally {
    await stub.close();
  }
});

void test("credentials CLI rotate replay without token reports secretAvailable false", async () => {
  const stub = await startStub(() => ({
    status: 200,
    payload: { id: "cred_new99", secretAvailable: false },
  }));
  try {
    const result = await runCliAsync(["--endpoint", stub.baseUrl, "rotate", "--id", "cred_test12"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /token/u);
    assert.match(result.stdout, /cred_new99/u);
    // The single attempt always carries one bounded idempotency key.
    assert.equal(stub.seen.length, 1);
    const body = parseStdoutJson(stub.seen[0]?.body ?? "{}");
    assert.equal(body["id"], "cred_test12");
    assert.equal(body["overlapSeconds"], 3600);
    assert.match(asText(body["idempotencyKey"]), /^[A-Za-z0-9_-]{1,128}$/u);
  } finally {
    await stub.close();
  }
});

void test("credentials CLI sanitized errors map status to stable exit codes", async () => {
  const cases: ReadonlyArray<{ readonly status: number; readonly exit: number; readonly hint: RegExp }> = [
    { status: 400, exit: 2, hint: /Invalid request/u },
    { status: 401, exit: 3, hint: /authentication/i },
    { status: 403, exit: 3, hint: /authorization/i },
    { status: 404, exit: 4, hint: /not found/i },
    { status: 409, exit: 4, hint: /conflict/i },
    { status: 503, exit: 4, hint: /unavailable|server/i },
  ];
  for (const { status, exit, hint } of cases) {
    const stub = await startStub(() => ({
      status,
      payload: { marker: "LEAKMARKER-should-never-print", token: "glmt_leak_body" },
    }));
    try {
      const result = await runCliAsync(["--endpoint", stub.baseUrl, "list"]);
      assert.equal(result.status, exit, `status ${status}`);
      assert.match(result.stderr, hint, `status ${status}`);
      assert.equal(result.stderr.includes("LEAKMARKER"), false, `status ${status}`);
      assert.equal(result.stderr.includes("glmt_leak_body"), false, `status ${status}`);
      assert.equal(result.stderr.includes(ADMIN_SENTINEL), false, `status ${status}`);
    } finally {
      await stub.close();
    }
  }
});

void test("credentials CLI maps network failure to exit 4", async () => {
  // Bind then close: the port is guaranteed shut, so no live server is needed.
  const stub = await startStub(() => ({ status: 200, payload: {} }));
  const closedUrl = stub.baseUrl;
  await stub.close();
  const result = runCli(["--endpoint", closedUrl, "list"]);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stderr.includes(ADMIN_SENTINEL), false);
});

void test("credentials CLI requires an admin token and prefers the token file", async () => {
  const stub = await startStub((seen) => {
    if (seen.authorization === `Bearer ${FILE_SENTINEL}`) {
      return { status: 200, payload: { credentials: [], via: "file" } };
    }
    if (seen.authorization === `Bearer ${ADMIN_SENTINEL}`) {
      return { status: 200, payload: { credentials: [], via: "env" } };
    }
    return { status: 401, payload: {} };
  });
  const directory = mkdtempSync(join(tmpdir(), "groundlane-creds-cli-"));
  try {
    const tokenPath = join(directory, "admin.token");
    writeFileSync(tokenPath, `${FILE_SENTINEL}\n`, { mode: 0o600 });

    const missing = await runCliAsync(["--endpoint", stub.baseUrl, "list"], { GROUNDLANE_ADMIN_TOKEN: "" });
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /admin token/i);

    const fromFile = await runCliAsync(["--endpoint", stub.baseUrl, "--token-file", tokenPath, "list"]);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    assert.match(fromFile.stdout, /"via": "file"/u);
    assert.equal(fromFile.stdout.includes(FILE_SENTINEL), false);
    assert.equal(fromFile.stderr.includes(FILE_SENTINEL), false);
  } finally {
    rmSync(directory, { recursive: true });
    await stub.close();
  }
});

void test("credentials CLI help documents safety contract without token flags", () => {
  const result = runCli(["--help"], { GROUNDLANE_ADMIN_TOKEN: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /groundlane credentials/u);
  assert.match(result.stdout, /exit 0/u);
  assert.match(result.stdout, /exit 2/u);
  assert.match(result.stdout, /exit 3/u);
  assert.match(result.stdout, /exit 4/u);
  assert.match(result.stdout, /GROUNDLANE_ADMIN_TOKEN/);
  assert.match(result.stdout, /--token-file/);
  assert.match(result.stdout, /idempotency/i);
  assert.match(result.stdout, /3600/);
  assert.match(result.stdout, /0\.\.86400/);
  assert.match(result.stdout, /--limit/);
  assert.match(result.stdout, /--cursor/);
  assert.match(result.stdout, /D1/);
  assert.match(result.stdout, /SQL/);
  assert.match(result.stdout, /only.*once|save/i);
  assert.match(result.stdout, /--dry-run/);
  assert.doesNotMatch(result.stdout, /--token\s+<secret>/i);
  assert.doesNotMatch(result.stdout, /glmt_/u);
});
