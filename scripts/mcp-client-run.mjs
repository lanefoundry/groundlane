import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import process from "node:process";
import { Buffer } from "node:buffer";
import { boundedProcess, localEndpoint, sanitize, scenarios, summarizeCapture } from "./mcp-client-evidence.mjs";

const { values } = parseArgs({ options: {
  client: { type: "string" }, executable: { type: "string" }, output: { type: "string" },
  endpoint: { type: "string" }, prompt: { type: "string" }, model: { type: "string" },
  "timeout-ms": { type: "string", default: "120000" }, run: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });

if (values.help) {
  process.stdout.write("Usage: node scripts/mcp-client-run.mjs --client Claude|Codex|Cursor [--executable PATH] [--output DIR]\nDefault: version/help probes only; never invokes a model.\nExplicit live capture: --run --endpoint http://127.0.0.1:PORT/mcp --prompt PUBLIC_FIXTURE_PROMPT_FILE --model MODEL [--timeout-ms 120000]\nSet GROUNDLANE_CLIENT_TEST_TOKEN and ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY (Codex). Only use a disposable local server with synthetic fixtures. Live capture can incur model charges. Cursor isolation is not verified and live capture is unsupported.\nExit zero is not compatibility acceptance; review sanitized client events alongside native server wire evidence for every scenario. No raw secret-bearing output is persisted.\n");
} else {
  if (!["Claude", "Codex", "Cursor"].includes(values.client)) throw new Error("Choose --client Claude, Codex, or Cursor");
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error("timeout-ms must be 100..300000");
  const endpoint = values.endpoint ? localEndpoint(values.endpoint) : undefined;
  if (values.run && (!endpoint || !values.prompt || !values.model)) throw new Error("Live capture requires endpoint, prompt file, and explicit model");
  const output = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), "groundlane-client-evidence-"));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(tmpdir(), "groundlane-client-workspace-"));
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const candidate = values.executable ?? (values.client === "Claude" ? "claude" : values.client === "Codex" ? "codex" : "cursor-agent");
  let executable;
  for (const path of candidate.includes("/") ? [resolve(candidate)] : (process.env.PATH ?? "").split(delimiter).map((entry) => join(entry, candidate))) {
    try { executable = await realpath(path); break; } catch { /* Continue PATH lookup. */ }
  }
  const result = {
    schemaVersion: "1", evidenceKind: "real-client-cli", client: values.client,
    executable: executable ?? candidate, recordedAt: new Date().toISOString(),
    workspace, status: "not_run", reason: "Probe only; no model or scenario execution requested",
    scenarios: scenarios.map((name) => ({ name, status: "not_run" })),
  };
  const secrets = [process.env.GROUNDLANE_CLIENT_TEST_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY];
  if (!executable) {
    result.status = "unsupported";
    result.reason = "Client executable was not found";
  } else {
    const options = { cwd: workspace, env, timeoutMs: Math.min(timeoutMs, 10000), maxBytes: 128 * 1024 };
    const version = await boundedProcess(executable, ["--version"], options);
    const help = await boundedProcess(executable, values.client === "Codex" ? ["exec", "--help"] : ["--help"], options);
    result.version = sanitize(version.stdout.trim(), secrets);
    const identity = values.client === "Claude" ? /Claude Code/ : values.client === "Codex" ? /codex-cli/ : /Start the Cursor Agent/;
    const identityText = values.client === "Cursor" ? help.stdout : version.stdout;
    const requiredFlags = values.client === "Claude"
      ? ["--bare", "--strict-mcp-config", "--setting-sources", "--no-session-persistence"]
      : ["--ignore-user-config", "--ignore-rules", "--ephemeral"];
    if (version.code !== 0 || help.code !== 0 || version.stopReason || help.stopReason || !identity.test(identityText)) {
      result.status = "unsupported";
      result.reason = "Version/help probe failed or executable identity does not match selected client";
    } else if (values.client === "Cursor" || requiredFlags.some((flag) => !help.stdout.includes(flag))) {
      result.status = "unsupported";
      result.reason = "A supported configuration-isolation interface has not been verified for this client";
    } else if (values.run) {
      const token = process.env.GROUNDLANE_CLIENT_TEST_TOKEN;
      const modelKey = values.client === "Claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      if (!token || !process.env[modelKey]) throw new Error("Explicit test token and selected client model API key are required");
      env.GROUNDLANE_CLIENT_TEST_TOKEN = token;
      env[modelKey] = process.env[modelKey];
      const prompt = await readFile(resolve(values.prompt), "utf8");
      if (Buffer.byteLength(prompt) > 32768) throw new Error("Prompt exceeds 32 KiB fixture bound");
      const args = values.client === "Claude" ? [
        "--bare", "--print", "--verbose", "--output-format", "stream-json",
        "--strict-mcp-config", "--setting-sources", "", "--settings", "{}",
        "--no-session-persistence", "--disable-slash-commands", "--tools", "",
        "--permission-mode", "dontAsk", "--allowedTools", "mcp__groundlane__*",
        "--model", values.model, "--max-budget-usd", "1",
        "--mcp-config", JSON.stringify({ mcpServers: { groundlane: { type: "http", url: endpoint,
          headers: { Authorization: "Bearer ${GROUNDLANE_CLIENT_TEST_TOKEN}" } } } }),
      ] : [
        "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json",
        "--skip-git-repo-check", "--sandbox", "read-only", "--model", values.model,
        "-c", 'forced_login_method="api"', "-c", 'approval_policy="never"',
        "-c", `mcp_servers.groundlane.url=${JSON.stringify(endpoint)}`,
        "-c", 'mcp_servers.groundlane.bearer_token_env_var="GROUNDLANE_CLIENT_TEST_TOKEN"', "-",
      ];
      result.isolation = { temporaryWorkspace: true, inheritedEnvironment: Object.keys(env), userConfigurationDisabled: true };
      const execution = await boundedProcess(executable, args, {
        cwd: workspace, env, timeoutMs, maxBytes: 2 * 1024 * 1024,
        input: `Use only the configured Groundlane MCP tools and synthetic fixtures. Do not use shell, file tools, external browsing, or substitute HTTP clients. Report unavailable native protocol operations explicitly.\n${prompt}`,
      });
      const transcript = JSON.stringify({ stdout: sanitize(execution.stdout, secrets), stderr: sanitize(execution.stderr, secrets) });
      await writeFile(join(output, "transcript.json"), `${transcript}\n`, { mode: 0o600, flag: "wx" });
      Object.assign(result, summarizeCapture(execution, transcript), { exitCode: execution.code, signal: execution.signal });
    }
  }
  await writeFile(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ output, client: result.client, status: result.status, reason: result.reason })}\n`);
  if (result.status === "fail") process.exitCode = 1;
}
