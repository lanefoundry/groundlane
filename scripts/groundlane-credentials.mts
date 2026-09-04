/**
 * `groundlane credentials` operator CLI (PRD 711).
 *
 * Thin wrapper over the Worker `/admin/credentials` HTTP API only. It never
 * touches a D1 binding, database ID/API token, or SQL, and it never reuses the
 * OAuth DCR `/register` route. The admin bearer is read exclusively from the
 * protected environment (`GROUNDLANE_ADMIN_TOKEN`) or `--token-file`; there is
 * intentionally no `--token` argv flag so the secret never appears in process
 * listings, shell history, logs, or display argv.
 *
 * Run: `tsx scripts/groundlane-credentials.mts <create|list|rotate|revoke> [options]`
 */

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_CREDENTIALS_ENDPOINT = "http://127.0.0.1:8787";
export const DEFAULT_OVERLAP_SECONDS = 3600;
export const MIN_OVERLAP_SECONDS = 0;
export const MAX_OVERLAP_SECONDS = 86400;
export const MAX_LIST_LIMIT = 100;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_TOKEN_FILE_BYTES = 4096;
export const MAX_TOKEN_VALUE_LENGTH = 1024;
export const MAX_CURSOR_LENGTH = 256;
export const MAX_LABEL_LENGTH = 64;
export const MAX_SCOPES = 16;
export const MAX_SCOPE_LENGTH = 64;
export const MAX_RESPONSE_CHARS = 262144;
export const CREDENTIALS_REQUEST_TIMEOUT_MS = 15000;

export const EXIT_SUCCESS = 0;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_SERVER = 4;

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SCOPE_PATTERN = /^[A-Za-z0-9:_-]+$/u;

export type CredentialsOperation = "create" | "list" | "rotate" | "revoke";

export interface CredentialsCreateOptions {
  readonly label?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: number;
  readonly id?: string;
}

export interface CredentialsListOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CredentialsRotateOptions {
  readonly id: string;
  readonly overlapSeconds: number;
  readonly idempotencyKey?: string;
  readonly newId?: string;
}

export interface CredentialsRevokeOptions {
  readonly id: string;
}

export interface ParsedCredentialsArgs {
  readonly operation: CredentialsOperation;
  readonly endpoint: string;
  readonly tokenFile?: string;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly create?: CredentialsCreateOptions;
  readonly list?: CredentialsListOptions;
  readonly rotate?: CredentialsRotateOptions;
  readonly revoke?: CredentialsRevokeOptions;
}

export interface CredentialsHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

export class CredentialsCliError extends Error {
  readonly exitCode: 2 | 3 | 4;
  constructor(exitCode: 2 | 3 | 4, message: string) {
    super(message);
    this.name = "CredentialsCliError";
    this.exitCode = exitCode;
  }
}

export class CredentialsUsageError extends CredentialsCliError {
  constructor(message: string) {
    super(EXIT_USAGE, message);
    this.name = "CredentialsUsageError";
  }
}

export class CredentialsAuthError extends CredentialsCliError {
  constructor(message: string) {
    super(EXIT_AUTH, message);
    this.name = "CredentialsAuthError";
  }
}

function usagePrefix(): string {
  return "Usage: tsx scripts/groundlane-credentials.mts [--endpoint <url>] [--token-file <path>] [--dry-run] <create|list|rotate|revoke> [options]";
}

export function parseOverlapSecondsCli(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CredentialsUsageError("overlapSeconds must be an integer 0..86400");
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < MIN_OVERLAP_SECONDS || value > MAX_OVERLAP_SECONDS) {
    throw new CredentialsUsageError("overlapSeconds must be an integer 0..86400");
  }
  return value;
}

export function parseListLimitCli(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CredentialsUsageError(`limit must be an integer 1..${MAX_LIST_LIMIT}`);
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new CredentialsUsageError(`limit must be an integer 1..${MAX_LIST_LIMIT}`);
  }
  return value;
}

export function parseIdempotencyKeyCli(raw: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new CredentialsUsageError(
      `invalid idempotency key: use 1..${MAX_IDEMPOTENCY_KEY_LENGTH} of [A-Za-z0-9_-]`,
    );
  }
  return raw;
}

function parseCredentialIdCli(raw: string, flag: string): string {
  if (!CREDENTIAL_ID_PATTERN.test(raw)) {
    throw new CredentialsUsageError(
      `${flag} must match [A-Za-z0-9_-]{8,64} (got an invalid credential id)`,
    );
  }
  return raw;
}

function parseLabelCli(raw: string): string {
  if (raw.length > MAX_LABEL_LENGTH) {
    throw new CredentialsUsageError(`--label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return raw;
}

function parseScopesCli(raw: string): readonly string[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.length > MAX_SCOPES) {
    throw new CredentialsUsageError(`--scopes must list 1..${MAX_SCOPES} scopes`);
  }
  for (const entry of entries) {
    if (entry.length > MAX_SCOPE_LENGTH || !SCOPE_PATTERN.test(entry)) {
      throw new CredentialsUsageError(`invalid scope entry: ${entry}`);
    }
  }
  return entries;
}

function parseExpiresAtCli(raw: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed.length === 0 || !Number.isInteger(value) || value <= 0) {
    throw new CredentialsUsageError("--expires-at must be a future integer epoch-ms");
  }
  return value;
}

function parseCursorCli(raw: string): string {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    throw new CredentialsUsageError(`--cursor must be 1..${MAX_CURSOR_LENGTH} characters`);
  }
  return raw;
}

export function resolveCredentialsEndpoint(raw: string | undefined): string {
  const candidate = (raw ?? DEFAULT_CREDENTIALS_ENDPOINT).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CredentialsUsageError("endpoint must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CredentialsUsageError("endpoint must be an http(s) URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new CredentialsUsageError("endpoint must not contain credentials (userinfo)");
  }
  if (url.host.length === 0) {
    throw new CredentialsUsageError("endpoint must be an http(s) URL");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

export function generateIdempotencyKey(): string {
  return `rot_${randomUUID()}`;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CredentialsUsageError(`${flag} requires a value`);
  }
  return value;
}

export function parseCredentialsArgs(argv: readonly string[]): ParsedCredentialsArgs {
  if (argv.length === 0) {
    throw new CredentialsUsageError(`${usagePrefix()}\nMissing subcommand: expected create|list|rotate|revoke`);
  }
  let endpoint = DEFAULT_CREDENTIALS_ENDPOINT;
  let tokenFile: string | undefined;
  let dryRun = false;
  let help = false;
  let operation: CredentialsOperation | undefined;
  let rest: string[] = [];

  // First pass: globals may precede the subcommand; the first non-flag token
  // is the operation.
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (operation === undefined && !token.startsWith("-")) {
      if (token === "create" || token === "list" || token === "rotate" || token === "revoke") {
        operation = token;
        rest = [...argv.slice(index + 1)];
        break;
      }
      throw new CredentialsUsageError(
        `${usagePrefix()}\nUnknown subcommand: ${token}. Expected create|list|rotate|revoke`,
      );
    }
    if (token === "--") continue;
    if (token === "--endpoint") {
      endpoint = resolveCredentialsEndpoint(takeValue(argv, index, "--endpoint"));
      index += 1;
      continue;
    }
    if (token === "--token-file") {
      tokenFile = takeValue(argv, index, "--token-file");
      index += 1;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    throw new CredentialsUsageError(`${usagePrefix()}\nUnknown argument: ${token}`);
  }

  if (operation === undefined) {
    if (help) {
      // Bare `--help`: main() prints help before requiring a subcommand.
      throw new CredentialsUsageError(`${usagePrefix()}\nMissing subcommand: expected create|list|rotate|revoke`);
    }
    throw new CredentialsUsageError(`${usagePrefix()}\nMissing subcommand: expected create|list|rotate|revoke`);
  }

  const base = {
    operation,
    endpoint,
    ...(tokenFile === undefined ? {} : { tokenFile }),
  };

  if (operation === "create") {
    let label: string | undefined;
    let scopes: readonly string[] | undefined;
    let expiresAt: number | undefined;
    let id: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--label") {
        label = parseLabelCli(takeValue(rest, index, "--label"));
        index += 1;
      } else if (token === "--scopes") {
        scopes = parseScopesCli(takeValue(rest, index, "--scopes"));
        index += 1;
      } else if (token === "--expires-at") {
        expiresAt = parseExpiresAtCli(takeValue(rest, index, "--expires-at"));
        index += 1;
      } else if (token === "--id") {
        id = parseCredentialIdCli(takeValue(rest, index, "--id"), "--id");
        index += 1;
      } else if (token === "--endpoint") {
        endpoint = resolveCredentialsEndpoint(takeValue(rest, index, "--endpoint"));
        index += 1;
      } else if (token === "--token-file") {
        tokenFile = takeValue(rest, index, "--token-file");
        index += 1;
      } else if (token === "--dry-run") {
        dryRun = true;
      } else if (token === "--help" || token === "-h") {
        help = true;
      } else if (token === "--") {
        continue;
      } else {
        throw new CredentialsUsageError(`${usagePrefix()}\nUnknown argument: ${token ?? ""}`);
      }
    }
    return {
      ...base,
      endpoint,
      dryRun,
      ...(tokenFile === undefined ? {} : { tokenFile }),
      help,
      create: {
        ...(label === undefined ? {} : { label }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(id === undefined ? {} : { id }),
      },
    };
  }

  if (operation === "list") {
    let limit: number | undefined;
    let cursor: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--limit") {
        limit = parseListLimitCli(takeValue(rest, index, "--limit"));
        index += 1;
      } else if (token === "--cursor") {
        cursor = parseCursorCli(takeValue(rest, index, "--cursor"));
        index += 1;
      } else if (token === "--endpoint") {
        endpoint = resolveCredentialsEndpoint(takeValue(rest, index, "--endpoint"));
        index += 1;
      } else if (token === "--token-file") {
        tokenFile = takeValue(rest, index, "--token-file");
        index += 1;
      } else if (token === "--dry-run") {
        dryRun = true;
      } else if (token === "--help" || token === "-h") {
        help = true;
      } else if (token === "--") {
        continue;
      } else {
        throw new CredentialsUsageError(`${usagePrefix()}\nUnknown argument: ${token ?? ""}`);
      }
    }
    return {
      ...base,
      endpoint,
      dryRun,
      ...(tokenFile === undefined ? {} : { tokenFile }),
      help,
      list: {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    };
  }

  if (operation === "rotate") {
    let id: string | undefined;
    let overlapSeconds = DEFAULT_OVERLAP_SECONDS;
    let idempotencyKey: string | undefined;
    let newId: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--id") {
        id = parseCredentialIdCli(takeValue(rest, index, "--id"), "--id");
        index += 1;
      } else if (token === "--overlap-seconds") {
        overlapSeconds = parseOverlapSecondsCli(takeValue(rest, index, "--overlap-seconds"));
        index += 1;
      } else if (token === "--idempotency-key") {
        idempotencyKey = parseIdempotencyKeyCli(takeValue(rest, index, "--idempotency-key"));
        index += 1;
      } else if (token === "--new-id") {
        newId = parseCredentialIdCli(takeValue(rest, index, "--new-id"), "--new-id");
        index += 1;
      } else if (token === "--endpoint") {
        endpoint = resolveCredentialsEndpoint(takeValue(rest, index, "--endpoint"));
        index += 1;
      } else if (token === "--token-file") {
        tokenFile = takeValue(rest, index, "--token-file");
        index += 1;
      } else if (token === "--dry-run") {
        dryRun = true;
      } else if (token === "--help" || token === "-h") {
        help = true;
      } else if (token === "--") {
        continue;
      } else {
        throw new CredentialsUsageError(`${usagePrefix()}\nUnknown argument: ${token ?? ""}`);
      }
    }
    if (id === undefined && !help) {
      throw new CredentialsUsageError("rotate requires --id <credential-id>");
    }
    return {
      ...base,
      endpoint,
      dryRun,
      ...(tokenFile === undefined ? {} : { tokenFile }),
      help,
      rotate: {
        id: id ?? "",
        overlapSeconds,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(newId === undefined ? {} : { newId }),
      },
    };
  }

  // revoke
  let id: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--id") {
      id = parseCredentialIdCli(takeValue(rest, index, "--id"), "--id");
      index += 1;
    } else if (token === "--endpoint") {
      endpoint = resolveCredentialsEndpoint(takeValue(rest, index, "--endpoint"));
      index += 1;
    } else if (token === "--token-file") {
      tokenFile = takeValue(rest, index, "--token-file");
      index += 1;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--help" || token === "-h") {
      help = true;
    } else if (token === "--") {
      continue;
    } else {
      throw new CredentialsUsageError(`${usagePrefix()}\nUnknown argument: ${token ?? ""}`);
    }
  }
  if (id === undefined && !help) {
    throw new CredentialsUsageError("revoke requires --id <credential-id>");
  }
  return {
    ...base,
    endpoint,
    dryRun,
    ...(tokenFile === undefined ? {} : { tokenFile }),
    help,
    revoke: { id: id ?? "" },
  };
}

/**
 * Build the Worker HTTP request for a parsed command. Pure: no I/O, no D1,
 * no SQL. Rotation always carries a bounded idempotency key: the caller's
 * `--idempotency-key` is reused verbatim when present, otherwise a fresh key
 * is minted for this single attempt. Callers must reuse the *same* built
 * request (same key) when retrying after a lost response; never rebuild with
 * a new key, or a second successor lineage will be created.
 */
export function buildCredentialsHttpRequest(
  parsed: ParsedCredentialsArgs,
  overrides: { readonly idempotencyKey?: string } = {},
): CredentialsHttpRequest {
  if (parsed.operation === "create") {
    const options = parsed.create ?? {};
    const body: Record<string, unknown> = {};
    if (options.label !== undefined) body["label"] = options.label;
    if (options.scopes !== undefined) body["scopes"] = [...options.scopes];
    if (options.expiresAt !== undefined) body["expiresAt"] = options.expiresAt;
    if (options.id !== undefined) body["id"] = options.id;
    return { method: "POST", path: "/admin/credentials", body };
  }
  if (parsed.operation === "list") {
    const options = parsed.list ?? {};
    const query: Record<string, string> = {};
    if (options.limit !== undefined) query["limit"] = String(options.limit);
    if (options.cursor !== undefined) query["cursor"] = options.cursor;
    return {
      method: "GET",
      path: "/admin/credentials",
      ...(Object.keys(query).length === 0 ? {} : { query }),
    };
  }
  if (parsed.operation === "rotate") {
    const options = parsed.rotate ?? { id: "", overlapSeconds: DEFAULT_OVERLAP_SECONDS };
    const key = options.idempotencyKey ?? overrides.idempotencyKey ?? generateIdempotencyKey();
    const body: Record<string, unknown> = {
      id: options.id,
      overlapSeconds: options.overlapSeconds,
      idempotencyKey: key,
    };
    if (options.newId !== undefined) body["newId"] = options.newId;
    return { method: "POST", path: "/admin/credentials/rotate", body };
  }
  const options = parsed.revoke ?? { id: "" };
  return { method: "POST", path: "/admin/credentials/revoke", body: { id: options.id } };
}

/**
 * Display argv for logging. Mirrors the Worker's `buildCredentialsCliArgs`
 * shape and never contains secrets: this CLI has no `--token` flag, and the
 * admin bearer (env/file only) is never inserted here.
 */
export function buildCredentialsDisplayArgs(parsed: ParsedCredentialsArgs): string[] {
  const args = ["groundlane", "credentials", parsed.operation];
  const push = (flag: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    args.push(flag, String(value));
  };
  if (parsed.operation === "create") {
    push("--label", parsed.create?.label);
    push("--expires-at", parsed.create?.expiresAt);
    const scopes = parsed.create?.scopes;
    if (scopes !== undefined) push("--scopes", scopes.join(","));
    push("--id", parsed.create?.id);
  } else if (parsed.operation === "rotate") {
    push("--id", parsed.rotate?.id);
    push("--overlap-seconds", parsed.rotate?.overlapSeconds);
    push("--idempotency-key", parsed.rotate?.idempotencyKey);
    push("--new-id", parsed.rotate?.newId);
  } else if (parsed.operation === "revoke") {
    push("--id", parsed.revoke?.id);
  } else {
    push("--limit", parsed.list?.limit);
    push("--cursor", parsed.list?.cursor);
  }
  return args;
}

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("token") ||
    lower.includes("verifier") ||
    lower.includes("secret") ||
    lower.includes("authorization") ||
    lower.includes("refresh")
  );
}

/**
 * Deep redaction for CLI/API display objects. Mirrors the Worker's
 * `redactCredentialDisplay` key set (token/verifier/secret/authorization/
 * refresh, case-insensitive) and additionally descends into nested objects
 * and arrays so list payloads cannot leak through a nested item.
 */
export function redactCredentialsForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialsForDisplay(entry));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isRedactedKey(key)) continue;
      out[key] = redactCredentialsForDisplay(entry);
    }
    return out;
  }
  return value;
}

export function sanitizeCredentialsError(status: number | undefined): {
  readonly exitCode: 2 | 3 | 4;
  readonly message: string;
} {
  if (status === undefined) {
    return {
      exitCode: EXIT_SERVER,
      message: "Network failure: unable to reach the admin API endpoint",
    };
  }
  if (status === 400 || status === 422) {
    return {
      exitCode: EXIT_USAGE,
      message: "Invalid request: check flags and bounds (overlap 0..86400, limit 1..100)",
    };
  }
  if (status === 401) {
    return {
      exitCode: EXIT_AUTH,
      message: "Admin authentication failed: check GROUNDLANE_ADMIN_TOKEN or --token-file",
    };
  }
  if (status === 403) {
    return {
      exitCode: EXIT_AUTH,
      message: "Admin authorization failed: this credential cannot manage credentials",
    };
  }
  if (status === 404) {
    return { exitCode: EXIT_SERVER, message: "Credential not found" };
  }
  if (status === 409) {
    return {
      exitCode: EXIT_SERVER,
      message:
        "Credential conflict: already rotated, or an idempotency replay. Reuse --idempotency-key or inspect list output",
    };
  }
  if (status === 503) {
    return {
      exitCode: EXIT_SERVER,
      message: "Admin API is unavailable: managed tokens are not configured or storage failed",
    };
  }
  if (status >= 500) {
    return { exitCode: EXIT_SERVER, message: "Admin API server error" };
  }
  return { exitCode: EXIT_SERVER, message: "Admin API request failed" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Format a successful API payload for stdout. create/rotate responses carry
 * the raw token exactly once (allowlisted fields only); list/revoke payloads
 * are deep-redacted so a server-side shape change can never leak a secret.
 */
export function formatCredentialsSuccess(
  operation: CredentialsOperation,
  payload: unknown,
): { readonly stdout: string; readonly stderr: string } {
  if (operation === "create" || operation === "rotate") {
    const record = asRecord(payload);
    const token = record === null ? undefined : asString(record["token"]);
    const id = record === null ? undefined : asString(record["id"]);
    if (token !== undefined && id !== undefined) {
      const out: Record<string, unknown> = {
        id,
        token,
        secretAvailable: true,
      };
      if (record !== null) {
        if (typeof record["expiresAt"] === "number") out["expiresAt"] = record["expiresAt"];
        if (Array.isArray(record["scopes"])) out["scopes"] = record["scopes"];
      }
      return {
        stdout: JSON.stringify(out, null, 2),
        stderr:
          "Raw token is shown only once. Save it now; it will not be displayed again and cannot be recovered.",
      };
    }
    const redacted = redactCredentialsForDisplay(payload);
    const note =
      operation === "rotate"
        ? "Idempotent replay: the secret was not re-issued (secretAvailable=false). Reuse --idempotency-key for retries; revoke the unknown record or rotate the active successor explicitly if needed."
        : "";
    return { stdout: JSON.stringify(redacted, null, 2), stderr: note };
  }
  return { stdout: JSON.stringify(redactCredentialsForDisplay(payload), null, 2), stderr: "" };
}

export function buildCredentialsHelp(subcommand?: CredentialsOperation): string {
  const lines = [
    "groundlane credentials — operator CLI for managed credentials (PRD 711).",
    "",
    "Transport: HTTPS/fetch to the Worker /admin/credentials API only",
    `  (default endpoint ${DEFAULT_CREDENTIALS_ENDPOINT}; override with --endpoint).`,
    "This CLI holds no D1 binding, no database ID/API token, and executes no SQL.",
    "It never calls the OAuth DCR /register route.",
    "",
    "Usage:",
    `  ${usagePrefix()}`,
    "  tsx scripts/groundlane-credentials.mts create [--label <text>] [--scopes <a,b>] [--expires-at <epoch-ms>] [--id <id>]",
    `  tsx scripts/groundlane-credentials.mts list [--limit <1..${MAX_LIST_LIMIT}>] [--cursor <cursor>]`,
    `  tsx scripts/groundlane-credentials.mts rotate --id <id> [--overlap-seconds <0..86400>] [--idempotency-key <key>] [--new-id <id>]`,
    "  tsx scripts/groundlane-credentials.mts revoke --id <id>",
    "",
    "Admin token sources (never argv, never logged, never echoed):",
    "  GROUNDLANE_ADMIN_TOKEN environment variable, or",
    "  --token-file <path> (bounded single-line file; wins over the environment).",
    "  There is no --token flag by design.",
    "",
    "Preview without network or secrets:",
    "  --dry-run prints the display argv, HTTP method, request URL, and",
    "  redacted request body as JSON, then exits 0 without reading the admin",
    "  token or contacting the endpoint. A printed rotate idempotency key is",
    "  illustrative: reuse the SAME key for a real retry, never mint another.",
    "",
    "Rotation safety:",
    `  --overlap-seconds defaults to ${DEFAULT_OVERLAP_SECONDS} and accepts only integers 0..86400;`,
    "  out-of-range values are rejected locally before any request is sent.",
    "  Every rotate carries a bounded idempotency key ([A-Za-z0-9_-], 128 chars max).",
    "  Omit --idempotency-key to auto-generate one per invocation; pass the SAME",
    "  --idempotency-key when retrying after a lost response. Never retry by",
    "  rebuilding with a fresh key: a new key creates a second successor lineage.",
    "  A replay returns only the new credential ID with secretAvailable=false;",
    "  the raw token is never re-issued.",
    "",
    "Output:",
    "  create/rotate print the raw token exactly ONCE as JSON; save it now, it",
    "  cannot be recovered. list/revoke output never contains raw tokens or",
    "  verifiers (deep-redacted). list is paginated (--limit/--cursor) and",
    `  bounded to ${MAX_LIST_LIMIT} items per page; audit fields are metadata only.`,
    "",
    "Errors are sanitized (fixed messages, no response bodies, no secrets):",
    "  exit 0  success",
    "  exit 2  usage/validation error (bad flags, overlap/limit out of bounds,",
    "          bad endpoint or token file, server 400 invalid_request)",
    "  exit 3  authentication/authorization failure (missing admin token,",
    "          server 401 unauthorized, server 403 forbidden)",
    "  exit 4  server/network failure (server 404 not found, 409 conflict,",
    "          503 unavailable, 5xx, malformed responses, timeouts, disconnects)",
    "",
    "Examples:",
    "  GROUNDLANE_ADMIN_TOKEN=... tsx scripts/groundlane-credentials.mts list --limit 20",
    "  tsx scripts/groundlane-credentials.mts rotate --id cred_abc12345 --overlap-seconds 3600",
    "  tsx scripts/groundlane-credentials.mts rotate --id cred_abc12345 --idempotency-key my-retry-key_01",
    "  tsx scripts/groundlane-credentials.mts revoke --id cred_abc12345",
  ];
  if (subcommand !== undefined) {
    lines.push("", `Subcommand: ${subcommand}`);
  }
  return lines.join("\n");
}

export function readAdminToken(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tokenFile?: string | undefined;
}): string {
  if (options.tokenFile !== undefined) {
    let size = 0;
    try {
      const stats = statSync(options.tokenFile);
      if (!stats.isFile()) {
        throw new CredentialsUsageError("--token-file must be a regular file");
      }
      size = stats.size;
    } catch (error) {
      if (error instanceof CredentialsUsageError) throw error;
      throw new CredentialsUsageError("--token-file cannot be read");
    }
    if (size > MAX_TOKEN_FILE_BYTES) {
      throw new CredentialsUsageError(`--token-file exceeds ${MAX_TOKEN_FILE_BYTES} bytes`);
    }
    let contents: string;
    try {
      contents = readFileSync(options.tokenFile, "utf8");
    } catch {
      throw new CredentialsUsageError("--token-file cannot be read");
    }
    const token = contents.trim();
    if (token.length === 0) {
      throw new CredentialsUsageError("--token-file is empty");
    }
    if (token.includes("\n") || token.includes("\r")) {
      throw new CredentialsUsageError("--token-file must contain a single-line token");
    }
    if (token.length > MAX_TOKEN_VALUE_LENGTH) {
      throw new CredentialsUsageError("--token-file token is too long");
    }
    return token;
  }
  const raw = options.env?.["GROUNDLANE_ADMIN_TOKEN"] ?? process.env["GROUNDLANE_ADMIN_TOKEN"];
  const token = (raw ?? "").trim();
  if (token.length === 0) {
    throw new CredentialsAuthError(
      "Admin token is not configured: set GROUNDLANE_ADMIN_TOKEN or pass --token-file",
    );
  }
  return token;
}

export interface CredentialsCommandDeps {
  readonly adminToken: string;
  readonly fetchFn?: typeof fetch;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

/**
 * Execute one parsed command: single bounded fetch, sanitized errors, stable
 * exit codes. No retries (retry policy lives with the operator via explicit
 * --idempotency-key reuse), so a fresh key is never blindly re-sent.
 */
export async function executeCredentialsCommand(
  parsed: ParsedCredentialsArgs,
  deps: CredentialsCommandDeps,
): Promise<number> {
  const writeStdout = deps.stdout ?? ((text: string): void => {
    process.stdout.write(`${text}\n`);
  });
  const writeStderr = deps.stderr ?? ((text: string): void => {
    process.stderr.write(`${text}\n`);
  });

  if (parsed.help) {
    writeStdout(buildCredentialsHelp(parsed.operation));
    return EXIT_SUCCESS;
  }
  if (deps.adminToken.trim().length === 0) {
    writeStderr("Admin token is not configured: set GROUNDLANE_ADMIN_TOKEN or pass --token-file");
    return EXIT_AUTH;
  }

  let endpoint: string;
  try {
    endpoint = resolveCredentialsEndpoint(parsed.endpoint);
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : "Invalid endpoint");
    return EXIT_USAGE;
  }

  const request = buildCredentialsHttpRequest(parsed);
  let url = `${endpoint}${request.path}`;
  if (request.query !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query)) params.set(key, value);
    const serialized = params.toString();
    if (serialized.length > 0) url += `?${serialized}`;
  }

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: request.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${deps.adminToken}`,
        "content-type": "application/json",
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(CREDENTIALS_REQUEST_TIMEOUT_MS),
    });
  } catch {
    writeStderr(sanitizeCredentialsError(undefined).message);
    return EXIT_SERVER;
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    writeStderr(sanitizeCredentialsError(response.status).message);
    return sanitizeCredentialsError(response.status).exitCode;
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    writeStderr(sanitizeCredentialsError(response.status).message);
    return EXIT_SERVER;
  }

  if (!response.ok) {
    const mapped = sanitizeCredentialsError(response.status);
    writeStderr(mapped.message);
    return mapped.exitCode;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    writeStderr("Admin API returned a malformed response");
    return EXIT_SERVER;
  }

  const formatted = formatCredentialsSuccess(parsed.operation, payload);
  writeStdout(formatted.stdout);
  if (formatted.stderr.length > 0) writeStderr(formatted.stderr);
  return EXIT_SUCCESS;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write(`${usagePrefix()}\nMissing subcommand: expected create|list|rotate|revoke\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")) {
    process.stdout.write(`${buildCredentialsHelp()}\n`);
    process.exitCode = EXIT_SUCCESS;
    return;
  }

  let parsed: ParsedCredentialsArgs;
  try {
    parsed = parseCredentialsArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments";
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CredentialsCliError ? error.exitCode : EXIT_USAGE;
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${buildCredentialsHelp(parsed.operation)}\n`);
    process.exitCode = EXIT_SUCCESS;
    return;
  }

  if (parsed.dryRun) {
    // No token read, no network: preview only, with no secrets involved.
    const request = buildCredentialsHttpRequest(parsed);
    let url: string;
    try {
      const endpoint = resolveCredentialsEndpoint(parsed.endpoint);
      url = `${endpoint}${request.path}`;
      if (request.query !== undefined) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query)) params.set(key, value);
        const serialized = params.toString();
        if (serialized.length > 0) url += `?${serialized}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid endpoint";
      process.stderr.write(`${message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    const preview: Record<string, unknown> = {
      argv: buildCredentialsDisplayArgs(parsed),
      method: request.method,
      url,
    };
    if (request.body !== undefined) preview["body"] = request.body;
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.exitCode = EXIT_SUCCESS;
    return;
  }

  let adminToken: string;
  try {
    adminToken = readAdminToken({ env: process.env, tokenFile: parsed.tokenFile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin token is not available";
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CredentialsCliError ? error.exitCode : EXIT_AUTH;
    return;
  }

  try {
    process.exitCode = await executeCredentialsCommand(parsed, { adminToken });
  } catch {
    // Never echo bodies, tokens, or provider payloads on unexpected faults.
    process.stderr.write("Admin API request failed\n");
    process.exitCode = EXIT_SERVER;
  }
}

const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  await main();
}
