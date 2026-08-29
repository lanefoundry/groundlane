import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const appName = process.env.GROUNDLANE_CONTAINER_APP ?? "groundlane-groundlanecontainer";
const maxAttempts = Number.parseInt(process.env.GROUNDLANE_CONTAINER_WAIT_ATTEMPTS ?? "20", 10);
const delayMs = Number.parseInt(process.env.GROUNDLANE_CONTAINER_WAIT_DELAY_MS ?? "15000", 10);
const acceptableStates = new Set(["active", "ready"]);

assert.ok(Number.isInteger(maxAttempts) && maxAttempts > 0, "Invalid container wait attempt count");
assert.ok(Number.isInteger(delayMs) && delayMs >= 1_000, "Invalid container wait delay");

function listContainers() {
  return spawnSync("pnpm", ["exec", "wrangler", "containers", "list"], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * @param {string} output
 * @returns {string | undefined}
 */
function parseState(output) {
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes(appName));
  if (line === undefined) return undefined;
  const cells = line
    .split("│")
    .map((cell) => cell.trim())
    .filter(Boolean);
  const nameIndex = cells.findIndex((cell) => cell === appName);
  return nameIndex >= 0 ? cells[nameIndex + 1] : undefined;
}

let lastState = "unknown";
let lastError = "";

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = listContainers();
  if (result.status === 0) {
    const state = parseState(result.stdout);
    if (state !== undefined) {
      lastState = state;
      process.stdout.write(
        `Container application ${appName} is ${state} (${attempt}/${maxAttempts})\n`,
      );
      if (acceptableStates.has(state)) {
        process.exit(0);
      }
    } else {
      lastError = `Container application ${appName} was not found`;
    }
  } else {
    lastError = result.stderr.trim() || `wrangler containers list exited ${result.status ?? "unknown"}`;
  }

  if (attempt < maxAttempts) {
    await sleep(delayMs);
  }
}

throw new Error(
  lastError || `Container application ${appName} did not become active; last state: ${lastState}`,
);
