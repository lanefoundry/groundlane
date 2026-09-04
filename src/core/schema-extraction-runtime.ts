// ---------------------------------------------------------------------------
// Provider-backed schema extraction runtime v1 (PRD 652)
//
// Explicit opt-in operation over a single known URL with a caller-provided
// bounded schema. Groundlane validates the provider output locally and
// reports missing/invalid fields with provider/model/source/billing
// provenance. Production routing requires a passing benchmark gate
// (provider availability alone is not sufficient).
//
// v1 boundaries:
// - Single URL only; no multi-page, agentic, or schema-less extraction.
// - Flat schemas only: string | number | boolean | url | date | array.
//   No nested objects, no nested arrays, no $ref (local refs must be
//   inlined by the caller; remote refs are never allowed).
// - No automatic fallback from the deterministic selector/pattern
//   extractor to this provider path; the caller must opt in per request.
// - No cross-provider fallback: one explicit provider per request, billed
//   units attributed to that provider.
// - Provider-returned URL *values* are validated syntactically only; they
//   must pass the full URL policy again before any fetch.
// - In-memory/fake provider adapter boundary; no live bindings required.
// ---------------------------------------------------------------------------

import {
  checkBenchmarkGate,
  validateExtractionResult,
  validateExtractionSchema,
  type BenchmarkThresholds,
  type ExtractionBenchmarkReport,
  type ExtractionFieldResult,
  type ExtractionResult,
  type ExtractionSchema,
  type ExtractionSchemaField,
} from "./schema-extraction-contract.js";
import { GroundlaneError, hint } from "./errors.js";
import { Deadline, truncateUnicode, withinDeadline } from "./limits.js";
import {
  parsePublicUrl,
  resolvePublicUrl,
  throwIfAborted,
  type DnsLookup,
  type ResolvedAddress,
} from "./url-policy.js";

// -- Field types ------------------------------------------------------------

export const SCHEMA_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "url",
  "date",
  "array",
] as const;

export type SchemaFieldType = (typeof SCHEMA_FIELD_TYPES)[number];

export type ScalarFieldType = Exclude<SchemaFieldType, "array">;

function isSchemaFieldType(value: string): value is SchemaFieldType {
  return (SCHEMA_FIELD_TYPES as readonly string[]).includes(value);
}

const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

export interface ParsedSchemaField extends ExtractionSchemaField {
  readonly type: SchemaFieldType;
  /** Array element type. Always a scalar in v1 (nested arrays rejected). */
  readonly items?: ScalarFieldType;
}

export interface ParsedExtractionSchema extends ExtractionSchema {
  readonly fields: readonly ParsedSchemaField[];
}

// -- Limits -----------------------------------------------------------------

export interface SchemaExtractionLimits {
  readonly maxFields: number;
  readonly maxDepth: number;
  readonly maxProperties: number;
  readonly maxArrayItems: number;
  readonly maxStringChars: number;
  readonly maxOutputChars: number;
  readonly maxWarnings: number;
  readonly maxWarningChars: number;
}

export const DEFAULT_SCHEMA_EXTRACTION_LIMITS: SchemaExtractionLimits = {
  maxFields: 50,
  maxDepth: 5,
  maxProperties: 100,
  maxArrayItems: 100,
  maxStringChars: 10_000,
  maxOutputChars: 100_000,
  maxWarnings: 10,
  maxWarningChars: 500,
};

export const DEFAULT_SCHEMA_EXTRACTION_TIMEOUT_MS = 30_000;

/** Absolute ceilings so deployment overrides stay bounded. */
const HARD_LIMIT_CEILINGS: SchemaExtractionLimits = {
  maxFields: 200,
  maxDepth: 20,
  maxProperties: 5_000,
  maxArrayItems: 10_000,
  maxStringChars: 200_000,
  maxOutputChars: 1_000_000,
  maxWarnings: 50,
  maxWarningChars: 2_000,
};

function invalidInput(message: string, code: string, text: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "schema-extract", message, false, undefined, hint(code, text));
}

export function resolveSchemaExtractionLimits(
  overrides?: Partial<SchemaExtractionLimits>,
): SchemaExtractionLimits {
  const resolved: SchemaExtractionLimits = { ...DEFAULT_SCHEMA_EXTRACTION_LIMITS, ...overrides };
  const entries = Object.entries(resolved) as Array<[keyof SchemaExtractionLimits, number]>;
  for (const [key, value] of entries) {
    const ceiling = HARD_LIMIT_CEILINGS[key];
    if (!Number.isInteger(value) || value <= 0 || value > ceiling) {
      throw invalidInput(
        `Schema extraction limit ${key} is outside the allowed range`,
        "schema_extract.invalid_limit",
        "Limits must be positive integers within deployment ceilings. Check the operator configuration.",
      );
    }
  }
  return resolved;
}

// -- Bounded schema parser --------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_SCHEMA_SCAN_NODES = 5_000;

/**
 * Reject every $ref key before parsing. Remote refs are never allowed;
 * local refs are not resolved in v1 — callers inline the referenced shape.
 */
function rejectRefKeys(raw: unknown): void {
  const stack: unknown[] = [raw];
  let seen = 0;
  while (stack.length > 0) {
    const current: unknown = stack.pop();
    seen += 1;
    if (seen > MAX_SCHEMA_SCAN_NODES) {
      throw invalidInput(
        "Extraction schema exceeds the scannable node bound",
        "schema_extract.schema_too_large",
        "Shrink the schema to at most 50 flat fields without $ref. Inline referenced shapes instead of nesting.",
      );
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (isRecord(current)) {
      for (const [key, value] of Object.entries(current)) {
        if (key === "$ref") {
          throw invalidInput(
            '"$ref" is not allowed in extraction schemas; inline the referenced shape',
            "schema_extract.ref_rejected",
            "Remote $ref is never fetched. Local $ref is not resolved in v1 — inline the referenced object shape as plain fields.",
          );
        }
        stack.push(value);
      }
    }
  }
}

/**
 * Parse a caller-provided JSON-schema-style object into a bounded,
 * contract-conformant schema. Accepts `{ type: "object", properties: {...} }`
 * with scalar field types and single-level typed arrays.
 */
export function parseBoundedSchema(
  rawSchema: unknown,
  limitOverrides?: Partial<SchemaExtractionLimits>,
): ParsedExtractionSchema {
  const limits = resolveSchemaExtractionLimits(limitOverrides);
  if (!isRecord(rawSchema)) {
    throw invalidInput(
      "Extraction schema must be an object",
      "schema_extract.schema_not_object",
      'Provide an object schema like { type: "object", properties: { title: { type: "string" } } }.',
    );
  }
  rejectRefKeys(rawSchema);
  if (rawSchema["type"] !== "object") {
    throw invalidInput(
      'Extraction schema must declare type "object"',
      "schema_extract.schema_root_type",
      'The top level must be { type: "object", properties: { ... } }. Only flat field extraction is supported in v1.',
    );
  }
  const properties = rawSchema["properties"];
  if (!isRecord(properties)) {
    throw invalidInput(
      "Extraction schema must define a properties object",
      "schema_extract.schema_no_properties",
      "Add a properties object with at least one named field, e.g. properties: { title: { type: \"string\" } }.",
    );
  }
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    throw invalidInput(
      "Extraction schema must define at least one field",
      "schema_extract.schema_no_fields",
      "Add at least one named field to properties.",
    );
  }
  if (entries.length > limits.maxFields) {
    throw invalidInput(
      `Extraction schema defines ${String(entries.length)} fields, exceeding maxFields ${String(limits.maxFields)}`,
      "schema_extract.too_many_fields",
      "Split the request into smaller extractions within maxFields.",
    );
  }
  const fields: ParsedSchemaField[] = [];
  for (const [name, definition] of entries) {
    if (!FIELD_NAME_RE.test(name)) {
      throw invalidInput(
        `Extraction field name "${name}" is invalid`,
        "schema_extract.invalid_field_name",
        "Field names must start with a letter, use only letters/digits/underscore, and stay under 64 characters.",
      );
    }
    if (!isRecord(definition)) {
      throw invalidInput(
        `Extraction field "${name}" must be an object`,
        "schema_extract.invalid_field_definition",
        "Each field must be an object like { type: \"string\" }. Supported types: string, number, boolean, url, date, array.",
      );
    }
    const type = definition["type"];
    if (typeof type !== "string" || !isSchemaFieldType(type)) {
      throw invalidInput(
        `Extraction field "${name}" has an unsupported type`,
        "schema_extract.unsupported_field_type",
        "Supported field types: string, number, boolean, url, date, array. Nested objects are not supported in v1.",
      );
    }
    let required = false;
    if (definition["required"] !== undefined) {
      if (typeof definition["required"] !== "boolean") {
        throw invalidInput(
          `Extraction field "${name}" has a non-boolean required flag`,
          "schema_extract.invalid_required_flag",
          "The required flag must be a boolean; omit it to default to optional.",
        );
      }
      required = definition["required"];
    }
    if (type === "array") {
      const items = definition["items"];
      if (!isRecord(items)) {
        throw invalidInput(
          `Extraction field "${name}" of type array must declare items`,
          "schema_extract.array_missing_items",
          'Array fields need an item type, e.g. { type: "array", items: { type: "string" } }.',
        );
      }
      const itemType = items["type"];
      if (typeof itemType !== "string" || !isSchemaFieldType(itemType) || itemType === "array") {
        throw invalidInput(
          `Extraction field "${name}" has an unsupported array item type`,
          "schema_extract.unsupported_item_type",
          "Array items must be a scalar: string, number, boolean, url, or date. Nested arrays are not supported in v1.",
        );
      }
      fields.push({ name, type, required, items: itemType });
    } else {
      fields.push({ name, type, required });
    }
  }
  const schema: ParsedExtractionSchema = {
    fields,
    maxDepth: limits.maxDepth,
    maxProperties: limits.maxProperties,
    rawSchema,
  };
  try {
    validateExtractionSchema(schema);
  } catch (error) {
    throw invalidInput(
      error instanceof Error ? error.message : "Extraction schema is invalid",
      "schema_extract.schema_rejected",
      "The schema violated a contract bound (depth, property count, or remote reference). Flatten and shrink it.",
    );
  }
  return schema;
}

// -- Deterministic local output validation ----------------------------------

type FieldCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string; readonly value?: unknown };

export interface ProviderOutputValidation {
  readonly fields: readonly ExtractionFieldResult[];
  readonly truncated: boolean;
}

/** Truncate without materializing giant char arrays for huge inputs. */
function truncateBoundedString(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  const window = value.slice(0, maxChars * 2 + 16);
  const result = truncateUnicode(window, maxChars);
  return { value: result.value, truncated: true };
}

const MAX_URL_VALUE_UNITS = 8_192;
const MAX_DATE_VALUE_UNITS = 120;

function checkScalar(
  type: ScalarFieldType,
  raw: unknown,
  limits: SchemaExtractionLimits,
): FieldCheck {
  switch (type) {
    case "string": {
      if (typeof raw !== "string") return { ok: false, reason: "Expected string" };
      return { ok: true, value: truncateBoundedString(raw, limits.maxStringChars).value };
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, reason: "Expected finite number" };
      }
      return { ok: true, value: raw };
    }
    case "boolean": {
      if (typeof raw !== "boolean") return { ok: false, reason: "Expected boolean" };
      return { ok: true, value: raw };
    }
    case "url": {
      if (typeof raw !== "string" || raw.length > MAX_URL_VALUE_UNITS) {
        return { ok: false, reason: "Expected public HTTP(S) URL" };
      }
      try {
        parsePublicUrl(raw);
      } catch {
        return {
          ok: false,
          reason: "Expected public HTTP(S) URL",
          value: truncateBoundedString(raw, limits.maxStringChars).value,
        };
      }
      return { ok: true, value: truncateBoundedString(raw, limits.maxStringChars).value };
    }
    case "date": {
      if (
        typeof raw !== "string" ||
        raw.length > MAX_DATE_VALUE_UNITS ||
        Number.isNaN(Date.parse(raw))
      ) {
        return {
          ok: false,
          reason: "Expected date string",
          ...(typeof raw === "string"
            ? { value: truncateBoundedString(raw, limits.maxStringChars).value }
            : {}),
        };
      }
      return { ok: true, value: truncateBoundedString(raw, limits.maxStringChars).value };
    }
  }
}

function checkFieldValue(
  field: ParsedSchemaField,
  raw: unknown,
  limits: SchemaExtractionLimits,
): FieldCheck {
  if (field.type !== "array") return checkScalar(field.type, raw, limits);
  if (!Array.isArray(raw)) return { ok: false, reason: "Expected array" };
  if (raw.length > limits.maxArrayItems) {
    return {
      ok: false,
      reason: `Array exceeds maxArrayItems of ${String(limits.maxArrayItems)}`,
    };
  }
  const itemType: ScalarFieldType = field.items ?? "string";
  const values: unknown[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item: unknown = raw[index];
    const checked = checkScalar(itemType, item, limits);
    if (!checked.ok) {
      return {
        ok: false,
        reason: `Expected array of ${itemType} (first invalid index ${String(index)})`,
      };
    }
    values.push(checked.value);
  }
  return { ok: true, value: values };
}

/**
 * Deterministically validate raw provider output against the parsed schema.
 * Pure function: same input always yields same output (repeatability).
 * Reasons are fixed strings; no provider payload leaks into errors here.
 */
export function validateProviderOutput(
  data: unknown,
  schema: ParsedExtractionSchema,
  limitOverrides?: Partial<SchemaExtractionLimits>,
): ProviderOutputValidation {
  const limits = resolveSchemaExtractionLimits(limitOverrides);
  if (!isRecord(data)) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "schema-extract",
      "Provider returned malformed extraction output",
      true,
      undefined,
      hint(
        "schema_extract.malformed_output",
        "The provider did not return a JSON object for the requested schema. Retry, or check provider_quota for upstream state.",
      ),
    );
  }
  if (Object.keys(data).length > limits.maxProperties + schema.fields.length) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "schema-extract",
      "Provider returned more fields than the configured bound",
      false,
      undefined,
      hint(
        "schema_extract.output_too_many_keys",
        "The provider output carries more top-level keys than the schema plus property bound allows. Retry with a smaller schema.",
      ),
    );
  }
  let truncated = false;
  const fields: ExtractionFieldResult[] = [];
  for (const field of schema.fields) {
    const raw: unknown = data[field.name];
    if (raw === undefined || raw === null) {
      fields.push({ name: field.name, status: "missing", reason: "Field not found in provider output" });
      continue;
    }
    const checked = checkFieldValue(field, raw, limits);
    if (!checked.ok) {
      fields.push({
        name: field.name,
        status: "invalid",
        reason: checked.reason,
        ...(checked.value === undefined ? {} : { value: checked.value }),
      });
      continue;
    }
    // Re-measure truncation for converted scalars (converters pre-truncate,
    // but the flag must reflect any shortening deterministically).
    if (typeof checked.value === "string" && typeof raw === "string" && checked.value !== raw) {
      truncated = true;
    }
    if (
      Array.isArray(checked.value) &&
      Array.isArray(raw) &&
      checked.value.some((item, index) => typeof item === "string" && item !== (raw[index] as unknown))
    ) {
      truncated = true;
    }
    fields.push({ name: field.name, status: "present", value: checked.value });
  }
  const serialized = JSON.stringify(fields);
  if (Array.from(serialized).length > limits.maxOutputChars) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "schema-extract",
      "Validated extraction output exceeds the configured limit",
      false,
      undefined,
      hint(
        "schema_extract.output_too_large",
        "Lower maxOutputChars pressure by requesting fewer fields, smaller arrays, or shorter string caps.",
      ),
    );
  }
  return { fields, truncated };
}

// -- Repeatability ----------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value) ?? "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key) ?? "null"}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return "null";
}

/** Canonical JSON for field results: sorted by field name, sorted keys. */
export function canonicalizeExtractionFields(fields: readonly ExtractionFieldResult[]): string {
  const sorted = [...fields].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return stableStringify(
    sorted.map((field) => ({
      name: field.name,
      reason: field.reason ?? null,
      status: field.status,
      value: field.value ?? null,
    })),
  );
}

/** FNV-1a 32-bit hex digest of the canonical form. Deterministic. */
export function digestExtractionFields(fields: readonly ExtractionFieldResult[]): string {
  const text = canonicalizeExtractionFields(fields);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface RepeatabilitySummary {
  readonly totalRuns: number;
  readonly matchingRuns: number;
  /** Fraction of runs whose digest equals the first run's digest. */
  readonly repeatabilityScore: number;
}

export function summarizeRepeatability(digests: readonly string[]): RepeatabilitySummary {
  if (digests.length === 0) return { totalRuns: 0, matchingRuns: 0, repeatabilityScore: 0 };
  const first: string | undefined = digests[0];
  const matchingRuns = digests.filter((digest) => digest === first).length;
  return { totalRuns: digests.length, matchingRuns, repeatabilityScore: matchingRuns / digests.length };
}

// -- Provider adapter boundary (in-memory/fake, no live bindings) -----------

export interface SchemaExtractionProviderInput {
  /** Validated public URL href (single known URL). */
  readonly url: string;
  readonly schema: ParsedExtractionSchema;
}

export interface SchemaExtractionProviderOutput {
  readonly data: Record<string, unknown>;
  readonly billedUnits: number;
  readonly warnings: readonly string[];
}

export interface SchemaExtractionProvider {
  readonly id: string;
  readonly model: string;
  supports?(input: SchemaExtractionProviderInput): boolean;
  extract(
    input: SchemaExtractionProviderInput,
    signal: AbortSignal,
  ): Promise<SchemaExtractionProviderOutput>;
}

function cancelledError(signal: AbortSignal): GroundlaneError {
  if (signal.reason instanceof GroundlaneError) return signal.reason;
  return new GroundlaneError(
    "CANCELLED",
    "schema-extract",
    "Schema extraction was cancelled",
    false,
    undefined,
    hint("schema_extract.cancelled", "The request was cancelled before the provider returned output."),
  );
}

export interface FakeSchemaExtractionOptions {
  readonly id?: string;
  readonly model?: string;
  readonly data?: Record<string, unknown> | ((input: SchemaExtractionProviderInput) => Record<string, unknown>);
  readonly billedUnits?: number;
  readonly warnings?: readonly string[];
  readonly latencyMs?: number;
  /** When set, extract() throws this instead of returning (simulates upstream failure). */
  readonly error?: unknown;
}

/**
 * Deterministic in-memory provider for tests and local development.
 * Honors AbortSignal; records every call for assertions.
 */
export function createFakeSchemaExtractionProvider(
  options: FakeSchemaExtractionOptions = {},
): SchemaExtractionProvider & { readonly calls: SchemaExtractionProviderInput[] } {
  const calls: SchemaExtractionProviderInput[] = [];
  return {
    id: options.id ?? "fake-extract",
    model: options.model ?? "fake-extract-v1",
    calls,
    async extract(
      input: SchemaExtractionProviderInput,
      signal: AbortSignal,
    ): Promise<SchemaExtractionProviderOutput> {
      calls.push(input);
      throwIfAborted(signal, "schema-extract", "Schema extraction was cancelled");
      const latencyMs = options.latencyMs ?? 0;
      if (latencyMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, latencyMs);
          timer.unref?.();
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(cancelledError(signal));
          };
          if (signal.aborted) {
            clearTimeout(timer);
            reject(cancelledError(signal));
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
        throwIfAborted(signal, "schema-extract", "Schema extraction was cancelled");
      }
      if (options.error !== undefined) {
        if (options.error instanceof Error) throw options.error;
        throw new GroundlaneError(
          "UPSTREAM_ERROR",
          "schema-extract",
          "Fake schema extraction provider failed",
          true,
        );
      }
      const data =
        typeof options.data === "function" ? options.data(input) : (options.data ?? {});
      return {
        data,
        billedUnits: options.billedUnits ?? 1,
        warnings: options.warnings ?? [],
      };
    },
  };
}

// -- Request orchestration ---------------------------------------------------

export interface SchemaExtractionRequest {
  /** Single known URL. Arrays or multiple URLs are rejected by contract. */
  readonly url: string;
  /** Caller-provided bounded schema object. */
  readonly schema: unknown;
  /** Explicit opt-in. Must be literally true; anything else is rejected. */
  readonly providerBacked: true;
  /** Explicit provider id. Unknown ids fail; never silently substituted. */
  readonly provider?: string;
  readonly timeoutMs?: number;
  /** Per-request caps; must not exceed deployment limits. */
  readonly maxOutputChars?: number;
  readonly maxStringChars?: number;
}

export interface SchemaExtractionRuntimeOptions {
  readonly providers: readonly SchemaExtractionProvider[];
  readonly defaultProvider?: string;
  readonly benchmarkReport: ExtractionBenchmarkReport | null;
  readonly thresholds: BenchmarkThresholds;
  readonly limits?: Partial<SchemaExtractionLimits>;
  /** Injectable DNS lookup (tests); defaults to Node DNS via url-policy. */
  readonly lookup?: DnsLookup;
  readonly cache?: Map<string, readonly ResolvedAddress[]>;
}

export interface SchemaExtractionOutcome {
  readonly result: ExtractionResult;
  readonly warnings: readonly string[];
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly digest: string;
}

function truncateId(value: string, maxUnits = 128): string {
  return value.length > maxUnits ? `${value.slice(0, maxUnits)}…` : value;
}

function resolveProvider(
  requested: string | undefined,
  options: SchemaExtractionRuntimeOptions,
): SchemaExtractionProvider {
  if (requested !== undefined) {
    const found = options.providers.find((provider) => provider.id === requested);
    if (found === undefined) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "schema-extract",
        `Unknown schema extraction provider "${truncateId(requested)}"`,
        false,
        undefined,
        hint(
          "schema_extract.unknown_provider",
          "Explicit providers are never silently substituted. Check provider_capabilities for available extraction providers.",
        ),
      );
    }
    return found;
  }
  if (options.defaultProvider !== undefined) {
    const found = options.providers.find((provider) => provider.id === options.defaultProvider);
    if (found === undefined) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "schema-extract",
        "Default schema extraction provider is not configured",
        false,
        undefined,
        hint(
          "schema_extract.no_default_provider",
          "The configured default provider has no registered extraction adapter. Specify an explicit provider instead.",
        ),
      );
    }
    return found;
  }
  const first = options.providers[0];
  if (first === undefined) {
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "schema-extract",
      "No schema extraction provider is configured",
      true,
      undefined,
      hint(
        "schema_extract.no_provider",
        "Register at least one extraction provider adapter before calling this operation.",
      ),
    );
  }
  return first;
}

function sanitizeWarnings(
  warnings: unknown,
  limits: SchemaExtractionLimits,
): readonly string[] {
  if (!Array.isArray(warnings)) return [];
  const cleaned: string[] = [];
  for (const warning of warnings) {
    if (cleaned.length >= limits.maxWarnings) break;
    if (typeof warning !== "string" || warning.length === 0) continue;
    cleaned.push(truncateBoundedString(warning, limits.maxWarningChars).value);
  }
  return cleaned;
}

/**
 * Run one provider-backed extraction: opt-in check, benchmark gate, URL
 * policy, bounded schema parse, single-deadline provider call, deterministic
 * local validation, provenance assembly. No fallback to or from the
 * deterministic extractor.
 */
export async function runSchemaExtraction(
  request: SchemaExtractionRequest,
  options: SchemaExtractionRuntimeOptions,
  parentSignal?: AbortSignal,
): Promise<SchemaExtractionOutcome> {
  throwIfAborted(parentSignal, "schema-extract", "Schema extraction was cancelled");
  if (request.providerBacked !== true) {
    throw invalidInput(
      "Provider-backed schema extraction requires explicit opt-in (providerBacked: true)",
      "schema_extract.opt_in_required",
      "Set providerBacked: true to use provider inference, or use web_extract for deterministic selector/pattern extraction. Groundlane never upgrades silently.",
    );
  }
  const baseLimits = resolveSchemaExtractionLimits(options.limits);
  const timeoutMs = request.timeoutMs ?? DEFAULT_SCHEMA_EXTRACTION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw invalidInput(
      "Schema extraction timeoutMs is outside the allowed range",
      "schema_extract.invalid_timeout",
      "timeoutMs must be an integer between 1000 and 120000 milliseconds.",
    );
  }
  let limits = baseLimits;
  if (request.maxOutputChars !== undefined || request.maxStringChars !== undefined) {
    const maxOutputChars = request.maxOutputChars ?? baseLimits.maxOutputChars;
    const maxStringChars = request.maxStringChars ?? baseLimits.maxStringChars;
    if (
      !Number.isInteger(maxOutputChars) ||
      !Number.isInteger(maxStringChars) ||
      maxOutputChars <= 0 ||
      maxStringChars <= 0 ||
      maxOutputChars > baseLimits.maxOutputChars ||
      maxStringChars > baseLimits.maxStringChars
    ) {
      throw invalidInput(
        "Per-request output caps exceed deployment limits",
        "schema_extract.cap_exceeds_deployment",
        "Per-request maxOutputChars/maxStringChars must be positive integers within the deployment limits.",
      );
    }
    limits = { ...baseLimits, maxOutputChars, maxStringChars };
  }

  const gate = checkBenchmarkGate(
    options.benchmarkReport,
    options.thresholds,
    options.providers.length > 0,
  );
  if (!gate.allowed) {
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "schema-extract",
      `Schema extraction is not routed to production: ${gate.reason}`,
      true,
      undefined,
      hint(
        "schema_extract.benchmark_gate",
        "Provider availability alone does not enable this operation. A benchmark report passing repeatability, accuracy, and latency thresholds is required first.",
      ),
    );
  }

  const destination = await resolvePublicUrl(request.url, {
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(parentSignal === undefined ? {} : { signal: parentSignal }),
  });
  const source = destination.url.href;
  const schema = parseBoundedSchema(request.schema, limits);
  const provider = resolveProvider(request.provider, options);
  const providerInput: SchemaExtractionProviderInput = { url: source, schema };

  let supported = true;
  try {
    supported = provider.supports?.(providerInput) ?? true;
  } catch {
    supported = false;
  }
  if (!supported) {
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "schema-extract",
      `Schema extraction provider "${truncateId(provider.id)}" does not support this request`,
      false,
      undefined,
      hint(
        "schema_extract.provider_unsupported",
        "The selected provider cannot serve this schema or URL. Pick another explicit provider; Groundlane does not substitute silently.",
      ),
    );
  }
  if (!provider.id || !provider.model) {
    throw invalidInput(
      "Schema extraction provider adapter is misconfigured",
      "schema_extract.provider_misconfigured",
      "Provider adapters must declare non-empty id and model for provenance.",
    );
  }

  const deadline = new Deadline(timeoutMs);
  const started = Date.now();
  const output = await withinDeadline(
    async (signal) => {
      try {
        return await provider.extract(providerInput, signal);
      } catch (error) {
        throwIfAborted(signal, "schema-extract", "Schema extraction was cancelled");
        if (error instanceof GroundlaneError) throw error;
        // Sanitized: never propagate raw upstream payloads or messages.
        throw new GroundlaneError(
          "UPSTREAM_ERROR",
          "schema-extract",
          `Schema extraction provider "${truncateId(provider.id)}" failed`,
          true,
          undefined,
          hint(
            "schema_extract.provider_failed",
            "The provider call failed without returning usable output. Retry, or check provider_quota for billing and rate-limit state. Raw upstream errors are withheld.",
          ),
        );
      }
    },
    deadline,
    parentSignal,
    "schema-extract",
  );

  if (typeof output !== "object" || output === null) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "schema-extract",
      "Provider returned malformed extraction output",
      true,
      undefined,
      hint(
        "schema_extract.malformed_output",
        "The provider did not return a usable extraction envelope. Retry, or check provider_quota for upstream state.",
      ),
    );
  }
  const data: unknown = output.data;
  const billedUnits: unknown = output.billedUnits;
  if (typeof billedUnits !== "number" || !Number.isFinite(billedUnits) || billedUnits < 0) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "schema-extract",
      "Provider returned invalid billing metadata",
      true,
      undefined,
      hint(
        "schema_extract.invalid_billing",
        "The provider envelope carried missing or negative billedUnits. Retry, or check provider_quota for upstream state.",
      ),
    );
  }
  const warnings = sanitizeWarnings(output.warnings, limits);
  const validation = validateProviderOutput(data, schema, limits);
  const result: ExtractionResult = {
    fields: [...validation.fields],
    provenance: { provider: provider.id, model: provider.model, source, billedUnits },
  };
  try {
    validateExtractionResult(result);
  } catch (error) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "schema-extract",
      "Failed to assemble a valid extraction result",
      true,
      undefined,
      hint(
        "schema_extract.result_rejected",
        error instanceof Error ? error.message : "Result assembly failed.",
      ),
    );
  }
  return {
    result,
    warnings,
    durationMs: Math.max(0, Date.now() - started),
    truncated: validation.truncated,
    digest: digestExtractionFields(validation.fields),
  };
}
