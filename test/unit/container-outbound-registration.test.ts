import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

void test("actual ES2022 GroundlaneContainer class registers outbound hosts through the SDK setter", async () => {
  const source = await readFile(new URL("../../src/worker/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const container = parsed.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === "GroundlaneContainer");
  assert.ok(container);
  const declaration = ts.factory.updateClassDeclaration(container,
    container.modifiers?.filter((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword),
    container.name, container.typeParameters, container.heritageClauses, container.members);
  const emitted = ts.transpileModule(ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, useDefineForClassFields: true },
  }).outputText;

  // Mirrors @cloudflare/containers 0.3.7's inherited accessor/registry boundary.
  // Evaluate the actual project class rather than constructing it: no container,
  // environment secrets, or Cloudflare runtime are needed for registration.
  const registry = new Map<string, Record<string, unknown>>();
  class Container {
    static get outboundByHost(): Record<string, unknown> | undefined { return registry.get(this.name); }
    static set outboundByHost(handlers: Record<string, unknown>) { registry.set(this.name, handlers); }
  }
  const cacheHandler = (): void => undefined;
  const outputHandler = (): void => undefined;
  runInNewContext(emitted, {
    Container,
    DOCUMENT_CACHE_BRIDGE_HOST: "groundlane-cache.internal",
    DOCUMENT_OUTPUT_HOST: "groundlane-output.internal",
    handleDocumentCacheOutbound: cacheHandler,
    handleDocumentOutputOutbound: outputHandler,
  }, { timeout: 1_000 });
  const handlers = registry.get("GroundlaneContainer");
  assert.ok(handlers, "class evaluation must call the SDK registration setter");
  assert.equal(handlers["groundlane-cache.internal"], cacheHandler);
  assert.equal(handlers["groundlane-output.internal"], outputHandler);
});
