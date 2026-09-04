// ---------------------------------------------------------------------------
// Schema extraction validation contracts (PRD 654, 655)
// ---------------------------------------------------------------------------

// -- PRD 654: Provider-backed schema extraction v1 --------------------------

export interface ExtractionSchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface ExtractionSchema {
  readonly fields: readonly ExtractionSchemaField[];
  readonly maxDepth: number;
  readonly maxProperties: number;
  /** The raw schema object provided by the caller. */
  readonly rawSchema: Record<string, unknown>;
}

export interface ExtractionFieldResult {
  readonly name: string;
  readonly status: "present" | "missing" | "invalid";
  readonly value?: unknown;
  readonly reason?: string;
}

export interface ExtractionProvenance {
  readonly provider: string;
  readonly model: string;
  readonly source: string;
  readonly billedUnits: number;
}

export interface ExtractionResult {
  readonly fields: readonly ExtractionFieldResult[];
  readonly provenance: ExtractionProvenance;
}

const REMOTE_REF_RE = /^https?:\/\//u;

function containsRemoteRef(obj: unknown, depth: number, maxDepth: number): string | null {
  if (depth > maxDepth) {
    return null;
  }
  if (typeof obj !== "object" || obj === null) {
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = containsRemoteRef(item, depth + 1, maxDepth);
      if (found !== null) return found;
    }
    return null;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "$ref" && typeof value === "string" && REMOTE_REF_RE.test(value)) {
      return value;
    }
    const found = containsRemoteRef(value, depth + 1, maxDepth);
    if (found !== null) return found;
  }
  return null;
}

function measureDepth(obj: unknown, current: number): number {
  if (typeof obj !== "object" || obj === null) {
    return current;
  }
  if (Array.isArray(obj)) {
    let max = current;
    for (const item of obj) {
      max = Math.max(max, measureDepth(item, current + 1));
    }
    return max;
  }
  let max = current;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    max = Math.max(max, measureDepth(value, current + 1));
  }
  return max;
}

function countProperties(obj: unknown): number {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return 0;
  }
  const record = obj as Record<string, unknown>;
  let count = Object.keys(record).length;
  for (const value of Object.values(record)) {
    count += countProperties(value);
  }
  return count;
}

export function validateExtractionSchema(schema: ExtractionSchema): void {
  if (schema.fields.length === 0) {
    throw new Error("Extraction schema must define at least one field");
  }

  if (schema.maxDepth <= 0) {
    throw new Error("maxDepth must be a positive integer");
  }

  if (schema.maxProperties <= 0) {
    throw new Error("maxProperties must be a positive integer");
  }

  // Reject remote $ref
  const remoteRef = containsRemoteRef(schema.rawSchema, 0, 100);
  if (remoteRef !== null) {
    throw new Error(
      `Remote $ref is not allowed in extraction schemas: "${remoteRef}"`,
    );
  }

  // Reject unbounded nesting
  const depth = measureDepth(schema.rawSchema, 0);
  if (depth > schema.maxDepth) {
    throw new Error(
      `Schema depth ${String(depth)} exceeds maxDepth ${String(schema.maxDepth)}`,
    );
  }

  // Reject excessive properties
  const propCount = countProperties(schema.rawSchema);
  if (propCount > schema.maxProperties) {
    throw new Error(
      `Schema has ${String(propCount)} properties, exceeding maxProperties ${String(schema.maxProperties)}`,
    );
  }
}

export function validateExtractionResult(result: ExtractionResult): void {
  if (!result.provenance.provider) {
    throw new Error("Extraction provenance must include provider");
  }
  if (!result.provenance.model) {
    throw new Error("Extraction provenance must include model");
  }
  if (!result.provenance.source) {
    throw new Error("Extraction provenance must include source");
  }
  if (result.provenance.billedUnits < 0) {
    throw new Error("Extraction provenance billedUnits must be non-negative");
  }
}

// -- PRD 655: Extraction benchmark gate -------------------------------------

export interface ExtractionBenchmarkEntry {
  readonly schemaId: string;
  readonly repeatabilityScore: number;
  readonly fieldAccuracy: number;
  readonly missingFieldRate: number;
  readonly invalidFieldRate: number;
  readonly latencyMs: number;
  readonly outputSizeBytes: number;
  readonly billedUnits: number;
}

export interface ExtractionBenchmarkReport {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly entries: readonly ExtractionBenchmarkEntry[];
}

export interface BenchmarkThresholds {
  readonly minRepeatability: number;
  readonly maxLatencyMs: number;
  readonly minFieldAccuracy: number;
  readonly minEntries: number;
}

export function validateBenchmarkEntry(entry: ExtractionBenchmarkEntry): void {
  if (!entry.schemaId) {
    throw new Error("Benchmark entry must include schemaId");
  }
  if (entry.repeatabilityScore < 0 || entry.repeatabilityScore > 1) {
    throw new Error("repeatabilityScore must be between 0 and 1");
  }
  if (entry.fieldAccuracy < 0 || entry.fieldAccuracy > 1) {
    throw new Error("fieldAccuracy must be between 0 and 1");
  }
  if (entry.latencyMs < 0) {
    throw new Error("latencyMs must be non-negative");
  }
  if (entry.outputSizeBytes < 0) {
    throw new Error("outputSizeBytes must be non-negative");
  }
  if (entry.billedUnits < 0) {
    throw new Error("billedUnits must be non-negative");
  }
}

export function validateBenchmarkReport(report: ExtractionBenchmarkReport): void {
  if (!report.reportId) {
    throw new Error("Benchmark report must include reportId");
  }
  if (!report.generatedAt) {
    throw new Error("Benchmark report must include generatedAt");
  }
  if (report.entries.length === 0) {
    throw new Error("Benchmark report must contain at least one entry");
  }
  for (const entry of report.entries) {
    validateBenchmarkEntry(entry);
  }
}

export interface BenchmarkGateResult {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Gate that checks whether a benchmark report exists and meets thresholds
 * before allowing production routing.  Provider availability alone is not
 * proof of demand.
 */
export function checkBenchmarkGate(
  report: ExtractionBenchmarkReport | null,
  thresholds: BenchmarkThresholds,
  providerAvailable: boolean,
): BenchmarkGateResult {
  // Provider availability alone is insufficient
  if (report === null) {
    if (providerAvailable) {
      return {
        allowed: false,
        reason: "Provider availability alone is not sufficient; benchmark report required",
      };
    }
    return {
      allowed: false,
      reason: "No benchmark report available",
    };
  }

  validateBenchmarkReport(report);

  if (report.entries.length < thresholds.minEntries) {
    return {
      allowed: false,
      reason: `Benchmark has ${String(report.entries.length)} entries, ` +
        `minimum ${String(thresholds.minEntries)} required`,
    };
  }

  for (const entry of report.entries) {
    if (entry.repeatabilityScore < thresholds.minRepeatability) {
      return {
        allowed: false,
        reason: `Entry "${entry.schemaId}" repeatability ${String(entry.repeatabilityScore)} ` +
          `below threshold ${String(thresholds.minRepeatability)}`,
      };
    }
    if (entry.fieldAccuracy < thresholds.minFieldAccuracy) {
      return {
        allowed: false,
        reason: `Entry "${entry.schemaId}" field accuracy ${String(entry.fieldAccuracy)} ` +
          `below threshold ${String(thresholds.minFieldAccuracy)}`,
      };
    }
    if (entry.latencyMs > thresholds.maxLatencyMs) {
      return {
        allowed: false,
        reason: `Entry "${entry.schemaId}" latency ${String(entry.latencyMs)}ms ` +
          `exceeds threshold ${String(thresholds.maxLatencyMs)}ms`,
      };
    }
  }

  return {
    allowed: true,
    reason: "Benchmark report meets all thresholds",
  };
}
