const DEFAULT_MAX_SCHEMA_BYTES = 128 * 1024;
const DEFAULT_MAX_SCHEMA_NODES = 4_096;
const DEFAULT_MAX_SCHEMA_DEPTH = 32;
const DEFAULT_MAX_COMPOSITION_BRANCHES = 256;
const DEFAULT_MAX_ADMISSION_MS = 250;

export interface McpSchemaPolicyLimits {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxCompositionBranches?: number;
  readonly maxAdmissionMs?: number;
  readonly now?: () => number;
}

export interface McpSchemaPolicyResult {
  readonly bytes: number;
  readonly nodes: number;
  readonly maxDepth: number;
  readonly compositionBranches: number;
}

export class McpSchemaPolicyError extends Error {
  constructor(readonly reason: string) {
    super(`MCP schema rejected: ${reason}`);
    this.name = "McpSchemaPolicyError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function enforceMcpSchemaPolicy(
  schema: unknown,
  limits: McpSchemaPolicyLimits = {},
): McpSchemaPolicyResult {
  const maxBytes = positiveInteger(limits.maxBytes ?? DEFAULT_MAX_SCHEMA_BYTES, "maxBytes");
  const maxNodes = positiveInteger(limits.maxNodes ?? DEFAULT_MAX_SCHEMA_NODES, "maxNodes");
  const maxDepth = positiveInteger(limits.maxDepth ?? DEFAULT_MAX_SCHEMA_DEPTH, "maxDepth");
  const maxCompositionBranches = positiveInteger(
    limits.maxCompositionBranches ?? DEFAULT_MAX_COMPOSITION_BRANCHES,
    "maxCompositionBranches",
  );
  const maxAdmissionMs = positiveInteger(
    limits.maxAdmissionMs ?? DEFAULT_MAX_ADMISSION_MS,
    "maxAdmissionMs",
  );
  const now = limits.now ?? performance.now.bind(performance);
  const startedAt = now();
  let encoded: string;
  try {
    encoded = JSON.stringify(schema);
  } catch {
    throw new McpSchemaPolicyError("schema must be acyclic JSON");
  }
  if (encoded === undefined) throw new McpSchemaPolicyError("schema must be JSON");
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > maxBytes) throw new McpSchemaPolicyError(`serialized size exceeds ${String(maxBytes)} bytes`);

  let nodes = 0;
  let observedDepth = 0;
  let compositionBranches = 0;
  const visit = (value: unknown, depth: number): void => {
    if (now() - startedAt > maxAdmissionMs) {
      throw new McpSchemaPolicyError(`admission exceeds ${String(maxAdmissionMs)} ms`);
    }
    nodes += 1;
    if (nodes > maxNodes) throw new McpSchemaPolicyError(`node count exceeds ${String(maxNodes)}`);
    observedDepth = Math.max(observedDepth, depth);
    if (depth > maxDepth) throw new McpSchemaPolicyError(`depth exceeds ${String(maxDepth)}`);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "$ref" || key === "$dynamicRef") && typeof child === "string") {
        if (!child.startsWith("#")) {
          throw new McpSchemaPolicyError("external references are disabled");
        }
      }
      if (
        (key === "allOf" || key === "anyOf" || key === "oneOf") &&
        Array.isArray(child)
      ) {
        compositionBranches += child.length;
        if (compositionBranches > maxCompositionBranches) {
          throw new McpSchemaPolicyError(
            `composition branches exceed ${String(maxCompositionBranches)}`,
          );
        }
      }
      visit(child, depth + 1);
    }
  };
  visit(schema, 0);
  return { bytes, nodes, maxDepth: observedDepth, compositionBranches };
}

interface StandardSchemaJsonView {
  readonly "~standard"?: {
    readonly jsonSchema?: {
      input(): unknown;
      output(): unknown;
    };
  };
}

export function enforceStandardSchemaPolicy(
  schema: unknown,
  direction: "input" | "output",
): McpSchemaPolicyResult {
  if (typeof schema !== "object" || schema === null) {
    throw new McpSchemaPolicyError("registered schema has no JSON Schema converter");
  }
  const jsonSchema = (schema as StandardSchemaJsonView)["~standard"]?.jsonSchema;
  if (jsonSchema === undefined) {
    throw new McpSchemaPolicyError("registered schema has no JSON Schema converter");
  }
  return enforceMcpSchemaPolicy(jsonSchema[direction]());
}
