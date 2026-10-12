import { z } from "zod";

import { GroundlaneError } from "./errors.js";

export const storedProjectionSchema = z.object({
  kind: z.enum(["markdown", "text", "structured", "all"]),
  content: z.string(), lossy: z.boolean(), omissions: z.array(z.string()), warnings: z.array(z.string()),
});

export const documentTextPageSchema = z.object({
  refId: z.string(), content: z.string(), projectionKind: storedProjectionSchema.shape.kind,
  contentOffset: z.number().int().nonnegative(), nextContentOffset: z.number().int().nonnegative().nullable(),
  totalContentChars: z.number().int().nonnegative(), contentHash: z.string(),
  extractionStatus: z.enum(["success", "partial", "unsupported", "failed", "unknown"]),
  lossy: z.boolean(), omissions: z.array(z.string()), warnings: z.array(z.string()),
  metadataTruncated: z.boolean(), instruction: z.string(),
  nextAction: z.object({ tool: z.literal("document_result_read_text"), arguments: z.object({
    refId: z.string(), contentOffset: z.number().int().nonnegative(), maxContentChars: z.number().int().positive(),
  }).strict() }).strict().optional(),
}).strict();

export type DocumentTextPage = z.infer<typeof documentTextPageSchema>;

/** Offsets count Unicode code points, not UTF-8 bytes or UTF-16 code units. */
export function paginateDocumentProjection(
  refId: string, contentHash: string, projection: z.infer<typeof storedProjectionSchema>,
  contentOffset: number, maxContentChars: number, maxOutputChars: number,
  extractionStatus: DocumentTextPage["extractionStatus"] = "unknown",
): DocumentTextPage {
  if (!Number.isSafeInteger(contentOffset) || contentOffset < 0 ||
      !Number.isSafeInteger(maxContentChars) || maxContentChars < 1 || maxContentChars > 50_000 ||
      !Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new GroundlaneError("INVALID_INPUT", "document_result_read_text", "Document text range is invalid");
  }
  // Count without allocating an array for the entire retained document.
  const points: string[] = [];
  let totalContentChars = 0;
  for (const point of projection.content) {
    if (totalContentChars >= contentOffset && points.length < maxContentChars) points.push(point);
    totalContentChars += 1;
  }
  if (contentOffset > totalContentChars) {
    throw new GroundlaneError("INVALID_INPUT", "document_result_read_text", "Document text range is invalid");
  }
  const boundMetadata = (values: string[]) => values.slice(0, 3).map((value) => {
    let result = "";
    let count = 0;
    for (const point of value) { if (count++ === 120) break; result += point; }
    return result;
  });
  let omissions = boundMetadata(projection.omissions);
  let warnings = boundMetadata(projection.warnings);
  let metadataTruncated = omissions.length !== projection.omissions.length || warnings.length !== projection.warnings.length ||
    omissions.some((value, index) => value !== projection.omissions[index]) ||
    warnings.some((value, index) => value !== projection.warnings[index]);
  const build = (length: number): DocumentTextPage => {
    const end = contentOffset + length;
    const nextContentOffset = end < totalContentChars ? end : null;
    return {
      refId, content: points.slice(0, length).join(""), projectionKind: projection.kind,
      contentOffset, nextContentOffset, totalContentChars, contentHash,
      extractionStatus,
      lossy: projection.lossy, omissions, warnings, metadataTruncated,
      instruction: nextContentOffset === null
        ? "End of saved projection; this does not certify complete extraction of the source."
        : "Follow nextAction until nextContentOffset is null. This page is not the full saved projection.",
      ...(nextContentOffset === null ? {} : { nextAction: { tool: "document_result_read_text" as const,
        arguments: { refId, contentOffset: nextContentOffset, maxContentChars } } }),
    };
  };
  const fits = (page: DocumentTextPage) => JSON.stringify({ ok: true, data: page }).length <= maxOutputChars;
  let high = points.length;
  // A final page drops continuation metadata and may fit when a shorter page cannot.
  if (fits(build(high))) return build(high);
  const minimum = contentOffset < totalContentChars ? 1 : 0;
  if (!fits(build(minimum))) {
    metadataTruncated ||= omissions.length > 0 || warnings.length > 0;
    omissions = []; warnings = [];
  }
  if (fits(build(high))) return build(high);
  if (!fits(build(minimum))) {
    throw new GroundlaneError("OUTPUT_LIMIT", "document_result_read_text", "Document text response metadata exceeds the configured output limit");
  }
  let low = minimum;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(build(mid))) low = mid;
    else high = mid - 1;
  }
  return build(low);
}
