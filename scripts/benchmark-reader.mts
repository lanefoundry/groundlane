import { readFile, readdir } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { load } from "cheerio";
import { z } from "zod";
import { extractReadableDocument } from "../src/core/readable-document.js";

const expectedMetadataSchema = z.object({
  title: z.string().nullable().optional(),
  byline: z.string().nullable().optional(),
  excerpt: z.string().nullable().optional(),
  publishedTime: z.string().nullable().optional(),
});

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const fixtureRoot = arguments_[0];
const revision = arguments_[1] ?? "unknown";

if (!fixtureRoot) {
  throw new Error(
    "Usage: pnpm benchmark:reader -- /path/to/readability/test/test-pages [revision]",
  );
}

const clean = (value: string | undefined): string | undefined =>
  value?.replace(/\s+/gu, " ").trim() || undefined;

const tokens = (value: string): string[] =>
  value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];

const tokenCounts = (values: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

const overlapCount = (
  actual: readonly string[],
  expected: readonly string[],
): number => {
  const actualCounts = tokenCounts(actual);
  const expectedCounts = tokenCounts(expected);
  let overlap = 0;
  for (const [token, count] of actualCounts) {
    overlap += Math.min(count, expectedCounts.get(token) ?? 0);
  }
  return overlap;
};

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
};

const fixtureNames = (await readdir(resolve(fixtureRoot), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let actualTokenCount = 0;
let expectedTokenCount = 0;
let overlappingTokenCount = 0;
let metadataExact = 0;
let metadataExpected = 0;
let empty = 0;
let failures = 0;
const durations: number[] = [];

for (const fixtureName of fixtureNames) {
  const directory = join(resolve(fixtureRoot), fixtureName);
  try {
    const [source, expectedHtml, metadataSource] = await Promise.all([
      readFile(join(directory, "source.html"), "utf8"),
      readFile(join(directory, "expected.html"), "utf8"),
      readFile(join(directory, "expected-metadata.json"), "utf8"),
    ]);
    const metadata = expectedMetadataSchema.parse(JSON.parse(metadataSource));
    const start = performance.now();
    const result = extractReadableDocument(
      source,
      `https://benchmark.invalid/${encodeURIComponent(fixtureName)}/`,
    );
    durations.push(performance.now() - start);

    const actualTokens = tokens(result.text);
    const expectedTokens = tokens(load(expectedHtml).text());
    actualTokenCount += actualTokens.length;
    expectedTokenCount += expectedTokens.length;
    overlappingTokenCount += overlapCount(actualTokens, expectedTokens);
    if (actualTokens.length === 0) empty += 1;

    const metadataPairs: ReadonlyArray<readonly [string | undefined, string | null | undefined]> = [
      [result.title, metadata.title],
      [result.author, metadata.byline],
      [result.description, metadata.excerpt],
      [result.publishedAt, metadata.publishedTime],
    ];
    for (const [actual, expected] of metadataPairs) {
      if (expected === null || expected === undefined) continue;
      metadataExpected += 1;
      if (clean(actual) === clean(expected)) metadataExact += 1;
    }
  } catch {
    failures += 1;
  }
}

const precision =
  actualTokenCount === 0 ? 0 : overlappingTokenCount / actualTokenCount;
const recall =
  expectedTokenCount === 0 ? 0 : overlappingTokenCount / expectedTokenCount;
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

process.stdout.write(
  `${JSON.stringify(
    {
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
      },
      method: {
        passes: 1,
        warmupPasses: 0,
        text: "micro-averaged Unicode letter/number token multiset overlap",
        metadata: "whitespace-normalized exact match for non-null title/byline/excerpt/publishedTime",
      },
      result: {
        precision,
        recall,
        f1,
        metadataExact,
        metadataExpected,
        medianMs: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        empty,
        failures,
      },
    },
    null,
    2,
  )}\n`,
);
