import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

void test("Parser benchmark produces machine-readable metrics for a fixture corpus", async () => {
  const root = await mkdtemp(join(tmpdir(), "groundlane-parser-benchmark-"));
  const fixture = join(root, "fixture");
  await mkdir(fixture);
  const source = `<html><head>
    <title>Fixture</title>
    <meta name="description" content="Parser benchmark fixture">
    <link rel="canonical" href="https://example.com/fixture">
  </head><body><nav>Noise</nav><main>
    <h1>Fixture</h1>
    <p>Groundlane parses predictable document structures.</p>
    <a href="/docs">Docs</a>
    <img src="/image.png" alt="Diagram">
    <table><tr><th>Name</th></tr><tr><td>Groundlane</td></tr></table>
  </main></body></html>`;
  await Promise.all([
    writeFile(join(fixture, "source.html"), source),
    writeFile(join(fixture, "expected.json"), JSON.stringify({
      baseUrl: "https://example.com/fixture",
      requiredText: ["Groundlane parses predictable document structures."],
      rejectedText: ["Noise"],
      metadata: {
        title: "Fixture",
        description: "Parser benchmark fixture",
        canonicalUrl: "https://example.com/fixture",
      },
      links: [
        {
          url: "https://example.com/docs",
          text: "Docs",
          internal: true,
        },
      ],
      images: [
        {
          url: "https://example.com/image.png",
          alt: "Diagram",
        },
      ],
      tables: [
        {
          headers: ["Name"],
          rows: [["Name"], ["Groundlane"]],
        },
      ],
    })),
  ]);

  try {
    const output = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/benchmark-parser.mts", "--", root, "test-revision"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const parsed: unknown = JSON.parse(output);
    assert.ok(typeof parsed === "object" && parsed !== null && "result" in parsed);
    const result = Reflect.get(parsed, "result");
    assert.ok(typeof result === "object" && result !== null);
    assert.equal(Reflect.get(result, "requiredTextRecall"), 1);
    assert.equal(Reflect.get(result, "rejectedTextPrecision"), 1);
    assert.equal(Reflect.get(result, "metadataAccuracy"), 1);
    assert.equal(Reflect.get(result, "linkAccuracy"), 1);
    assert.equal(Reflect.get(result, "imageAccuracy"), 1);
    assert.equal(Reflect.get(result, "tableShapeAccuracy"), 1);
    assert.equal(Reflect.get(result, "failures"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
