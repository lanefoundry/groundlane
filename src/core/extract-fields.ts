import { load } from "cheerio";
import type { ExtractedValue, ExtractionField } from "./contracts.js";
import { GroundlaneError } from "./errors.js";

export interface ExtractionLimits { maxFields: number; maxValuesPerField: number; maxOutputChars: number }
export interface ExtractionResult { data: Record<string, ExtractedValue>; missingFields: string[]; truncated: boolean }

export function extractFields(html: string, fields: readonly ExtractionField[], limits: ExtractionLimits): ExtractionResult {
  if (fields.length === 0 || fields.length > limits.maxFields) throw new GroundlaneError("INVALID_INPUT", "extract", "Field count is outside the allowed range");
  const names = new Set<string>();
  const $ = load(html);
  const data: Record<string, ExtractedValue> = {};
  const missingFields: string[] = [];
  for (const field of fields) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.name) || names.has(field.name)) throw new GroundlaneError("INVALID_INPUT", "extract", "Field names must be unique identifiers");
    names.add(field.name);
    if (field.value === "attribute" && !field.attribute) throw new GroundlaneError("INVALID_INPUT", "extract", "Attribute fields require an attribute name");
    let nodes;
    try { nodes = $(field.selector); } catch { throw new GroundlaneError("INVALID_INPUT", "extract", `Invalid selector for field ${field.name}`); }
    const selected = nodes.toArray().slice(0, field.many ? limits.maxValuesPerField : 1);
    const values = selected.map((node) => {
      const element = $(node);
      if (field.value === "html") return element.html() ?? "";
      if (field.value === "attribute") return element.attr(field.attribute!) ?? "";
      return element.text().replace(/\s+/g, " ").trim();
    }).filter((value) => value !== "");
    if (values.length === 0) missingFields.push(field.name);
    data[field.name] = field.many ? values : values[0] ?? null;
  }
  const serialized = JSON.stringify(data);
  if (Array.from(serialized).length > limits.maxOutputChars) throw new GroundlaneError("OUTPUT_LIMIT", "extract", "Extracted output exceeds the configured limit");
  return { data, missingFields, truncated: false };
}
