import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import type { ExtractionField } from "../../src/core/contracts.js";
import type { ExtractionLimits } from "../../src/core/extract-fields.js";
import { extractFields } from "../../src/core/extract-fields.js";

const fieldSchema = z.object({
  name: z.string(),
  selector: z.string(),
  value: z.enum(["text", "html", "attribute"]),
  attribute: z.string().optional(),
  many: z.boolean().optional(),
});

const expectedSchema = z.object({
  fields: z.array(fieldSchema),
  limits: z
    .object({
      maxFields: z.number().int().positive(),
      maxValuesPerField: z.number().int().positive(),
      maxOutputChars: z.number().int().positive(),
    })
    .optional(),
  data: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  missingFields: z.array(z.string()),
});

const defaultLimits: ExtractionLimits = {
  maxFields: 50,
  maxValuesPerField: 100,
  maxOutputChars: 10_000,
};

function normalizeFields(fields: readonly z.infer<typeof fieldSchema>[]): ExtractionField[] {
  return fields.map((field) => ({
    name: field.name,
    selector: field.selector,
    value: field.value,
    ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
    ...(field.many === undefined ? {} : { many: field.many }),
  }));
}

void test("extractFields matches selector fixture corpus", async () => {
  const root = "test/fixtures/extract";
  const fixtureNames = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(fixtureNames, ["html-card", "limits", "product-list"]);

  for (const fixtureName of fixtureNames) {
    const directory = join(root, fixtureName);
    const [html, expectedSource] = await Promise.all([
      readFile(join(directory, "source.html"), "utf8"),
      readFile(join(directory, "expected.json"), "utf8"),
    ]);
    const expected = expectedSchema.parse(JSON.parse(expectedSource));
    const result = extractFields(html, normalizeFields(expected.fields), expected.limits ?? defaultLimits);

    assert.deepEqual(result.data, expected.data, fixtureName);
    assert.deepEqual(result.missingFields, expected.missingFields, fixtureName);
    assert.equal(result.truncated, false, fixtureName);
  }
});
