import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBenchmarkGate,
  validateBenchmarkEntry,
  validateBenchmarkReport,
  validateExtractionResult,
  validateExtractionSchema,
  type BenchmarkThresholds,
  type ExtractionBenchmarkEntry,
  type ExtractionBenchmarkReport,
  type ExtractionResult,
  type ExtractionSchema,
} from "../../src/core/schema-extraction-contract.js";
import { GroundlaneError } from "../../src/core/errors.js";
import {
  createFakeSchemaExtractionProvider,
  digestExtractionFields,
  parseBoundedSchema,
  runSchemaExtraction,
  summarizeRepeatability,
  validateProviderOutput,
  type SchemaExtractionProvider,
  type SchemaExtractionRuntimeOptions,
} from "../../src/core/schema-extraction-runtime.js";
import type { DnsLookup } from "../../src/core/url-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchema(overrides?: Partial<ExtractionSchema>): ExtractionSchema {
  return {
    fields: [
      { name: "title", type: "string", required: true },
      { name: "price", type: "number", required: true },
    ],
    maxDepth: 5,
    maxProperties: 50,
    rawSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        price: { type: "number" },
      },
    },
    ...overrides,
  };
}

function makeBenchmarkEntry(overrides?: Partial<ExtractionBenchmarkEntry>): ExtractionBenchmarkEntry {
  return {
    schemaId: "schema-product-v1",
    repeatabilityScore: 0.95,
    fieldAccuracy: 0.92,
    missingFieldRate: 0.03,
    invalidFieldRate: 0.02,
    latencyMs: 1200,
    outputSizeBytes: 4096,
    billedUnits: 10,
    ...overrides,
  };
}

function makeBenchmarkReport(
  overrides?: Partial<ExtractionBenchmarkReport>,
): ExtractionBenchmarkReport {
  return {
    reportId: "bench-001",
    generatedAt: "2026-01-15T00:00:00Z",
    entries: [makeBenchmarkEntry()],
    ...overrides,
  };
}

function makeThresholds(overrides?: Partial<BenchmarkThresholds>): BenchmarkThresholds {
  return {
    minRepeatability: 0.9,
    maxLatencyMs: 5000,
    minFieldAccuracy: 0.85,
    minEntries: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRD 654: Provider-backed schema extraction v1
// ---------------------------------------------------------------------------

void test("PRD 654: remote $ref rejected", () => {
  const schema = makeSchema({
    rawSchema: {
      type: "object",
      properties: {
        nested: { $ref: "https://evil.example.com/schema.json" },
      },
    },
  });
  assert.throws(
    () => validateExtractionSchema(schema),
    { message: /Remote \$ref is not allowed.*evil\.example\.com/ },
  );
});

void test("PRD 654: local $ref is allowed", () => {
  const schema = makeSchema({
    rawSchema: {
      type: "object",
      properties: {
        nested: { $ref: "#/definitions/Address" },
      },
      definitions: {
        Address: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  });
  assert.doesNotThrow(() => validateExtractionSchema(schema));
});

void test("PRD 654: deep nesting rejected", () => {
  // Build a schema with depth exceeding maxDepth
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 8; i++) {
    deep = { type: "object", properties: { child: deep } };
  }
  const schema = makeSchema({
    maxDepth: 3,
    rawSchema: deep,
  });
  assert.throws(
    () => validateExtractionSchema(schema),
    { message: /Schema depth .* exceeds maxDepth/ },
  );
});

void test("PRD 654: shallow nesting within maxDepth accepted", () => {
  const schema = makeSchema({
    maxDepth: 10,
    rawSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        address: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  });
  assert.doesNotThrow(() => validateExtractionSchema(schema));
});

void test("PRD 654: excessive properties rejected", () => {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) {
    properties[`field_${String(i)}`] = { type: "string" };
  }
  const schema = makeSchema({
    maxProperties: 50,
    rawSchema: { type: "object", properties },
  });
  assert.throws(
    () => validateExtractionSchema(schema),
    { message: /properties.*exceeding maxProperties/ },
  );
});

void test("PRD 654: valid bounded schema accepted", () => {
  const schema = makeSchema();
  assert.doesNotThrow(() => validateExtractionSchema(schema));
});

void test("PRD 654: schema with no fields rejected", () => {
  const schema = makeSchema({ fields: [] });
  assert.throws(
    () => validateExtractionSchema(schema),
    { message: /at least one field/ },
  );
});

void test("PRD 654: maxDepth must be positive", () => {
  const schema = makeSchema({ maxDepth: 0 });
  assert.throws(
    () => validateExtractionSchema(schema),
    { message: /maxDepth must be a positive/ },
  );
});

void test("PRD 654: maxProperties must be positive", () => {
  const schema = makeSchema({ maxProperties: 0 });
  assert.throws(
    () => validateExtractionSchema(schema),
    { message: /maxProperties must be a positive/ },
  );
});

void test("PRD 654: provenance fields required — provider", () => {
  const result: ExtractionResult = {
    fields: [{ name: "title", status: "present", value: "Test" }],
    provenance: { provider: "", model: "gpt-4", source: "https://example.com", billedUnits: 1 },
  };
  assert.throws(
    () => validateExtractionResult(result),
    { message: /provider/ },
  );
});

void test("PRD 654: provenance fields required — model", () => {
  const result: ExtractionResult = {
    fields: [{ name: "title", status: "present", value: "Test" }],
    provenance: { provider: "openai", model: "", source: "https://example.com", billedUnits: 1 },
  };
  assert.throws(
    () => validateExtractionResult(result),
    { message: /model/ },
  );
});

void test("PRD 654: provenance fields required — source", () => {
  const result: ExtractionResult = {
    fields: [{ name: "title", status: "present", value: "Test" }],
    provenance: { provider: "openai", model: "gpt-4", source: "", billedUnits: 1 },
  };
  assert.throws(
    () => validateExtractionResult(result),
    { message: /source/ },
  );
});

void test("PRD 654: valid extraction result with provenance accepted", () => {
  const result: ExtractionResult = {
    fields: [
      { name: "title", status: "present", value: "Widget" },
      { name: "price", status: "missing", reason: "Not found on page" },
    ],
    provenance: {
      provider: "firecrawl",
      model: "llm-extract-v1",
      source: "https://shop.example.com/widget",
      billedUnits: 5,
    },
  };
  assert.doesNotThrow(() => validateExtractionResult(result));
});

void test("PRD 654: missing and invalid field tracking in result", () => {
  const result: ExtractionResult = {
    fields: [
      { name: "title", status: "present", value: "Widget" },
      { name: "price", status: "missing", reason: "Field not found in page content" },
      { name: "sku", status: "invalid", value: "not-a-number", reason: "Expected number" },
    ],
    provenance: {
      provider: "firecrawl",
      model: "llm-extract-v1",
      source: "https://shop.example.com",
      billedUnits: 3,
    },
  };
  assert.doesNotThrow(() => validateExtractionResult(result));
  const missing = result.fields.filter((f) => f.status === "missing");
  const invalid = result.fields.filter((f) => f.status === "invalid");
  assert.equal(missing.length, 1);
  assert.equal(invalid.length, 1);
  assert.equal(missing[0]?.name, "price");
  assert.equal(invalid[0]?.name, "sku");
});

void test("PRD 654: billedUnits must be non-negative", () => {
  const result: ExtractionResult = {
    fields: [{ name: "title", status: "present", value: "Test" }],
    provenance: { provider: "openai", model: "gpt-4", source: "https://example.com", billedUnits: -1 },
  };
  assert.throws(
    () => validateExtractionResult(result),
    { message: /billedUnits must be non-negative/ },
  );
});

// ---------------------------------------------------------------------------
// PRD 655: Extraction benchmark gate
// ---------------------------------------------------------------------------

void test("PRD 655: benchmark without repeatability score rejected", () => {
  const entry = makeBenchmarkEntry({ repeatabilityScore: -0.1 });
  assert.throws(
    () => validateBenchmarkEntry(entry),
    { message: /repeatabilityScore must be between 0 and 1/ },
  );
});

void test("PRD 655: benchmark entry with repeatability above 1 rejected", () => {
  const entry = makeBenchmarkEntry({ repeatabilityScore: 1.1 });
  assert.throws(
    () => validateBenchmarkEntry(entry),
    { message: /repeatabilityScore must be between 0 and 1/ },
  );
});

void test("PRD 655: benchmark with all fields accepted", () => {
  const entry = makeBenchmarkEntry();
  assert.doesNotThrow(() => validateBenchmarkEntry(entry));
});

void test("PRD 655: benchmark report requires reportId", () => {
  const report = makeBenchmarkReport({ reportId: "" });
  assert.throws(
    () => validateBenchmarkReport(report),
    { message: /reportId/ },
  );
});

void test("PRD 655: benchmark report requires generatedAt", () => {
  const report = makeBenchmarkReport({ generatedAt: "" });
  assert.throws(
    () => validateBenchmarkReport(report),
    { message: /generatedAt/ },
  );
});

void test("PRD 655: benchmark report requires entries", () => {
  const report = makeBenchmarkReport({ entries: [] });
  assert.throws(
    () => validateBenchmarkReport(report),
    { message: /at least one entry/ },
  );
});

void test("PRD 655: gate blocks routing without benchmark", () => {
  const result = checkBenchmarkGate(null, makeThresholds(), false);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("No benchmark report"));
});

void test("PRD 655: gate allows with valid benchmark meeting thresholds", () => {
  const report = makeBenchmarkReport();
  const result = checkBenchmarkGate(report, makeThresholds(), true);
  assert.equal(result.allowed, true);
});

void test("PRD 655: provider availability flag alone insufficient", () => {
  const result = checkBenchmarkGate(null, makeThresholds(), true);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("Provider availability alone is not sufficient"));
});

void test("PRD 655: gate rejects when repeatability below threshold", () => {
  const report = makeBenchmarkReport({
    entries: [makeBenchmarkEntry({ repeatabilityScore: 0.5 })],
  });
  const result = checkBenchmarkGate(report, makeThresholds({ minRepeatability: 0.9 }), true);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("repeatability"));
});

void test("PRD 655: gate rejects when field accuracy below threshold", () => {
  const report = makeBenchmarkReport({
    entries: [makeBenchmarkEntry({ fieldAccuracy: 0.5 })],
  });
  const result = checkBenchmarkGate(report, makeThresholds({ minFieldAccuracy: 0.85 }), true);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("field accuracy"));
});

void test("PRD 655: gate rejects when latency exceeds threshold", () => {
  const report = makeBenchmarkReport({
    entries: [makeBenchmarkEntry({ latencyMs: 10_000 })],
  });
  const result = checkBenchmarkGate(report, makeThresholds({ maxLatencyMs: 5000 }), true);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("latency"));
});

void test("PRD 655: gate rejects when insufficient entries", () => {
  const report = makeBenchmarkReport({
    entries: [makeBenchmarkEntry()],
  });
  const result = checkBenchmarkGate(report, makeThresholds({ minEntries: 5 }), true);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("entries"));
});

void test("PRD 655: benchmark entry requires schemaId", () => {
  const entry = makeBenchmarkEntry({ schemaId: "" });
  assert.throws(
    () => validateBenchmarkEntry(entry),
    { message: /schemaId/ },
  );
});

void test("PRD 655: benchmark entry latencyMs must be non-negative", () => {
  const entry = makeBenchmarkEntry({ latencyMs: -1 });
  assert.throws(
    () => validateBenchmarkEntry(entry),
    { message: /latencyMs must be non-negative/ },
  );
});

void test("PRD 655: benchmark entry billedUnits must be non-negative", () => {
  const entry = makeBenchmarkEntry({ billedUnits: -1 });
  assert.throws(
    () => validateBenchmarkEntry(entry),
    { message: /billedUnits must be non-negative/ },
  );
});

void test("PRD 655: benchmark entry outputSizeBytes must be non-negative", () => {
  const entry = makeBenchmarkEntry({ outputSizeBytes: -1 });
  assert.throws(
    () => validateBenchmarkEntry(entry),
    { message: /outputSizeBytes must be non-negative/ },
  );
});

void test("PRD 655: benchmark entry fieldAccuracy bounds enforced", () => {
  assert.throws(
    () => validateBenchmarkEntry(makeBenchmarkEntry({ fieldAccuracy: -0.01 })),
    { message: /fieldAccuracy must be between 0 and 1/ },
  );
  assert.throws(
    () => validateBenchmarkEntry(makeBenchmarkEntry({ fieldAccuracy: 1.01 })),
    { message: /fieldAccuracy must be between 0 and 1/ },
  );
});

void test("PRD 655: gate with multiple entries — all must pass thresholds", () => {
  const report = makeBenchmarkReport({
    entries: [
      makeBenchmarkEntry({ schemaId: "s1", repeatabilityScore: 0.95 }),
      makeBenchmarkEntry({ schemaId: "s2", repeatabilityScore: 0.8 }),
    ],
  });
  const result = checkBenchmarkGate(
    report,
    makeThresholds({ minRepeatability: 0.9, minEntries: 2 }),
    true,
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("s2"));
});

// ---------------------------------------------------------------------------
// PRD 652: Provider-backed schema extraction runtime v1
// ---------------------------------------------------------------------------

const publicLookup: DnsLookup = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

const callerSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", required: true },
    price: { type: "number", required: true },
    inStock: { type: "boolean" },
    link: { type: "url" },
    published: { type: "date" },
    tags: { type: "array", items: { type: "string" } },
  },
};

function makeRuntime(
  provider?: SchemaExtractionProvider,
  report?: ExtractionBenchmarkReport | null,
): SchemaExtractionRuntimeOptions {
  return {
    providers: [
      provider ??
      createFakeSchemaExtractionProvider({
        data: {
          title: "Widget",
          price: 19.99,
          inStock: true,
          link: "https://shop.example.com/widget",
          published: "2026-01-15",
          tags: ["sale", "new"],
        },
        billedUnits: 5,
      }),
    ],
    benchmarkReport: report === undefined ? makeBenchmarkReport() : report,
    thresholds: makeThresholds(),
    lookup: publicLookup,
  };
}

function makeRequest(overrides?: Record<string, unknown>): {
  url: string;
  schema: unknown;
  providerBacked: true;
  provider?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  maxStringChars?: number;
} {
  return {
    url: "https://shop.example.com/widget",
    schema: callerSchema,
    providerBacked: true,
    ...overrides,
  };
}

function expectSyncCode(fn: () => unknown, code: string, pattern?: RegExp): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GroundlaneError, `expected GroundlaneError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return;
  }
  assert.fail(`expected GroundlaneError ${code}`);
}

async function expectAsyncCode(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GroundlaneError, `expected GroundlaneError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return;
  }
  assert.fail(`expected GroundlaneError ${code}`);
}

void test("PRD 652: parser accepts all six bounded field types", () => {
  const parsed = parseBoundedSchema(callerSchema);
  assert.equal(parsed.fields.length, 6);
  const byName = new Map(parsed.fields.map((field) => [field.name, field]));
  assert.equal(byName.get("title")?.type, "string");
  assert.equal(byName.get("price")?.type, "number");
  assert.equal(byName.get("inStock")?.type, "boolean");
  assert.equal(byName.get("link")?.type, "url");
  assert.equal(byName.get("published")?.type, "date");
  assert.equal(byName.get("tags")?.type, "array");
});

void test("PRD 652: parser rejects remote $ref", () => {
  expectSyncCode(
    () =>
      parseBoundedSchema({
        type: "object",
        properties: { nested: { $ref: "https://evil.example.com/schema.json" } },
      }),
    "INVALID_INPUT",
    /\$ref/i,
  );
});

void test("PRD 652: parser rejects local $ref in v1 (no ref resolution)", () => {
  expectSyncCode(
    () =>
      parseBoundedSchema({
        type: "object",
        properties: { nested: { $ref: "#/definitions/Address" } },
      }),
    "INVALID_INPUT",
    /\$ref/i,
  );
});

void test("PRD 652: parser rejects unknown field type", () => {
  expectSyncCode(
    () =>
      parseBoundedSchema({
        type: "object",
        properties: { nested: { type: "object" } },
      }),
    "INVALID_INPUT",
    /type/i,
  );
});

void test("PRD 652: parser rejects invalid field name", () => {
  expectSyncCode(
    () =>
      parseBoundedSchema({ type: "object", properties: { "9lives": { type: "string" } } }),
    "INVALID_INPUT",
    /name/i,
  );
});

void test("PRD 652: parser rejects empty properties", () => {
  expectSyncCode(
    () => parseBoundedSchema({ type: "object", properties: {} }),
    "INVALID_INPUT",
    /at least one field/i,
  );
});

void test("PRD 652: parser rejects array without items", () => {
  expectSyncCode(
    () =>
      parseBoundedSchema({ type: "object", properties: { tags: { type: "array" } } }),
    "INVALID_INPUT",
    /items/i,
  );
});

void test("PRD 652: parser rejects nested array items", () => {
  expectSyncCode(
    () =>
      parseBoundedSchema({
        type: "object",
        properties: { matrix: { type: "array", items: { type: "array", items: { type: "string" } } } },
      }),
    "INVALID_INPUT",
    /item/i,
  );
});

void test("PRD 652: parser enforces maxFields bound", () => {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) properties[`field_${String(i)}`] = { type: "string" };
  expectSyncCode(
    () => parseBoundedSchema({ type: "object", properties }, { maxFields: 5 }),
    "INVALID_INPUT",
    /field/i,
  );
});

void test("PRD 652: local validation reports present/missing/invalid", () => {
  const parsed = parseBoundedSchema(callerSchema);
  const { fields, truncated } = validateProviderOutput(
    {
      title: "Widget",
      price: "free",
      inStock: true,
      link: "https://shop.example.com/widget",
      published: "not-a-date-at-all-xyz",
      tags: ["sale", 42],
    },
    parsed,
  );
  assert.equal(truncated, false);
  const byName = new Map(fields.map((field) => [field.name, field]));
  assert.equal(byName.get("title")?.status, "present");
  assert.equal(byName.get("price")?.status, "invalid");
  assert.equal(byName.get("inStock")?.status, "present");
  assert.equal(byName.get("link")?.status, "present");
  assert.equal(byName.get("published")?.status, "invalid");
  assert.equal(byName.get("tags")?.status, "invalid");
});

void test("PRD 652: explicit opt-in required, no silent provider path", async () => {
  await expectAsyncCode(
    runSchemaExtraction(
      { ...makeRequest(), providerBacked: false as unknown as true },
      makeRuntime(),
    ),
    "INVALID_INPUT",
    /opt-in/i,
  );
});

void test("PRD 652: non-HTTP URL rejected before provider dispatch", async () => {
  const fake = createFakeSchemaExtractionProvider({ data: { title: "x" } });
  await expectAsyncCode(
    runSchemaExtraction(makeRequest({ url: "ftp://example.com/file" }), makeRuntime(fake)),
    "URL_BLOCKED",
  );
  assert.equal(fake.calls.length, 0);
});

void test("PRD 652: private-literal URL rejected before provider dispatch", async () => {
  const fake = createFakeSchemaExtractionProvider({ data: { title: "x" } });
  await expectAsyncCode(
    runSchemaExtraction(makeRequest({ url: "http://10.0.0.1/admin" }), makeRuntime(fake)),
    "URL_BLOCKED",
  );
  assert.equal(fake.calls.length, 0);
});

void test("PRD 652: full run returns fields plus provider/model/source/billing provenance", async () => {
  const outcome = await runSchemaExtraction(makeRequest(), makeRuntime());
  assert.equal(outcome.result.provenance.provider, "fake-extract");
  assert.equal(outcome.result.provenance.model, "fake-extract-v1");
  assert.equal(outcome.result.provenance.source, "https://shop.example.com/widget");
  assert.equal(outcome.result.provenance.billedUnits, 5);
  const byName = new Map(outcome.result.fields.map((field) => [field.name, field]));
  assert.equal(byName.get("title")?.status, "present");
  assert.equal(byName.get("title")?.value, "Widget");
  assert.ok(outcome.digest.length > 0);
  assert.ok(outcome.durationMs >= 0);
});

void test("PRD 652: repeatability — same input yields same digest", async () => {
  const options = makeRuntime();
  const first = await runSchemaExtraction(makeRequest(), options);
  const second = await runSchemaExtraction(makeRequest(), options);
  assert.equal(first.digest, second.digest);
  const summary = summarizeRepeatability([first.digest, second.digest]);
  assert.equal(summary.repeatabilityScore, 1);
});

void test("PRD 652: repeatability detects differing provider output", () => {
  const parsed = parseBoundedSchema(callerSchema);
  const a = validateProviderOutput({ title: "Widget", price: 1 }, parsed).fields;
  const b = validateProviderOutput({ title: "Gadget", price: 1 }, parsed).fields;
  assert.notEqual(digestExtractionFields(a), digestExtractionFields(b));
  const summary = summarizeRepeatability([
    digestExtractionFields(a),
    digestExtractionFields(a),
    digestExtractionFields(b),
  ]);
  assert.equal(summary.totalRuns, 3);
  assert.equal(summary.matchingRuns, 2);
});

void test("PRD 652: benchmark gate blocks production routing without report", async () => {
  const fake = createFakeSchemaExtractionProvider({ data: { title: "x" } });
  await expectAsyncCode(
    runSchemaExtraction(makeRequest(), makeRuntime(fake, null)),
    "PROVIDER_UNAVAILABLE",
    /benchmark/i,
  );
  assert.equal(fake.calls.length, 0);
});

void test("PRD 652: explicit unknown provider is not silently substituted", async () => {
  const fake = createFakeSchemaExtractionProvider({ data: { title: "x" } });
  await expectAsyncCode(
    runSchemaExtraction(makeRequest({ provider: "no-such-provider" }), makeRuntime(fake)),
    "PROVIDER_UNAVAILABLE",
  );
  assert.equal(fake.calls.length, 0);
});

void test("PRD 652: provider raw errors are sanitized", async () => {
  const fake = createFakeSchemaExtractionProvider({
    error: new Error("upstream 500 secret-key=abc123 session=zzz"),
  });
  await expectAsyncCode(
    runSchemaExtraction(makeRequest(), makeRuntime(fake)),
    "UPSTREAM_ERROR",
  );
  try {
    await runSchemaExtraction(makeRequest(), makeRuntime(fake));
    assert.fail("expected UPSTREAM_ERROR");
  } catch (error) {
    assert.ok(error instanceof GroundlaneError);
    assert.ok(!error.message.includes("abc123"), "raw provider payload must not leak");
  }
});

void test("PRD 652: overlong strings truncate with flag; oversized total hits output cap", async () => {
  const long = await runSchemaExtraction(
    makeRequest({ maxStringChars: 5 }),
    makeRuntime(
      createFakeSchemaExtractionProvider({ data: { title: "Widget Pro Max" }, billedUnits: 1 }),
    ),
  );
  const title = long.result.fields.find((field) => field.name === "title");
  assert.equal(title?.status, "present");
  assert.equal(title?.value, "Widge");
  assert.equal(long.truncated, true);

  await expectAsyncCode(
    runSchemaExtraction(
      makeRequest({ maxOutputChars: 50 }),
      makeRuntime(
        createFakeSchemaExtractionProvider({
          data: { title: "A very long widget title that blows the tiny budget" },
          billedUnits: 1,
        }),
      ),
    ),
    "OUTPUT_LIMIT",
  );
});

void test("PRD 652: cancellation propagates as CANCELLED", async () => {
  const controller = new AbortController();
  controller.abort();
  await expectAsyncCode(
    runSchemaExtraction(makeRequest(), makeRuntime(), controller.signal),
    "CANCELLED",
  );
});

void test("PRD 652: negative billedUnits from provider rejected", async () => {
  await expectAsyncCode(
    runSchemaExtraction(
      makeRequest(),
      makeRuntime(createFakeSchemaExtractionProvider({ data: { title: "x" }, billedUnits: -2 })),
    ),
    "UPSTREAM_ERROR",
    /bill/i,
  );
});
