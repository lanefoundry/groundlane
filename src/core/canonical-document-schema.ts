import { z } from "zod";
import { validateEnvelope, type CanonicalDocumentEnvelope } from "./canonical-document.js";

const sourceSpanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page-bbox"), page: z.number().int().nonnegative(), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("char-offset"), start: z.number().int().nonnegative(), end: z.number().int().positive(), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("sheet-cell"), sheet: z.string().min(1), startCell: z.string().min(1), endCell: z.string().min(1), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("slide-shape"), slide: z.number().int().nonnegative(), shapeId: z.string().min(1), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("media-time"), startMs: z.number().nonnegative(), endMs: z.number().positive(), contentHash: z.string().min(1) }).strict(),
]);

const documentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), blockId: z.string().min(1), content: z.string(), spans: z.array(sourceSpanSchema).optional() }).strict(),
  z.object({
    type: z.literal("table"),
    blockId: z.string().min(1),
    cells: z.array(z.object({ row: z.number().int().nonnegative(), col: z.number().int().nonnegative(), content: z.string(), rowSpan: z.number().int().positive().optional(), colSpan: z.number().int().positive().optional() }).strict()),
    spans: z.array(sourceSpanSchema).optional(),
  }).strict(),
  z.object({ type: z.literal("asset"), blockId: z.string().min(1), assetRef: z.string().min(1), mimeType: z.string().min(1), altText: z.string().optional(), spans: z.array(sourceSpanSchema).optional() }).strict(),
  z.object({ type: z.literal("formula"), blockId: z.string().min(1), expression: z.string(), format: z.enum(["latex", "mathml", "plain"]), spans: z.array(sourceSpanSchema).optional() }).strict(),
]);

export const canonicalEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  documentId: z.string().min(1),
  canonicalContentId: z.string().min(1),
  sourceIdentity: z.object({ contentHash: z.string().min(1), url: z.string().optional(), filename: z.string().optional(), artifactRef: z.string().optional() }).strict(),
  blocks: z.array(documentBlockSchema),
  readingOrder: z.array(z.string().min(1)),
  status: z.enum(["success", "partial", "unsupported", "failed"]),
  capabilityStates: z.record(z.string(), z.enum(["available", "unsupported", "not_run", "failed"])),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  provenance: z.object({ engine: z.string().min(1), model: z.string(), version: z.string().min(1), cost: z.number().nonnegative().nullable(), confidence: z.number().min(0).max(1).nullable() }).strict(),
  metadata: z.array(z.object({ key: z.string().min(1), value: z.string() }).strict()).optional(),
  citations: z.array(z.object({ citationId: z.string().min(1), label: z.string(), target: z.string(), blockId: z.string().optional() }).strict()).optional(),
}).strict();

/** Validate wire shape before cross-field canonical invariants. JSON normalization
 * removes explicit undefined optional properties, matching persisted payloads. */
export function parseCanonicalDocumentEnvelope(value: unknown): CanonicalDocumentEnvelope {
  const envelope = JSON.parse(JSON.stringify(canonicalEnvelopeSchema.parse(value))) as CanonicalDocumentEnvelope;
  validateEnvelope(envelope);
  return envelope;
}
