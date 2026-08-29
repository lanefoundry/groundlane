import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

import {
  CLOUDFLARE_SECRET_DEFINITIONS,
  buildSecretBulkPayload,
  buildSecretCommandHelp,
  buildSecretStatus,
  parseSecretSelection,
  parseSecretCommandArguments,
  parseWranglerSecretNames,
  validateSecretValue,
} from "../../src/core/cloudflare-secrets.js";

void test("Cloudflare secret manifest contains runtime-forwarded credentials", () => {
  assert.deepEqual(
    CLOUDFLARE_SECRET_DEFINITIONS.map((definition) => definition.name),
    [
      "GROUNDLANE_AUTH_TOKEN",
      "OAUTH_OWNER_PASSPHRASE",
      "TAVILY_API_KEY",
      "EXA_API_KEY",
      "BRAVE_API_KEY",
      "FIRECRAWL_API_KEY",
      "SERPAPI_API_KEY",
      "SEARCHAPI_API_KEY",
      "BROWSERBASE_API_KEY",
      "PARALLEL_API_KEY",
      "LINKUP_API_KEY",
      "KEENABLE_API_KEY",
      "TINYFISH_API_KEY",
      "SERPER_API_KEY",
      "YOU_API_KEY",
      "BROWSERLESS_TOKEN",
    ],
  );
  assert.equal(CLOUDFLARE_SECRET_DEFINITIONS[0]?.required, true);
});

void test("Cloudflare secret import template stays synchronized and blank", () => {
  const template = parseEnv(
    readFileSync(join(process.cwd(), "cloudflare-secrets.example.env"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(template).sort(),
    CLOUDFLARE_SECRET_DEFINITIONS.map((definition) => definition.name).sort(),
  );
  assert.ok(Object.values(template).every((value) => value === ""));
});

void test("Cloudflare onboarding invokes the deploy package script unambiguously", () => {
  for (const path of [
    "README.md",
    "README.zh-TW.md",
    "docs/deployment/cloudflare.md",
  ]) {
    const contents = readFileSync(join(process.cwd(), path), "utf8");
    assert.doesNotMatch(contents, /\bpnpm deploy\b/u, path);
    assert.match(contents, /\bpnpm run deploy\b/u, path);
  }
});

void test("Cloudflare CD deploys main only after the quality gate", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(workflow, /deploy:\n\s+if: .*refs\/heads\/main/u);
  assert.match(workflow, /needs: quality/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  assert.match(workflow, /run: pnpm run deploy/u);
  assert.doesNotMatch(workflow, /wrangler deploy[^\n]*--(?:api-token|account-id)/u);
});

void test("bulk payload includes only known non-blank updates", () => {
  assert.deepEqual(
    buildSecretBulkPayload({
      GROUNDLANE_AUTH_TOKEN: "x".repeat(32),
      TAVILY_API_KEY: "tavily-secret",
      EXA_API_KEY: "",
      BRAVE_API_KEY: "   ",
    }),
    {
      GROUNDLANE_AUTH_TOKEN: "x".repeat(32),
      TAVILY_API_KEY: "tavily-secret",
    },
  );
  assert.throws(
    () => buildSecretBulkPayload({ UNKNOWN_API_KEY: "secret" }),
    /Unknown Cloudflare secret/u,
  );
});

void test("secret validation enforces authentication token length", () => {
  const auth = CLOUDFLARE_SECRET_DEFINITIONS.find(
    (definition) => definition.name === "GROUNDLANE_AUTH_TOKEN",
  );
  const tavily = CLOUDFLARE_SECRET_DEFINITIONS.find(
    (definition) => definition.name === "TAVILY_API_KEY",
  );
  assert.ok(auth);
  assert.ok(tavily);
  assert.equal(validateSecretValue(auth, "short"), "must contain at least 32 characters");
  assert.equal(validateSecretValue(auth, "x".repeat(32)), undefined);
  assert.equal(validateSecretValue(tavily, "provider-key"), undefined);
});

void test("secret status is name-only and marks required gaps", () => {
  const status = buildSecretStatus(["TAVILY_API_KEY", "UNKNOWN_SECRET"]);
  assert.equal(status.rows.find((row) => row.name === "TAVILY_API_KEY")?.configured, true);
  assert.equal(status.rows.find((row) => row.name === "EXA_API_KEY")?.configured, false);
  assert.equal(
    status.rows.find((row) => row.name === "GROUNDLANE_AUTH_TOKEN")?.state,
    "required",
  );
  assert.deepEqual(status.unknownNames, ["UNKNOWN_SECRET"]);
});

void test("secret command arguments preserve Wrangler environment selection", () => {
  assert.deepEqual(
    parseSecretCommandArguments(["--", "--env", "production", "--dry-run", "--yes"]),
    { environment: "production", dryRun: true, help: false, yes: true },
  );
  assert.deepEqual(parseSecretCommandArguments(["--help"]), {
    dryRun: false,
    help: true,
    yes: false,
  });
  assert.deepEqual(
    parseSecretCommandArguments(["--from-file", "provider-secrets.env", "--dry-run"]),
    {
      dryRun: true,
      fromFile: "provider-secrets.env",
      help: false,
      yes: false,
    },
  );
  assert.throws(() => parseSecretCommandArguments(["--env"]), /requires a value/u);
  assert.throws(() => parseSecretCommandArguments(["--from-file"]), /requires a value/u);
  assert.throws(() => parseSecretCommandArguments(["--unknown"]), /Unknown argument/u);
});

void test("secret command help explains Cloudflare scope and safe defaults", () => {
  const setupHelp = buildSecretCommandHelp("setup");
  assert.match(setupHelp, /pnpm secrets:setup/u);
  assert.match(setupHelp, /default Wrangler target/u);
  assert.match(setupHelp, /local \.env/u);
  assert.match(setupHelp, /--dry-run/u);
  assert.match(setupHelp, /--from-file/u);
  assert.match(setupHelp, /interactive TTY/u);

  const statusHelp = buildSecretCommandHelp("status");
  assert.match(statusHelp, /pnpm secrets:status/u);
  assert.match(statusHelp, /names only/u);
  assert.doesNotMatch(statusHelp, /--dry-run/u);
});

void test("provider selection accepts comma-separated numbers and ranges", () => {
  const providers = CLOUDFLARE_SECRET_DEFINITIONS.filter(
    (definition) => !definition.required,
  );
  assert.deepEqual(
    parseSecretSelection("1, 3-4, 3", providers).map(
      (definition) => definition.name,
    ),
    ["TAVILY_API_KEY", "BRAVE_API_KEY", "FIRECRAWL_API_KEY"],
  );
  assert.deepEqual(parseSecretSelection("", providers), []);
  assert.deepEqual(parseSecretSelection("all", providers), providers);
});

void test("provider selection rejects invalid choices", () => {
  const providers = CLOUDFLARE_SECRET_DEFINITIONS.filter(
    (definition) => !definition.required,
  );
  assert.throws(() => parseSecretSelection("0", providers), /between 1 and 14/u);
  assert.throws(() => parseSecretSelection("4-2", providers), /Invalid range/u);
  assert.throws(() => parseSecretSelection("tavily", providers), /Invalid selection/u);
});

void test("secret CLI help exits before contacting Wrangler", () => {
  for (const command of ["setup", "status"] as const) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/cloudflare-secrets.mts", command, "--help"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`pnpm secrets:${command}`, "u"));
    assert.doesNotMatch(result.stderr, /Wrangler/u);
  }
});

void test("status rejects setup-only flags before contacting Wrangler", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/cloudflare-secrets.mts", "status", "--dry-run"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts only --env/u);
  assert.doesNotMatch(result.stderr, /Wrangler command failed/u);
});

void test("file import dry-run accepts dotenv and JSON without contacting Wrangler or printing values", () => {
  const directory = mkdtempSync(join(tmpdir(), "groundlane-secret-import-"));
  const dotenvPath = join(directory, "providers.env");
  const jsonPath = join(directory, "providers.json");
  writeFileSync(
    dotenvPath,
    "TAVILY_API_KEY=tavily-test-secret\nBRAVE_API_KEY=brave-test-secret\n",
    { mode: 0o600 },
  );
  writeFileSync(
    jsonPath,
    JSON.stringify({
      TAVILY_API_KEY: "tavily-test-secret",
      BRAVE_API_KEY: "brave-test-secret",
    }),
    { mode: 0o600 },
  );
  try {
    for (const path of [dotenvPath, jsonPath]) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/cloudflare-secrets.mts",
          "setup",
          "--from-file",
          path,
          "--dry-run",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BRAVE_API_KEY/u);
      assert.match(result.stdout, /TAVILY_API_KEY/u);
      assert.match(result.stdout, /nothing was sent to Cloudflare/u);
      assert.doesNotMatch(result.stdout, /test-secret/u);
      assert.doesNotMatch(result.stderr, /Wrangler/u);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

void test("Wrangler secret list parsing exposes names only", () => {
  assert.deepEqual(
    parseWranglerSecretNames(
      JSON.stringify([
        { name: "TAVILY_API_KEY", type: "secret_text" },
        { name: "GROUNDLANE_AUTH_TOKEN", type: "secret_text" },
      ]),
    ),
    ["GROUNDLANE_AUTH_TOKEN", "TAVILY_API_KEY"],
  );
  assert.throws(() => parseWranglerSecretNames('{"name":"not-an-array"}'), /array/u);
  assert.throws(() => parseWranglerSecretNames('[{"type":"secret_text"}]'), /name/u);
});
