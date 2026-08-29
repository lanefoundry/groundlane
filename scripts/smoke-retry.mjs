import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const maxAttempts = Number.parseInt(process.env.GROUNDLANE_SMOKE_ATTEMPTS ?? "12", 10);
const delayMs = Number.parseInt(process.env.GROUNDLANE_SMOKE_DELAY_MS ?? "10000", 10);

assert.ok(Number.isInteger(maxAttempts) && maxAttempts > 0, "Invalid smoke attempt count");
assert.ok(Number.isInteger(delayMs) && delayMs >= 1_000, "Invalid smoke retry delay");

function runSmoke() {
  return spawnSync("node", ["scripts/smoke.mjs"], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let lastStatus = "unknown";

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = runSmoke();
  if (result.status === 0) {
    process.stdout.write(result.stdout);
    process.stdout.write(`Production smoke passed (${attempt}/${maxAttempts})\n`);
    process.exit(0);
  }

  lastStatus = String(result.status ?? "signal");
  process.stdout.write(`Production smoke not ready (${attempt}/${maxAttempts}); retrying\n`);
  if (attempt < maxAttempts) {
    await sleep(delayMs);
  }
}

throw new Error(`Production smoke failed after ${maxAttempts} attempts; last status: ${lastStatus}`);
