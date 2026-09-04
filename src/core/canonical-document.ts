// ---------------------------------------------------------------------------
// PRD 678, 679, 680, 681, 683 -- Canonical document envelope, projections,
// content core, output bounds
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export const CANONICAL_SCHEMA_VERSION = "1.0.0";

// -- PRD 680: Source spans (union) -------------------------------------------

export interface PageBboxSpan {
  readonly kind: "page-bbox";
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly contentHash: string;
}

export interface CharOffsetSpan {
  readonly kind: "char-offset";
  readonly start: number;
  readonly end: number;
  readonly contentHash: string;
}

export interface SheetCellSpan {
  readonly kind: "sheet-cell";
  readonly sheet: string;
  readonly startCell: string;
  readonly endCell: string;
  readonly contentHash: string;
}

export interface SlideShapeSpan {
  readonly kind: "slide-shape";
  readonly slide: number;
  readonly shapeId: string;
  readonly contentHash: string;
}

export interface MediaTimeSpan {
  readonly kind: "media-time";
  readonly startMs: number;
  readonly endMs: number;
  readonly contentHash: string;
}

export type SourceSpan =
  | PageBboxSpan
  | CharOffsetSpan
  | SheetCellSpan
  | SlideShapeSpan
  | MediaTimeSpan;

// -- PRD 680: Typed block records --------------------------------------------

export interface TextBlock {
  readonly type: "text";
  readonly blockId: string;
  readonly content: string;
  readonly spans?: readonly SourceSpan[];
}

export interface TableCell {
  readonly row: number;
  readonly col: number;
  readonly content: string;
  readonly rowSpan?: number;
  readonly colSpan?: number;
}

export interface TableBlock {
  readonly type: "table";
  readonly blockId: string;
  readonly cells: readonly TableCell[];
  readonly spans?: readonly SourceSpan[];
}

export interface AssetBlock {
  readonly type: "asset";
  readonly blockId: string;
  readonly assetRef: string;
  readonly mimeType: string;
  readonly altText?: string;
  readonly spans?: readonly SourceSpan[];
}

export interface FormulaBlock {
  readonly type: "formula";
  readonly blockId: string;
  readonly expression: string;
  readonly format: "latex" | "mathml" | "plain";
  readonly spans?: readonly SourceSpan[];
}

export type DocumentBlock = TextBlock | TableBlock | AssetBlock | FormulaBlock;

export interface MetadataRecord {
  readonly key: string;
  readonly value: string;
}

export interface CitationRecord {
  readonly citationId: string;
  readonly label: string;
  readonly target: string;
  readonly blockId?: string;
}

// -- PRD 680: Capability state -----------------------------------------------

export type CapabilityState = "available" | "unsupported" | "not_run" | "failed";

const VALID_CAPABILITY_STATES: readonly CapabilityState[] = [
  "available",
  "unsupported",
  "not_run",
  "failed",
];

export interface CapabilityStates {
  readonly [capability: string]: CapabilityState;
}

// -- PRD 678: Source identity ------------------------------------------------

export interface SourceIdentity {
  readonly contentHash: string;
  readonly url?: string;
  readonly filename?: string;
  readonly artifactRef?: string;
}

// -- PRD 678: Provenance -----------------------------------------------------

export interface DocumentProvenance {
  readonly engine: string;
  readonly model: string;
  readonly version: string;
  readonly cost: number;
  readonly confidence: number;
}

// -- PRD 678: Canonical document envelope ------------------------------------

export type DocumentStatus = "success" | "partial" | "unsupported" | "failed";

export interface CanonicalDocumentEnvelope {
  readonly schemaVersion: string;
  readonly documentId: string;
  readonly canonicalContentId: string;
  readonly sourceIdentity: SourceIdentity;
  readonly blocks: readonly DocumentBlock[];
  readonly readingOrder: readonly string[];
  readonly status: DocumentStatus;
  readonly capabilityStates: CapabilityStates;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly provenance: DocumentProvenance;
  readonly metadata?: readonly MetadataRecord[];
  readonly citations?: readonly CitationRecord[];
}

// -- PRD 679: Canonical content core -----------------------------------------

export interface CanonicalContentCore {
  readonly schemaVersion: string;
  readonly canonicalContentId: string;
  readonly blocks: readonly DocumentBlock[];
  readonly readingOrder: readonly string[];
  readonly status: DocumentStatus;
  readonly capabilityStates: CapabilityStates;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly provenance: DocumentProvenance;
  readonly metadata?: readonly MetadataRecord[];
  readonly citations?: readonly CitationRecord[];
}

// -- PRD 681: Projection types -----------------------------------------------

export type ProjectionKind = "markdown" | "structured" | "text" | "all";

export const DEFAULT_PROJECTION_KIND: ProjectionKind = "markdown";

export interface ProjectionResult {
  readonly projectionVersion: string;
  readonly sourceDocumentId: string;
  readonly canonicalContentId: string;
  readonly kind: ProjectionKind;
  readonly content: string;
  readonly lossy: boolean;
  readonly omissions: readonly string[];
  readonly warnings: readonly string[];
}

// -- PRD 683: Output bounds --------------------------------------------------

export interface OutputBounds {
  readonly maxBytes: number;
  readonly maxChars: number;
  readonly maxBlocks: number;
  readonly maxTables: number;
  readonly maxAssets: number;
}

export interface BoundsCheckResult {
  readonly withinBounds: boolean;
  readonly exceededDimension?: string;
  readonly actualValue?: number;
  readonly limitValue?: number;
}

export interface TruncatedResult {
  readonly summary: string;
  readonly provenance: DocumentProvenance;
  readonly artifactRef: string;
  readonly truncated: true;
}

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

export function validateSourceSpan(span: SourceSpan): void {
  switch (span.kind) {
    case "page-bbox": {
      if (span.page < 0) throw new Error("PageBboxSpan page must be non-negative");
      if (span.width <= 0 || span.height <= 0) {
        throw new Error("PageBboxSpan width and height must be positive");
      }
      if (!span.contentHash) throw new Error("PageBboxSpan must have a contentHash");
      return;
    }
    case "char-offset": {
      if (span.start < 0) throw new Error("CharOffsetSpan start must be non-negative");
      if (span.end <= span.start) {
        throw new Error("CharOffsetSpan end must be greater than start");
      }
      if (!span.contentHash) throw new Error("CharOffsetSpan must have a contentHash");
      return;
    }
    case "sheet-cell": {
      if (!span.sheet) throw new Error("SheetCellSpan must have a sheet name");
      if (!span.startCell) throw new Error("SheetCellSpan must have a startCell");
      if (!span.endCell) throw new Error("SheetCellSpan must have an endCell");
      if (!span.contentHash) throw new Error("SheetCellSpan must have a contentHash");
      return;
    }
    case "slide-shape": {
      if (span.slide < 0) throw new Error("SlideShapeSpan slide must be non-negative");
      if (!span.shapeId) throw new Error("SlideShapeSpan must have a shapeId");
      if (!span.contentHash) throw new Error("SlideShapeSpan must have a contentHash");
      return;
    }
    case "media-time": {
      if (span.startMs < 0) throw new Error("MediaTimeSpan startMs must be non-negative");
      if (span.endMs <= span.startMs) {
        throw new Error("MediaTimeSpan endMs must be greater than startMs");
      }
      if (!span.contentHash) throw new Error("MediaTimeSpan must have a contentHash");
      return;
    }
    default: {
      const _exhaustive: never = span;
      throw new Error(`Unknown SourceSpan kind: "${String(_exhaustive)}"`);
    }
  }
}

export function validateBlock(block: DocumentBlock): void {
  if (!block.blockId) {
    throw new Error("Block must have a non-empty blockId");
  }
  switch (block.type) {
    case "text": {
      if (typeof block.content !== "string") {
        throw new Error(`TextBlock "${block.blockId}" must have string content`);
      }
      break;
    }
    case "table": {
      if (!Array.isArray(block.cells)) {
        throw new Error(`TableBlock "${block.blockId}" must have cells array`);
      }
      break;
    }
    case "asset": {
      if (!block.assetRef) {
        throw new Error(`AssetBlock "${block.blockId}" must have an assetRef`);
      }
      if (!block.mimeType) {
        throw new Error(`AssetBlock "${block.blockId}" must have a mimeType`);
      }
      break;
    }
    case "formula": {
      if (!block.expression) {
        throw new Error(`FormulaBlock "${block.blockId}" must have an expression`);
      }
      break;
    }
    default: {
      const _exhaustive: never = block;
      throw new Error(`Unknown block type: "${String(_exhaustive)}"`);
    }
  }
  if (block.spans) {
    for (const span of block.spans) {
      validateSourceSpan(span);
    }
  }
}

export function validateCapabilityState(state: string): void {
  if (!VALID_CAPABILITY_STATES.includes(state as CapabilityState)) {
    throw new Error(
      `Invalid capability state "${state}"; must be one of: ${VALID_CAPABILITY_STATES.join(", ")}`,
    );
  }
}

export function validateEnvelope(envelope: CanonicalDocumentEnvelope): void {
  if (!envelope.schemaVersion) {
    throw new Error("Envelope must have a non-empty schemaVersion");
  }
  if (!envelope.documentId) {
    throw new Error("Envelope must have a non-empty documentId");
  }
  if (!envelope.canonicalContentId) {
    throw new Error("Envelope must have a non-empty canonicalContentId");
  }
  if (!envelope.sourceIdentity.contentHash) {
    throw new Error("Envelope sourceIdentity must have a contentHash");
  }
  if (!envelope.provenance.engine) {
    throw new Error("Envelope provenance must include engine");
  }
  if (!envelope.provenance.model) {
    throw new Error("Envelope provenance must include model");
  }
  if (!envelope.provenance.version) {
    throw new Error("Envelope provenance must include version");
  }
  if (envelope.provenance.cost < 0) {
    throw new Error("Envelope provenance cost must be non-negative");
  }
  if (envelope.provenance.confidence < 0 || envelope.provenance.confidence > 1) {
    throw new Error("Envelope provenance confidence must be between 0 and 1");
  }

  // Validate blocks have unique IDs
  const blockIds = new Set<string>();
  for (const block of envelope.blocks) {
    validateBlock(block);
    if (blockIds.has(block.blockId)) {
      throw new Error(`Duplicate block ID: "${block.blockId}"`);
    }
    blockIds.add(block.blockId);
  }

  // Validate reading order references existing blocks
  for (const id of envelope.readingOrder) {
    if (!blockIds.has(id)) {
      throw new Error(`Reading order references unknown block ID: "${id}"`);
    }
  }

  // Validate capability states
  for (const [, state] of Object.entries(envelope.capabilityStates)) {
    validateCapabilityState(state);
  }
}

// -- PRD 680: Aggregate status from capability states ------------------------

export function aggregateStatus(
  capabilityStates: CapabilityStates,
  requiredCapabilities: readonly string[],
): DocumentStatus {
  let hasUnsupported = false;
  let hasFailed = false;

  for (const cap of requiredCapabilities) {
    const state = capabilityStates[cap];
    if (state === undefined) {
      hasFailed = true;
      continue;
    }
    switch (state) {
      case "failed":
        hasFailed = true;
        break;
      case "unsupported":
        hasUnsupported = true;
        break;
      case "available":
      case "not_run":
        break;
      default: {
        const _exhaustive: never = state;
        throw new Error(`Unknown capability state: "${String(_exhaustive)}"`);
      }
    }
  }

  if (hasFailed) return "failed";
  if (hasUnsupported) return "partial";
  return "success";
}

// -- PRD 679: Content core extraction and source binding ---------------------

export function extractContentCore(
  envelope: CanonicalDocumentEnvelope,
): CanonicalContentCore {
  const core: CanonicalContentCore = {
    schemaVersion: envelope.schemaVersion,
    canonicalContentId: envelope.canonicalContentId,
    blocks: envelope.blocks,
    readingOrder: envelope.readingOrder,
    status: envelope.status,
    capabilityStates: envelope.capabilityStates,
    warnings: envelope.warnings,
    errors: envelope.errors,
    provenance: envelope.provenance,
  };
  if (envelope.metadata !== undefined) {
    (core as { metadata: readonly MetadataRecord[] }).metadata =
      envelope.metadata;
  }
  if (envelope.citations !== undefined) {
    (core as { citations: readonly CitationRecord[] }).citations =
      envelope.citations;
  }
  return core;
}

export function computeContentHash(blocks: readonly DocumentBlock[]): string {
  const canonical = JSON.stringify(blocks);
  return createHash("sha256").update(canonical).digest("hex");
}

export function rebuildSourceBinding(
  core: CanonicalContentCore,
  sourceIdentity: SourceIdentity,
  documentId: string,
): CanonicalDocumentEnvelope {
  return {
    ...core,
    documentId,
    sourceIdentity,
  };
}

// -- PRD 681: Projection functions -------------------------------------------

const PROJECTION_VERSION = "1.0.0";

export const CANONICAL_PROJECTION_VERSION = PROJECTION_VERSION;

function blockToMarkdown(block: DocumentBlock): string {
  switch (block.type) {
    case "text":
      return block.content;
    case "table": {
      if (block.cells.length === 0) return "";
      const maxRow = Math.max(...block.cells.map((c) => c.row));
      const maxCol = Math.max(...block.cells.map((c) => c.col));
      const grid: string[][] = Array.from(
        { length: maxRow + 1 },
        () => Array.from({ length: maxCol + 1 }, () => ""),
      );
      for (const cell of block.cells) {
        grid[cell.row]![cell.col] = cell.content;
      }
      const lines: string[] = [];
      for (let r = 0; r <= maxRow; r++) {
        lines.push("| " + grid[r]!.join(" | ") + " |");
        if (r === 0) {
          lines.push("| " + grid[r]!.map(() => "---").join(" | ") + " |");
        }
      }
      return lines.join("\n");
    }
    case "asset":
      return `![${block.altText ?? block.assetRef}](${block.assetRef})`;
    case "formula":
      return block.format === "latex"
        ? `$$${block.expression}$$`
        : block.expression;
    default: {
      const _exhaustive: never = block;
      throw new Error(`Unknown block type: "${String(_exhaustive)}"`);
    }
  }
}

function blockToText(block: DocumentBlock): string {
  switch (block.type) {
    case "text":
      return block.content;
    case "table": {
      if (block.cells.length === 0) return "";
      const sorted = [...block.cells].sort(
        (a, b) => a.row - b.row || a.col - b.col,
      );
      return sorted.map((c) => c.content).join("\t");
    }
    case "asset":
      return block.altText ?? `[asset:${block.assetRef}]`;
    case "formula":
      return block.expression;
    default: {
      const _exhaustive: never = block;
      throw new Error(`Unknown block type: "${String(_exhaustive)}"`);
    }
  }
}

export function projectToMarkdown(
  envelope: CanonicalDocumentEnvelope,
): ProjectionResult {
  const orderedBlocks = envelope.readingOrder.map((id) => {
    const block = envelope.blocks.find((b) => b.blockId === id);
    if (!block) throw new Error(`Block "${id}" not found`);
    return block;
  });

  const content = orderedBlocks.map(blockToMarkdown).join("\n\n");

  return {
    projectionVersion: PROJECTION_VERSION,
    sourceDocumentId: envelope.documentId,
    canonicalContentId: envelope.canonicalContentId,
    kind: "markdown",
    content,
    lossy: false,
    omissions: [],
    warnings: [],
  };
}

export function projectToText(
  envelope: CanonicalDocumentEnvelope,
): ProjectionResult {
  const orderedBlocks = envelope.readingOrder.map((id) => {
    const block = envelope.blocks.find((b) => b.blockId === id);
    if (!block) throw new Error(`Block "${id}" not found`);
    return block;
  });

  const content = orderedBlocks.map(blockToText).join("\n\n");
  const omissions = computeTextOmissions(orderedBlocks);

  return {
    projectionVersion: PROJECTION_VERSION,
    sourceDocumentId: envelope.documentId,
    canonicalContentId: envelope.canonicalContentId,
    kind: "text",
    content,
    lossy: true,
    omissions,
    warnings: omissions.length > 0 ? ["text projection is lossy; structure flattened"] : [],
  };
}

// -- PRD 663: Canonical envelope authoritative output runtime -----------------
//
// The envelope is the authority; markdown/structured/text/all are versioned,
// deterministic projections of the same envelope (never an independent parse
// path, never Markdown-derived structure). Default kind is markdown.

function orderedBlocksOrThrow(envelope: CanonicalDocumentEnvelope): DocumentBlock[] {
  return envelope.readingOrder.map((id) => {
    const block = envelope.blocks.find((b) => b.blockId === id);
    if (!block) throw new Error(`Block "${id}" not found`);
    return block;
  });
}

function computeTextOmissions(blocks: readonly DocumentBlock[]): string[] {
  const omissions: string[] = [];
  if (blocks.some((b) => b.type === "table")) omissions.push("table-structure");
  if (blocks.some((b) => b.type === "asset")) omissions.push("asset-bytes");
  if (blocks.some((b) => b.type === "formula")) omissions.push("formula-formatting");
  return omissions;
}

/** Resolves the requested projection kind; undefined defaults to markdown. */
export function resolveProjectionKind(requested?: ProjectionKind): ProjectionKind {
  if (requested === undefined) return DEFAULT_PROJECTION_KIND;
  const valid: readonly ProjectionKind[] = ["markdown", "structured", "text", "all"];
  if (!valid.includes(requested)) {
    throw new Error(`Unknown projection kind "${String(requested)}"`);
  }
  return requested;
}

/** Deterministic lossless structured projection (JSON of ordered blocks). */
export function projectToStructured(
  envelope: CanonicalDocumentEnvelope,
): ProjectionResult {
  const ordered = orderedBlocksOrThrow(envelope);
  const content = JSON.stringify({ readingOrder: envelope.readingOrder, blocks: ordered });
  return {
    projectionVersion: PROJECTION_VERSION,
    sourceDocumentId: envelope.documentId,
    canonicalContentId: envelope.canonicalContentId,
    kind: "structured",
    content,
    lossy: false,
    omissions: [],
    warnings: [],
  };
}

/** Deterministic bundled projection containing markdown+structured+text. */
export function projectToAll(
  envelope: CanonicalDocumentEnvelope,
): ProjectionResult {
  const ordered = orderedBlocksOrThrow(envelope);
  const markdown = ordered.map(blockToMarkdown).join("\n\n");
  const structured = JSON.stringify({ readingOrder: envelope.readingOrder, blocks: ordered });
  const text = ordered.map(blockToText).join("\n\n");
  const content = JSON.stringify({ markdown, structured, text });
  return {
    projectionVersion: PROJECTION_VERSION,
    sourceDocumentId: envelope.documentId,
    canonicalContentId: envelope.canonicalContentId,
    kind: "all",
    content,
    lossy: false,
    omissions: [],
    warnings: [],
  };
}

/**
 * Single dispatcher for all projection kinds. Validates the envelope first
 * so every projection shares schema/semantics/provenance.
 */
export function projectCanonicalDocument(
  envelope: CanonicalDocumentEnvelope,
  kind?: ProjectionKind,
): ProjectionResult {
  validateEnvelope(envelope);
  const resolved = resolveProjectionKind(kind);
  switch (resolved) {
    case "markdown":
      return projectToMarkdown(envelope);
    case "text":
      return projectToText(envelope);
    case "structured":
      return projectToStructured(envelope);
    case "all":
      return projectToAll(envelope);
  }
}

// -- PRD 663: Adapter boundary (provider raw JSON never crosses) --------------

export const ADAPTER_FORBIDDEN_RAW_KEYS: readonly string[] = [
  "rawJson",
  "raw",
  "providerRaw",
  "providerPayload",
  "engineRaw",
  "doclingOutput",
  "anydocOutput",
];

/**
 * Rejects provider/engine raw JSON at the adapter boundary. Adapters must
 * normalize to typed blocks inside src/adapters/ before constructing the
 * envelope; caller contracts never depend on Docling/anydoc/OCR/VLM schemas.
 */
export function assertNoRawProviderPayload(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (ADAPTER_FORBIDDEN_RAW_KEYS.includes(key)) {
      throw new Error(
        `Adapter boundary violation: key "${key}" must not cross the adapter boundary; normalize to typed blocks first`,
      );
    }
  }
}

export interface AdapterEnvelopeInput {
  readonly documentId: string;
  readonly canonicalContentId?: string;
  readonly sourceIdentity: SourceIdentity;
  readonly blocks: readonly DocumentBlock[];
  readonly readingOrder: readonly string[];
  readonly status: DocumentStatus;
  readonly capabilityStates: CapabilityStates;
  readonly provenance: DocumentProvenance;
  readonly warnings?: readonly string[];
  readonly errors?: readonly string[];
  readonly metadata?: readonly MetadataRecord[];
  readonly citations?: readonly CitationRecord[];
  readonly raw?: Record<string, unknown>;
}

/**
 * Builds a validated envelope from adapter-normalized input. Rejects any
 * raw provider payload and defaults canonicalContentId via content hash.
 */
export function buildCanonicalEnvelopeFromAdapter(
  input: AdapterEnvelopeInput & Record<string, unknown>,
): CanonicalDocumentEnvelope {
  assertNoRawProviderPayload(input);
  const canonicalContentId =
    input.canonicalContentId ?? computeContentHash(input.blocks);
  const envelope: CanonicalDocumentEnvelope = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    documentId: input.documentId,
    canonicalContentId,
    sourceIdentity: input.sourceIdentity,
    blocks: input.blocks,
    readingOrder: input.readingOrder,
    status: input.status,
    capabilityStates: input.capabilityStates,
    warnings: input.warnings ?? [],
    errors: input.errors ?? [],
    provenance: input.provenance,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.citations === undefined ? {} : { citations: input.citations }),
  };
  validateEnvelope(envelope);
  return envelope;
}

// -- PRD 663: Cache unit is the canonical content core ------------------------

/**
 * Extracts the cacheable core (no source-specific fields). The core never
 * contains URL/filename/ArtifactRef/documentId/cache-age/request metadata.
 */
export function extractCacheableCore(
  envelope: CanonicalDocumentEnvelope,
): CanonicalContentCore {
  const core = extractContentCore(envelope);
  const serialized = JSON.stringify(core);
  const identity = envelope.sourceIdentity;
  for (const secret of [identity.url, identity.filename, identity.artifactRef]) {
    if (secret !== undefined && secret !== "" && serialized.includes(secret)) {
      throw new Error("Cacheable core must not contain source-specific identity");
    }
  }
  if ("documentId" in core || "sourceIdentity" in core) {
    throw new Error("Cacheable core must not contain source binding fields");
  }
  return core;
}

/** Rebuilds the source binding on a cache hit. */
export function rebuildEnvelopeFromCacheHit(
  core: CanonicalContentCore,
  sourceIdentity: SourceIdentity,
  documentId: string,
): CanonicalDocumentEnvelope {
  const envelope = rebuildSourceBinding(core, sourceIdentity, documentId);
  validateEnvelope(envelope);
  return envelope;
}

// -- PRD 663: Typed bounded output --------------------------------------------

export type CanonicalArtifactKind = "source" | "canonical_document" | "projection";

export interface TypedTruncatedResult extends TruncatedResult {
  readonly artifactKind: CanonicalArtifactKind;
}

/**
 * Builds a bounded over-limit summary with a typed result ArtifactRef.
 * The ref must be storage-neutral (no R2 key/presigned URL/filesystem path).
 */
export function buildTypedTruncatedResult(
  envelope: CanonicalDocumentEnvelope,
  artifactRef: string,
  artifactKind: CanonicalArtifactKind,
  boundsCheck: BoundsCheckResult,
): TypedTruncatedResult {
  const valid: readonly CanonicalArtifactKind[] = ["source", "canonical_document", "projection"];
  if (!valid.includes(artifactKind)) {
    throw new Error(`Invalid artifactKind: "${String(artifactKind)}"`);
  }
  if (!artifactRef) {
    throw new Error("Typed truncated result requires a non-empty artifactRef");
  }
  if (artifactRef.includes("/") && /^[0-9a-f]{32}\//u.test(artifactRef)) {
    throw new Error("artifactRef must be storage-neutral, not a storage key");
  }
  const base = buildTruncatedResult(envelope, artifactRef, boundsCheck);
  return { ...base, artifactKind };
}

export type BoundedProjectionOutcome =
  | { readonly withinBounds: true; readonly projection: ProjectionResult }
  | { readonly withinBounds: false; readonly summary: TypedTruncatedResult };

/**
 * Projects with output bounds. Within bounds returns the projection;
 * over limit returns a bounded summary + typed ArtifactRef (no raw content).
 */
export function projectWithBounds(
  envelope: CanonicalDocumentEnvelope,
  kind: ProjectionKind | undefined,
  bounds: OutputBounds,
  artifactRef: string,
  artifactKind: CanonicalArtifactKind,
): BoundedProjectionOutcome {
  validateEnvelope(envelope);
  const check = checkOutputBounds(envelope, bounds);
  if (!check.withinBounds) {
    return {
      withinBounds: false as const,
      summary: buildTypedTruncatedResult(envelope, artifactRef, artifactKind, check),
    };
  }
  const projection = projectCanonicalDocument(envelope, kind);
  if (projection.content.length > bounds.maxChars) {
    const charCheck: BoundsCheckResult = {
      withinBounds: false,
      exceededDimension: "chars",
      actualValue: projection.content.length,
      limitValue: bounds.maxChars,
    };
    return {
      withinBounds: false as const,
      summary: buildTypedTruncatedResult(envelope, artifactRef, artifactKind, charCheck),
    };
  }
  return { withinBounds: true as const, projection };
}

// -- PRD 683: Output bounds --------------------------------------------------

const encoder = new TextEncoder();

export function checkOutputBounds(
  envelope: CanonicalDocumentEnvelope,
  bounds: OutputBounds,
): BoundsCheckResult {
  const blockJson = JSON.stringify(envelope.blocks);
  const byteLength = encoder.encode(blockJson).length;

  if (byteLength > bounds.maxBytes) {
    return {
      withinBounds: false,
      exceededDimension: "bytes",
      actualValue: byteLength,
      limitValue: bounds.maxBytes,
    };
  }

  const charLength = blockJson.length;
  if (charLength > bounds.maxChars) {
    return {
      withinBounds: false,
      exceededDimension: "chars",
      actualValue: charLength,
      limitValue: bounds.maxChars,
    };
  }

  if (envelope.blocks.length > bounds.maxBlocks) {
    return {
      withinBounds: false,
      exceededDimension: "blocks",
      actualValue: envelope.blocks.length,
      limitValue: bounds.maxBlocks,
    };
  }

  const tableCount = envelope.blocks.filter((b) => b.type === "table").length;
  if (tableCount > bounds.maxTables) {
    return {
      withinBounds: false,
      exceededDimension: "tables",
      actualValue: tableCount,
      limitValue: bounds.maxTables,
    };
  }

  const assetCount = envelope.blocks.filter((b) => b.type === "asset").length;
  if (assetCount > bounds.maxAssets) {
    return {
      withinBounds: false,
      exceededDimension: "assets",
      actualValue: assetCount,
      limitValue: bounds.maxAssets,
    };
  }

  return { withinBounds: true };
}

export function buildTruncatedResult(
  envelope: CanonicalDocumentEnvelope,
  artifactRef: string,
  boundsCheck: BoundsCheckResult,
): TruncatedResult {
  return {
    summary: `Output exceeded ${boundsCheck.exceededDimension ?? "limit"}: ` +
      `${String(boundsCheck.actualValue)} > ${String(boundsCheck.limitValue)}`,
    provenance: envelope.provenance,
    artifactRef,
    truncated: true,
  };
}
