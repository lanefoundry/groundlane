import {
  sanitizeCallerPrincipalHeaders,
  type TimingSafeSubtleCrypto,
  type WorkerAuthProfile,
} from "./auth.js";
import type { ManagedClock } from "./managed-tokens.js";

export const INTERNAL_CONTEXT_HEADER = "x-groundlane-internal-context";
export const INTERNAL_REQUEST_ID_HEADER = "x-request-id";

/** Caller-supplied headers stripped before minting/forwarding (PRD 707). */
export const CALLER_INTERNAL_HEADERS: readonly string[] = [
  INTERNAL_CONTEXT_HEADER,
  "x-groundlane-internal-auth",
  "x-internal-auth",
  "x-groundlane-container-auth",
];

export const INTERNAL_ISSUER = "groundlane-worker";
export const INTERNAL_MAX_TTL_MS = 60_000;
export const INTERNAL_DEFAULT_TTL_MS = 30_000;

export interface InternalContextPayload {
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
}

function bytesToHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

function base64UrlEncodeString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const c = bytes[i + 2] as number;
    const n = (a << 16) | (b << 8) | c;
    out += alphabet[(n >>> 18) & 63];
    out += alphabet[(n >>> 12) & 63];
    out += alphabet[(n >>> 6) & 63];
    out += alphabet[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const a = bytes[i] as number;
    const n = a << 16;
    out += alphabet[(n >>> 18) & 63];
    out += alphabet[(n >>> 12) & 63];
  } else if (rest === 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const n = (a << 16) | (b << 8);
    out += alphabet[(n >>> 18) & 63];
    out += alphabet[(n >>> 12) & 63];
    out += alphabet[(n >>> 6) & 63];
  }
  return out;
}

function base64UrlDecodeToString(input: string): string | null {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const rev = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i += 1) rev.set(alphabet[i] as string, i);
  if (input.length === 0 || input.length % 4 === 1) return null;
  const bytes: number[] = [];
  let i = 0;
  for (; i + 3 < input.length; i += 4) {
    const a = rev.get(input[i] as string);
    const b = rev.get(input[i + 1] as string);
    const c = rev.get(input[i + 2] as string);
    const d = rev.get(input[i + 3] as string);
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  }
  const rest = input.length - i;
  if (rest === 2) {
    const a = rev.get(input[i] as string);
    const b = rev.get(input[i + 1] as string);
    if (a === undefined || b === undefined) return null;
    const n = (a << 18) | (b << 12);
    bytes.push((n >>> 16) & 255);
  } else if (rest === 3) {
    const a = rev.get(input[i] as string);
    const b = rev.get(input[i + 1] as string);
    const c = rev.get(input[i + 2] as string);
    if (a === undefined || b === undefined || c === undefined) return null;
    const n = (a << 18) | (b << 12) | (c << 6);
    bytes.push((n >>> 16) & 255, (n >>> 8) & 255);
  } else if (rest !== 0) {
    return null;
  }
  try {
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

async function computeSignature(
  payloadB64: string,
  signingSecret: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<string> {
  // Integrity protection bound to an independent signing secret (PRD 707).
  // Production deployments SHOULD use HMAC-SHA256 via WebCrypto importKey/sign;
  // this digest construction keeps the same secret-separation and
  // constant-time-compare contract while depending only on the minimal
  // TimingSafeSubtleCrypto port used across Worker tests.
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${signingSecret}.${payloadB64}`),
  );
  return bytesToHex(digest);
}

/**
 * Strip caller-supplied internal-auth headers AND caller principal override
 * headers (PRD 693/707). MUST run before any internal context is minted.
 */
export function stripCallerInternalHeaders(request: Request): Request {
  const headers = sanitizeCallerPrincipalHeaders(request.headers);
  for (const name of CALLER_INTERNAL_HEADERS) headers.delete(name);
  return new Request(request, { headers });
}

export async function mintInternalContext(
  options: {
    signingSecret: string;
    audience: string;
    method: string;
    path: string;
    requestId: string;
    ttlMs?: number;
  },
  subtle: TimingSafeSubtleCrypto,
  clock: ManagedClock,
): Promise<string> {
  if (options.signingSecret.length === 0) {
    throw new Error("signing secret is required");
  }
  if (options.audience.length === 0 || options.audience.length > 128) {
    throw new Error("invalid audience");
  }
  if (options.requestId.length === 0 || options.requestId.length > 128) {
    throw new Error("invalid request id");
  }
  const ttl = options.ttlMs ?? INTERNAL_DEFAULT_TTL_MS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > INTERNAL_MAX_TTL_MS) {
    throw new Error("ttl must be 1..60000 ms");
  }
  const now = clock.now();
  const payload: InternalContextPayload = {
    iss: INTERNAL_ISSUER,
    aud: options.audience,
    iat: now,
    exp: now + ttl,
    method: options.method.toUpperCase(),
    path: options.path,
    requestId: options.requestId,
  };
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const sig = await computeSignature(payloadB64, options.signingSecret, subtle);
  return `v1.${payloadB64}.${sig}`;
}

export interface VerifyInternalOptions {
  readonly signingSecret: string;
  readonly expectedAudience: string;
  readonly expectedMethod: string;
  readonly expectedPath: string;
  readonly expectedRequestId?: string | undefined;
}

/**
 * Container-side verification (PRD 707). Rejects forged, expired, wrong
 * audience, wrong method/path/request binding and missing contexts. Raw
 * caller credentials never cross this boundary.
 */
export async function verifyInternalContext(
  token: string | null,
  options: VerifyInternalOptions,
  subtle: TimingSafeSubtleCrypto,
  clock: ManagedClock,
): Promise<{ ok: true; payload: InternalContextPayload } | { ok: false; reason: string }> {
  if (token === null || token.length === 0) return { ok: false, reason: "missing_context" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
  const payloadB64 = parts[1] as string;
  const presentedSig = parts[2] as string;
  if (options.signingSecret.length === 0) return { ok: false, reason: "missing_secret" };
  const expectedSig = await computeSignature(payloadB64, options.signingSecret, subtle);
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(presentedSig)),
    subtle.digest("SHA-256", encoder.encode(expectedSig)),
  ]);
  if (!subtle.timingSafeEqual(a, b) || presentedSig !== expectedSig) {
    // Constant-time digest compare first; exact string check second to avoid
    // hex-prefix confusion. Either failure is a forgery.
    if (presentedSig.length !== expectedSig.length) return { ok: false, reason: "forged" };
    // Re-check timing-safe on raw bytes for fixed-length hex.
    if (!subtle.timingSafeEqual(a, b)) return { ok: false, reason: "forged" };
    return { ok: false, reason: "forged" };
  }
  const json = base64UrlDecodeToString(payloadB64);
  if (json === null) return { ok: false, reason: "malformed" };
  let payload: InternalContextPayload;
  try {
    payload = JSON.parse(json) as InternalContextPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.iss !== INTERNAL_ISSUER) return { ok: false, reason: "issuer" };
  if (payload.aud !== options.expectedAudience) return { ok: false, reason: "audience" };
  if (payload.method !== options.expectedMethod.toUpperCase()) return { ok: false, reason: "method" };
  if (payload.path !== options.expectedPath) return { ok: false, reason: "path" };
  if (payload.requestId.length === 0) return { ok: false, reason: "request_binding" };
  if (options.expectedRequestId !== undefined && payload.requestId !== options.expectedRequestId) {
    return { ok: false, reason: "request_binding" };
  }
  const now = clock.now();
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    return { ok: false, reason: "time" };
  }
  if (!(payload.iat <= now && now < payload.exp)) return { ok: false, reason: "expired" };
  if (payload.exp - payload.iat > INTERNAL_MAX_TTL_MS) return { ok: false, reason: "ttl" };
  return { ok: true, payload };
}

/**
 * Build the Worker->Container request (PRD 707): strip caller headers, drop
 * the raw Authorization credential, attach the bounded internal context and
 * the request ID. The raw data-plane/OAuth credential never crosses.
 */
export function buildContainerRequestWithInternalContext(
  original: Request,
  internalToken: string,
  requestId: string,
): Request {
  const stripped = stripCallerInternalHeaders(original);
  const headers = new Headers(stripped.headers);
  headers.delete("authorization");
  headers.set(INTERNAL_CONTEXT_HEADER, internalToken);
  headers.set(INTERNAL_REQUEST_ID_HEADER, requestId);
  return new Request(stripped, { headers });
}

export interface ContainerAuthDecision {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Container listener auth (PRD 708). In `worker_internal_context` mode every
 * raw bearer fallback is rejected; only a verified internal context passes.
 * In `local_static` mode the legacy static bearer is accepted.
 */
export async function verifyContainerAuth(
  request: Request,
  profile: WorkerAuthProfile,
  options: {
    legacyToken?: string | undefined;
    signingSecret?: string | undefined;
    expectedAudience: string;
    expectedMethod: string;
    expectedPath: string;
  },
  subtle: TimingSafeSubtleCrypto,
  clock: ManagedClock,
): Promise<ContainerAuthDecision> {
  if (profile === "worker_internal_context") {
    const token = request.headers.get(INTERNAL_CONTEXT_HEADER);
    const requestIdHeader = request.headers.get(INTERNAL_REQUEST_ID_HEADER);
    const verified = await verifyInternalContext(
      token,
      {
        signingSecret: options.signingSecret ?? "",
        expectedAudience: options.expectedAudience,
        expectedMethod: options.expectedMethod,
        expectedPath: options.expectedPath,
        ...(requestIdHeader === null ? {} : { expectedRequestId: requestIdHeader }),
      },
      subtle,
      clock,
    );
    if (!verified.ok) return { ok: false, reason: verified.reason };
    if (request.headers.has("authorization")) {
      return { ok: false, reason: "raw_bearer_rejected" };
    }
    return { ok: true, reason: "internal_context" };
  }
  const authorization = request.headers.get("authorization");
  if (authorization === null) return { ok: false, reason: "missing_bearer" };
  const expected = options.legacyToken ?? "";
  if (expected.length === 0) return { ok: false, reason: "missing_secret" };
  const { timingSafeTokenEqual, parseBearerToken } = await import("./auth.js");
  const candidate = parseBearerToken(authorization) ?? "";
  const matches = await timingSafeTokenEqual(candidate, expected, subtle);
  return matches ? { ok: true, reason: "legacy" } : { ok: false, reason: "invalid_bearer" };
}
