import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";

const manifestPath = resolve("test/fixtures/mcp/matrix.json");
const pendingGateSchema = z.object({ status: z.string() }).passthrough();
const manifestSchema = z.object({
  deterministic: z.object({ testFiles: z.array(z.string().min(1)).min(1) }),
  officialConformance: pendingGateSchema,
  controlledCloudflare: pendingGateSchema,
  targetClients: z.array(z.object({ client: z.string(), status: z.string() }).passthrough()),
}).passthrough();
const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
const outputPath = resolve(process.env.GROUNDLANE_MCP_MATRIX_OUTPUT ?? ".work/mcp-matrix/results.json");
const startedAt = new Date();
const command = [
  "--test",
  "--import",
  "tsx",
  "--import",
  "./test/support/node-test-setup.mjs",
  ...manifest.deterministic.testFiles,
];
const execution = spawnSync(process.execPath, command, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, CI: "true" },
  maxBuffer: 8 * 1024 * 1024,
});
const finishedAt = new Date();
const result = {
  schemaVersion: "1",
  manifest: "test/fixtures/mcp/matrix.json",
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  deterministic: {
    status: execution.status === 0 ? "passed" : "failed",
    exitCode: execution.status,
    signal: execution.signal,
    testFiles: manifest.deterministic.testFiles,
    stdout: execution.stdout,
    stderr: execution.stderr,
  },
  officialConformance: manifest.officialConformance,
  controlledCloudflare: manifest.controlledCloudflare,
  targetClients: manifest.targetClients,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  ok: execution.status === 0,
  outputPath,
  deterministicStatus: result.deterministic.status,
  officialConformanceStatus: result.officialConformance.status,
  controlledCloudflareStatus: result.controlledCloudflare.status,
  targetClients: result.targetClients.map(({ client, status }) => ({ client, status })),
}, null, 2)}\n`);
if (execution.error !== undefined) throw execution.error;
if (execution.status !== 0) process.exitCode = execution.status ?? 1;
