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
