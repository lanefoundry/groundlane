import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const STARTUP_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_CHARS = 4_000;

/** @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ExitOutcome */

const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
assert.ok(address !== null && typeof address === "object");
const port = address.port;
await new Promise((resolve, reject) => {
  reservation.close((error) => error === undefined ? resolve() : reject(error));
});

const child = spawn(process.execPath, ["dist/container/server.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    GROUNDLANE_AUTH_MODE: "local_static",
    GROUNDLANE_AUTH_TOKEN: "bundle-check-token-0123456789abcdef",
    GROUNDLANE_INTERNAL_SIGNING_SECRET: "",
    DOCUMENT_CACHE_STATE_PATH: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout = `${stdout}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS);
});
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS);
});

/** @type {Promise<ExitOutcome>} */
const exited = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const deadline = Date.now() + STARTUP_TIMEOUT_MS;
let started = false;
while (Date.now() < deadline) {
  if (stdout.includes('"event":"server_started"')) {
    started = true;
    break;
  }
  const outcome = await Promise.race([exited, sleep(25).then(() => null)]);
  if (outcome !== null) break;
}

if (!started) {
  child.kill("SIGKILL");
  const outcome = await exited;
  throw new Error(
    `Container bundle failed to start (${JSON.stringify(outcome)}). stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
  );
}

child.kill("SIGTERM");
const outcome = await exited;
assert.equal(outcome.signal, null);
assert.equal(outcome.code, 0);
process.stdout.write("Container bundle startup check passed\n");
