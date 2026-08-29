import { load } from "cheerio";
import type { ExtractedValue, ExtractionField } from "./contracts.js";
import { GroundlaneError } from "./errors.js";

export interface ExtractionLimits { maxFields: number; maxValuesPerField: number; maxOutputChars: number }
export interface ExtractionResult { data: Record<string, ExtractedValue>; missingFields: string[]; truncated: boolean }

const maxPatternInputChars = 1_000_000;

function validateFieldName(name: string, names: Set<string>): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || names.has(name)) {
    throw new GroundlaneError("INVALID_INPUT", "extract", "Field names must be unique identifiers");
  }
  names.add(name);
}

function compilePattern(field: ExtractionField): RegExp {
  if (field.engine !== "pattern") {
    throw new GroundlaneError("INVALID_INPUT", "extract", "Pattern fields require pattern engine");
  }
  if (field.pattern.length === 0 || field.pattern.length > 500) {
    throw new GroundlaneError("INVALID_INPUT", "extract", "Pattern length is outside the allowed range");
  }
  if (
    /\\[1-9]/u.test(field.pattern) ||
    /\(\?<?[=!]/u.test(field.pattern) ||
    /\([^)]*[+*][^)]*\)[+*{]/u.test(field.pattern)
  ) {
    throw new GroundlaneError("INVALID_INPUT", "extract", "Pattern uses unsupported high-risk regex syntax");
  }
  const flags = field.flags ?? "";
  if (!/^[imu]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new GroundlaneError("INVALID_INPUT", "extract", "Pattern flags must be unique i, m, or u flags");
  }
  try {
    return new RegExp(field.pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch {
    throw new GroundlaneError("INVALID_INPUT", "extract", `Invalid pattern for field ${field.name}`);
  }
}

function extractPatternValues(html: string, field: ExtractionField, limits: ExtractionLimits): string[] {
  if (field.engine !== "pattern") return [];
  if (Array.from(html).length > maxPatternInputChars) {
    throw new GroundlaneError("OUTPUT_LIMIT", "extract", "Pattern input exceeds the configured limit");
  }
  const pattern = compilePattern(field);
  const values: string[] = [];
  for (const match of html.matchAll(pattern)) {
    if (values.length >= (field.many ? limits.maxValuesPerField : 1)) break;
    const group = field.group;
    const raw =
      typeof group === "number"
        ? match[group]
        : typeof group === "string"
          ? match.groups?.[group]
          : match[1] ?? match[0];
    const value = raw?.replace(/\s+/gu, " ").trim();
    if (value !== undefined && value.length > 0) values.push(value);
  }
  return values;
}

export function extractFields(html: string, fields: readonly ExtractionField[], limits: ExtractionLimits): ExtractionResult {
  if (fields.length === 0 || fields.length > limits.maxFields) throw new GroundlaneError("INVALID_INPUT", "extract", "Field count is outside the allowed range");
  const names = new Set<string>();
  const $ = load(html);
  const data: Record<string, ExtractedValue> = {};
  const missingFields: string[] = [];
  for (const field of fields) {
    validateFieldName(field.name, names);
    if (field.engine === "pattern") {
      const values = extractPatternValues(html, field, limits);
      if (values.length === 0) missingFields.push(field.name);
      data[field.name] = field.many ? values : values[0] ?? null;
      continue;
    }
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
