import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";

export const scenarios = ["Tasks lifecycle", "reconnect", "upload handoff", "legacy parse"];

/** @param {string} value */
export function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Use a literal loopback HTTP endpoint without credentials, query, or fragment");
  }
  return url.href;
}

/** @param {string} text @param {(string | undefined)[]} secrets */
export function sanitize(text, secrets = []) {
  let result = text;
  for (const secret of secrets.filter((value) => typeof value === "string" && value.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
    result = result.split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  return result
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s"'<>\\]+/g, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        if (url.search) url.search = "?[REDACTED]";
        url.hash = "";
        return url.href;
      } catch { return "[REDACTED_URL]"; }
    })
    .replace(/("(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)"\s*:\s*")[^"\r\n]*(")/gi, "$1[REDACTED]$2");
}

/**
 * @typedef {{code: number | null, signal: string | null, stopReason: string | undefined, stdout: string, stderr: string}} Execution
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd: string, env: Record<string, string | undefined>, timeoutMs: number, maxBytes: number, input?: string}} options
 * @returns {Promise<Execution>}
 */
export async function boundedProcess(executable, args, options) {
  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    /** @type {string | undefined} */
    let stopReason;
    /** @param {string} reason */
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The child may already have exited. */ }
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    child.stdout.on("data", (/** @type {import("node:buffer").Buffer} */ chunk) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) stop("output_limit");
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (/** @type {import("node:buffer").Buffer} */ chunk) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) stop("output_limit");
      else stderr += chunk.toString();
    });
    child.on("error", () => { stopReason = "spawn_error"; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stopReason, stdout, stderr });
    });
    child.stdin.on("error", () => { /* A version probe may close stdin immediately. */ });
    child.stdin.end(options.input ?? "");
  });
}

/** @param {Execution} execution @param {string} transcript */
export function summarizeCapture(execution, transcript) {
  return {
    captureStatus: execution.code === 0 && !execution.stopReason ? "captured" : "failed",
    status: execution.code === 0 && !execution.stopReason ? "not_run" : "fail",
    reason: execution.code === 0 && !execution.stopReason
      ? "Transcript captured; scenario assertions and native protocol behavior require review. Client prose and exit zero are not acceptance evidence."
      : execution.stopReason ?? "client_exit_nonzero",
    transcriptSha256: createHash("sha256").update(transcript).digest("hex"),
    scenarios: scenarios.map((name) => ({ name, status: "not_run" })),
  };
}
