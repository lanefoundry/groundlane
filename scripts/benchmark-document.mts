import { readFile, readdir } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { z } from "zod";

import {
  DOCUMENT_ENGINE_VERSION,
  parseBoundedDocument,
} from "../src/adapters/document/bounded-document-parser.js";

const expectedSchema = z.object({
  requiredText: z.array(z.string()).default([]),
  expectedBlocks: z.number().int().nonnegative().optional(),
  expectedTableCells: z.number().int().nonnegative().optional(),
  format: z.string(),
  description: z.string(),
});

const mimeMap: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  eml: "message/rfc822",
  epub: "application/epub+zip",
};

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return mimeMap[ext] ?? "application/octet-stream";
}

function blockText(block: { type: string; content?: string; cells?: Array<{ content: string }>; expression?: string; altText?: string }): string {
  if (block.type === "text") return block.content ?? "";
  if (block.type === "table") return (block.cells ?? []).map((c) => c.content).join(" ");
  if (block.type === "formula") return block.expression ?? "";
  if (block.type === "asset") return block.altText ?? "";
  return "";
}

function charLevelF1(reference: string, candidate: string): { precision: number; recall: number; f1: number } {
  const refChars = new Map<string, number>();
  for (const c of reference) refChars.set(c, (refChars.get(c) ?? 0) + 1);
  const candChars = new Map<string, number>();
  for (const c of candidate) candChars.set(c, (candChars.get(c) ?? 0) + 1);

  let overlap = 0;
  for (const [c, count] of refChars) {
    overlap += Math.min(count, candChars.get(c) ?? 0);
  }

  const precision = candidate.length === 0 ? 0 : overlap / candidate.length;
  const recall = reference.length === 0 ? 0 : overlap / reference.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

const args = process.argv.slice(2).filter((a) => a !== "--");
const fixtureRoot = args[0] ?? "test/fixtures/document";
const revision = args[1] ?? "local";

const fixtureNames = (await readdir(resolve(fixtureRoot), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

interface FixtureResult {
  name: string;
  format: string;
  requiredTextFound: number;
  requiredTextExpected: number;
  requiredTextRecall: number;
  charF1: number;
  charPrecision: number;
  charRecall: number;
  blocks: number;
  tableCells: number;
  durationMs: number;
  error?: string;
}

const results: FixtureResult[] = [];
let totalRequiredFound = 0;
let totalRequiredExpected = 0;
let totalF1Sum = 0;
let failures = 0;
const durations: number[] = [];

for (const fixtureName of fixtureNames) {
  const dir = join(resolve(fixtureRoot), fixtureName);
  try {
    const expectedSource = await readFile(join(dir, "expected.json"), "utf8");
    const expected = expectedSchema.parse(JSON.parse(expectedSource));

    const sourceFiles = (await readdir(dir)).filter((f) => f.startsWith("source."));
    if (sourceFiles.length === 0) throw new Error("No source file found");
    const sourceFile = sourceFiles[0]!;
    const sourceBytes = await readFile(join(dir, sourceFile));
    const mime = guessMime(sourceFile);

    const start = performance.now();
    const parsed = await parseBoundedDocument({
      bytes: new Uint8Array(sourceBytes),
      declaredMime: mime,
      filename: sourceFile,
    });
    const elapsed = performance.now() - start;
    durations.push(elapsed);

    const fullText = parsed.blocks.map((b) => blockText(b as any)).join("\n");
    const tableCells = parsed.blocks
      .filter((b) => b.type === "table")
      .reduce((sum, b) => sum + ((b as any).cells?.length ?? 0), 0);

    let requiredFound = 0;
    for (const req of expected.requiredText) {
      if (fullText.includes(req)) requiredFound += 1;
    }
    totalRequiredFound += requiredFound;
    totalRequiredExpected += expected.requiredText.length;

    const referenceText = expected.requiredText.join(" ");
    const metrics = charLevelF1(referenceText, fullText);
    totalF1Sum += metrics.f1;

    results.push({
      name: fixtureName,
      format: expected.format,
      requiredTextFound: requiredFound,
      requiredTextExpected: expected.requiredText.length,
      requiredTextRecall: expected.requiredText.length === 0 ? 1 : requiredFound / expected.requiredText.length,
      charF1: metrics.f1,
      charPrecision: metrics.precision,
      charRecall: metrics.recall,
      blocks: parsed.blocks.length,
      tableCells,
      durationMs: Math.round(elapsed * 100) / 100,
    });
  } catch (err) {
    failures += 1;
    results.push({
      name: fixtureName,
      format: "unknown",
      requiredTextFound: 0,
      requiredTextExpected: 0,
      requiredTextRecall: 0,
      charF1: 0,
      charPrecision: 0,
      charRecall: 0,
      blocks: 0,
      tableCells: 0,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
};

const output = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  corpus: {
    fixtureRoot: resolve(fixtureRoot),
    revision,
    fixtures: fixtureNames.length,
  },
  environment: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    architecture: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    engine: DOCUMENT_ENGINE_VERSION,
  },
  method: {
    requiredText: "exact substring match against concatenated block text",
    charF1: "character-level F1 between required text tokens and parsed output",
  },
  summary: {
    requiredTextRecall: totalRequiredExpected === 0 ? 1 : totalRequiredFound / totalRequiredExpected,
    avgCharF1: results.length === 0 ? 0 : totalF1Sum / results.length,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    failures,
  },
  fixtures: results,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
