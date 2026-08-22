import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

import {
  CLOUDFLARE_SECRET_DEFINITIONS,
  buildSecretBulkPayload,
  buildSecretCommandHelp,
  buildSecretStatus,
  parseSecretCommandArguments,
  parseSecretSelection,
  parseWranglerSecretNames,
  validateSecretValue,
  type CloudflareSecretDefinition,
} from "../src/core/cloudflare-secrets.js";

function wranglerArguments(
  command: readonly string[],
  environment: string | undefined,
): string[] {
  return [
    "exec",
    "wrangler",
    ...command,
    ...(environment === undefined ? [] : ["--env", environment]),
  ];
}

function runWrangler(
  command: readonly string[],
  environment: string | undefined,
  input?: string,
): string {
  const result = spawnSync("pnpm", wranglerArguments(command, environment), {
    cwd: process.cwd(),
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    maxBuffer: 1_000_000,
  });
  if (result.error !== undefined) {
    throw new Error("Unable to start Wrangler", { cause: result.error });
  }
  if (result.status !== 0) {
    const detail = input === undefined ? result.stderr.trim() : "";
    throw new Error(
      detail.length === 0 ? "Wrangler command failed" : `Wrangler command failed: ${detail}`,
    );
  }
  return result.stdout;
}

function listSecretNames(environment: string | undefined): string[] {
  return parseWranglerSecretNames(
    runWrangler(["secret", "list", "--format", "json"], environment),
  );
}

function targetLabel(environment: string | undefined): string {
  return environment === undefined ? "default Wrangler target" : environment;
}

const MAX_SECRET_IMPORT_BYTES = 64 * 1024;

function readSecretImport(path: string): Partial<Record<string, string>> {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error("Secret import path must be a regular file");
  if (stats.size > MAX_SECRET_IMPORT_BYTES) {
    throw new Error(`Secret import file exceeds ${MAX_SECRET_IMPORT_BYTES} bytes`);
  }
  const contents = readFileSync(path, "utf8");
  let values: Record<string, string | undefined>;
  if (extname(path).toLowerCase() === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw new Error("Secret import file is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Secret import JSON must be an object");
    }
    values = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new Error(`Secret import value for ${name} must be a string`);
      }
      values[name] = value;
    }
  } else {
    try {
      values = parseEnv(contents);
    } catch {
      throw new Error("Secret import file is not valid dotenv syntax");
    }
  }
  return buildSecretBulkPayload(values);
}

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive setup requires a TTY");
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Secret setup was cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) value = [...value].slice(0, -1).join("");
          continue;
        }
        value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function promptSecret(
  definition: CloudflareSecretDefinition,
  configured: boolean,
): Promise<string | undefined> {
  while (true) {
    const suffix = configured ? "configured; blank keeps current" : "blank skips";
    const value = await readHidden(`${definition.label} (${definition.name}; ${suffix}): `);
    if (value.trim().length === 0) {
      if (!configured && definition.required) {
        process.stdout.write(`${definition.name} is required.\n`);
        continue;
      }
      return undefined;
    }
    const issue = validateSecretValue(definition, value);
    if (issue !== undefined) {
      process.stdout.write(`${definition.name} ${issue}.\n`);
      continue;
    }
    return value;
  }
}

async function confirm(message: string): Promise<boolean> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await reader.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    reader.close();
  }
}

async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive setup requires a TTY");
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}

async function selectSecrets(
  existing: ReadonlySet<string>,
): Promise<CloudflareSecretDefinition[]> {
  process.stdout.write("\nChoose secrets to create or replace:\n");
  let previousGroup: CloudflareSecretDefinition["group"] | undefined;
  for (const [index, definition] of CLOUDFLARE_SECRET_DEFINITIONS.entries()) {
    if (definition.group !== previousGroup) {
      process.stdout.write(`\n${definition.group}:\n`);
      previousGroup = definition.group;
    }
    const state = existing.has(definition.name)
      ? "configured"
      : definition.required
        ? "required"
        : "not configured";
    process.stdout.write(`  ${index + 1}. ${definition.label} [${state}]\n`);
  }
  process.stdout.write("\nUse numbers, ranges, or all (example: 2,4-6).\n");
  while (true) {
    const input = await readLine("Selection (blank cancels): ");
    try {
      const selected = parseSecretSelection(input, CLOUDFLARE_SECRET_DEFINITIONS);
      const missingRequired = CLOUDFLARE_SECRET_DEFINITIONS.filter(
        (definition) => definition.required && !existing.has(definition.name),
      );
      if (selected.length === 0 && missingRequired.length === 0) return [];
      const names = new Set(selected.map((definition) => definition.name));
      for (const definition of missingRequired) names.add(definition.name);
      if (missingRequired.length > 0) {
        process.stdout.write("Missing required authentication was selected automatically.\n");
      }
      return CLOUDFLARE_SECRET_DEFINITIONS.filter((definition) =>
        names.has(definition.name),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid selection";
      process.stdout.write(`${message}. Try again.\n`);
    }
  }
}

async function setup(arguments_: readonly string[]): Promise<void> {
  const options = parseSecretCommandArguments(arguments_);
  if (options.help) {
    process.stdout.write(`${buildSecretCommandHelp("setup")}\n`);
    return;
  }
  if (options.fromFile !== undefined) {
    const payload = readSecretImport(options.fromFile);
    const names = Object.keys(payload).sort();
    process.stdout.write(`Cloudflare target: ${targetLabel(options.environment)}\n`);
    if (names.length === 0) {
      process.stdout.write("No secret changes found in the import file.\n");
      return;
    }
    process.stdout.write(`Selected secret names (${names.length}):\n`);
    for (const name of names) process.stdout.write(`- ${name}\n`);
    if (options.dryRun) {
      process.stdout.write("Dry run: nothing was sent to Cloudflare.\n");
      return;
    }
    if (!options.yes && !(await confirm("Apply these secret changes?"))) {
      process.stdout.write("Cancelled; nothing was sent to Cloudflare.\n");
      return;
    }
    const output = runWrangler(
      ["secret", "bulk"],
      options.environment,
      JSON.stringify(payload),
    );
    if (output.trim().length > 0) process.stdout.write(output);
    process.stdout.write("Secret values were sent through Wrangler stdin and were not saved by Groundlane.\n");
    return;
  }
  const existingNames = listSecretNames(options.environment);
  const existing = new Set(existingNames);
  process.stdout.write(`Cloudflare target: ${targetLabel(options.environment)}\n`);
  const selected = await selectSecrets(existing);
  if (selected.length === 0) {
    process.stdout.write("No secret changes selected.\n");
    return;
  }

  const updates: Record<string, string | undefined> = {};
  for (const definition of selected) {
    updates[definition.name] = await promptSecret(
      definition,
      existing.has(definition.name),
    );
  }
  const payload = buildSecretBulkPayload(updates);
  const names = Object.keys(payload).sort();
  if (names.length === 0) {
    process.stdout.write("No secret changes selected.\n");
    return;
  }

  process.stdout.write(`\nSelected secret names (${names.length}):\n`);
  for (const name of names) process.stdout.write(`- ${name}\n`);
  if (options.dryRun) {
    process.stdout.write("Dry run: nothing was sent to Cloudflare.\n");
    return;
  }
  if (!options.yes && !(await confirm("Apply these secret changes?"))) {
    process.stdout.write("Cancelled; nothing was sent to Cloudflare.\n");
    return;
  }

  const output = runWrangler(
    ["secret", "bulk"],
    options.environment,
    JSON.stringify(payload),
  );
  if (output.trim().length > 0) process.stdout.write(output);
  process.stdout.write("Secret values were sent through Wrangler stdin and were not saved locally.\n");
}

function status(arguments_: readonly string[]): void {
  const options = parseSecretCommandArguments(arguments_);
  if (options.help) {
    process.stdout.write(`${buildSecretCommandHelp("status")}\n`);
    return;
  }
  if (options.dryRun || options.fromFile !== undefined || options.yes) {
    throw new Error("secrets:status accepts only --env <name>");
  }
  const status_ = buildSecretStatus(listSecretNames(options.environment));
  process.stdout.write(`Cloudflare target: ${targetLabel(options.environment)}\n\n`);
  for (const group of ["authentication", "search", "browser"] as const) {
    process.stdout.write(`${group}:\n`);
    for (const row of status_.rows.filter((candidate) => candidate.group === group)) {
      process.stdout.write(
        `- ${row.configured ? "configured" : row.state}: ${row.name} (${row.label})\n`,
      );
    }
  }
  if (status_.unknownNames.length > 0) {
    process.stdout.write("\nOther Cloudflare secrets not owned by this manifest:\n");
    for (const name of status_.unknownNames) process.stdout.write(`- ${name}\n`);
  }
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write(
      "Usage: cloudflare-secrets.mts <setup|status> [options]\n\n" +
        "Run `pnpm secrets:setup -- --help` or `pnpm secrets:status -- --help` for command help.\n",
    );
    return;
  }
  if (command === "setup") {
    await setup(arguments_);
    return;
  }
  if (command === "status") {
    status(arguments_);
    return;
  }
  throw new Error("Usage: cloudflare-secrets.mts <setup|status> [--env <name>] [--dry-run] [--yes]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Secret command failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
