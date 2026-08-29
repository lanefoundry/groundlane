import { readFile, readdir } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { z } from "zod";

import { parseDocument } from "../src/core/parse-document.js";

const expectedMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  canonicalUrl: z.string().optional(),
});

const expectedLinkSchema = z.object({
  url: z.string(),
  text: z.string().optional(),
  internal: z.boolean(),
});

const expectedImageSchema = z.object({
  url: z.string(),
  alt: z.string().optional(),
  title: z.string().optional(),
});

const expectedTableSchema = z.object({
  caption: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const expectedFixtureSchema = z.object({
  baseUrl: z.url(),
  requiredText: z.array(z.string()).default([]),
  rejectedText: z.array(z.string()).default([]),
  metadata: expectedMetadataSchema.default({}),
  links: z.array(expectedLinkSchema).default([]),
  images: z.array(expectedImageSchema).default([]),
  tables: z.array(expectedTableSchema).default([]),
});

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const fixtureRoot = arguments_[0] ?? "test/fixtures/parser";
const revision = arguments_[1] ?? "local";

const clean = (value: string | undefined): string | undefined =>
  value?.replace(/\s+/gu, " ").trim() || undefined;

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

let requiredTextFound = 0;
let requiredTextExpected = 0;
let rejectedTextAbsent = 0;
let rejectedTextExpected = 0;
let metadataExact = 0;
let metadataExpected = 0;
let linkExact = 0;
let linkExpected = 0;
let imageExact = 0;
let imageExpected = 0;
let tableShapeExact = 0;
let tableShapeExpected = 0;
let failures = 0;
const durations: number[] = [];

for (const fixtureName of fixtureNames) {
  const directory = join(resolve(fixtureRoot), fixtureName);
  try {
    const [source, expectedSource] = await Promise.all([
      readFile(join(directory, "source.html"), "utf8"),
      readFile(join(directory, "expected.json"), "utf8"),
    ]);
    const expected = expectedFixtureSchema.parse(JSON.parse(expectedSource));
    const start = performance.now();
    const parsed = parseDocument(source, {
      purpose: "all",
      baseUrl: expected.baseUrl,
      maxOutputChars: 100_000,
    });
    durations.push(performance.now() - start);

    const actualText = parsed.text ?? "";
    for (const required of expected.requiredText) {
      requiredTextExpected += 1;
      if (actualText.includes(required)) requiredTextFound += 1;
    }
    for (const rejected of expected.rejectedText) {
      rejectedTextExpected += 1;
      if (!actualText.includes(rejected)) rejectedTextAbsent += 1;
    }

    const metadataPairs: ReadonlyArray<readonly [string | undefined, string | undefined]> = [
      [parsed.title, expected.metadata.title],
      [parsed.description, expected.metadata.description],
      [parsed.author, expected.metadata.author],
      [parsed.publishedAt, expected.metadata.publishedAt],
      [parsed.canonicalUrl, expected.metadata.canonicalUrl],
    ];
    for (const [actual, expectedValue] of metadataPairs) {
      if (expectedValue === undefined) continue;
      metadataExpected += 1;
      if (clean(actual) === clean(expectedValue)) metadataExact += 1;
    }

    for (const expectedLink of expected.links) {
      linkExpected += 1;
      if (
        parsed.links?.some(
          (link) =>
            link.url === expectedLink.url &&
            clean(link.text) === clean(expectedLink.text) &&
            link.internal === expectedLink.internal,
        ) === true
      ) {
        linkExact += 1;
      }
    }

    for (const expectedImage of expected.images) {
      imageExpected += 1;
      if (
        parsed.images?.some(
          (image) =>
            image.url === expectedImage.url &&
            clean(image.alt) === clean(expectedImage.alt) &&
            clean(image.title) === clean(expectedImage.title),
        ) === true
      ) {
        imageExact += 1;
      }
    }

    for (const expectedTable of expected.tables) {
      tableShapeExpected += 1;
      if (
        parsed.tables?.some(
          (table) =>
            clean(table.caption) === clean(expectedTable.caption) &&
            JSON.stringify(table.headers) === JSON.stringify(expectedTable.headers) &&
            JSON.stringify(table.rows) === JSON.stringify(expectedTable.rows),
        ) === true
      ) {
        tableShapeExact += 1;
      }
    }
  } catch {
    failures += 1;
  }
}

const ratio = (actual: number, expected: number): number =>
  expected === 0 ? 1 : actual / expected;

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
        requiredText: "exact substring match against parsed text",
        rejectedText: "exact substring absence from parsed text",
        metadata: "whitespace-normalized exact match",
        links: "exact URL, text, and internal flag match",
        images: "exact URL, alt, and title match",
        tables: "exact caption, headers, and rows match",
      },
      result: {
        requiredTextFound,
        requiredTextExpected,
        requiredTextRecall: ratio(requiredTextFound, requiredTextExpected),
        rejectedTextAbsent,
        rejectedTextExpected,
        rejectedTextPrecision: ratio(rejectedTextAbsent, rejectedTextExpected),
        metadataExact,
        metadataExpected,
        metadataAccuracy: ratio(metadataExact, metadataExpected),
        linkExact,
        linkExpected,
        linkAccuracy: ratio(linkExact, linkExpected),
        imageExact,
        imageExpected,
        imageAccuracy: ratio(imageExact, imageExpected),
        tableShapeExact,
        tableShapeExpected,
        tableShapeAccuracy: ratio(tableShapeExact, tableShapeExpected),
        medianMs: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        failures,
      },
    },
    null,
    2,
  )}\n`,
);
