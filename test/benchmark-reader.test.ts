import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

void test("Reader benchmark produces machine-readable metrics for a fixture corpus", async () => {
  const root = await mkdtemp(join(tmpdir(), "groundlane-reader-benchmark-"));
  const fixture = join(root, "fixture");
  await mkdir(fixture);
  const article = `<html><head><title>Fixture</title></head><body><article>
    <h1>Fixture</h1><p>This fixture contains a sufficiently long article paragraph for Reader extraction.</p>
  </article></body></html>`;
  await Promise.all([
    writeFile(join(fixture, "source.html"), article),
    writeFile(join(fixture, "expected.html"), "<h1>Fixture</h1><p>This fixture contains a sufficiently long article paragraph for Reader extraction.</p>"),
    writeFile(join(fixture, "expected-metadata.json"), JSON.stringify({
      title: "Fixture",
      byline: null,
      excerpt: null,
      publishedTime: null,
    })),
  ]);

  try {
    const output = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/benchmark-reader.mts", "--", root, "test-revision"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const parsed: unknown = JSON.parse(output);
    assert.ok(typeof parsed === "object" && parsed !== null && "result" in parsed);
    const result = Reflect.get(parsed, "result");
    assert.ok(typeof result === "object" && result !== null);
    assert.equal(Reflect.get(result, "precision"), 10 / 11);
    assert.equal(Reflect.get(result, "recall"), 10 / 11);
    assert.equal(Reflect.get(result, "metadataExact"), 1);
    assert.equal(Reflect.get(result, "metadataExpected"), 1);
    assert.equal(Reflect.get(result, "failures"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
