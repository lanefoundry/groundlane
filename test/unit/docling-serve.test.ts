import assert from "node:assert/strict";
import test from "node:test";

import { DoclingServeProvider } from "../../src/adapters/document/docling-serve.js";

void test("DoclingServeProvider rejects empty source", async () => {
  const provider = new DoclingServeProvider({ baseUrl: "http://localhost:5001" });
  await assert.rejects(
    () => provider.parse(new Uint8Array(0), "application/pdf", "test.pdf", AbortSignal.timeout(5_000)),
    { message: /Empty source/u },
  );
});

void test("DoclingServeProvider rejects oversized source", async () => {
  const provider = new DoclingServeProvider({ baseUrl: "http://localhost:5001", maxBytes: 100 });
  const bytes = new Uint8Array(200);
  await assert.rejects(
    () => provider.parse(bytes, "application/pdf", "big.pdf", AbortSignal.timeout(5_000)),
    { message: /exceeds the 100 byte limit/u },
  );
});

void test("DoclingServeProvider rejects invalid base URL", () => {
  assert.throws(
    () => new DoclingServeProvider({ baseUrl: "ftp://bad" }),
    { message: /must use http or https/u },
  );
});

void test("DoclingServeProvider defaults to vlm pipeline", () => {
  const provider = new DoclingServeProvider({ baseUrl: "http://localhost:5001" });
  assert.equal(provider.providerId, "docling-serve");
});

void test("DoclingServeProvider handles upstream failure gracefully", async () => {
  const provider = new DoclingServeProvider({
    baseUrl: "http://127.0.0.1:1",
    timeoutMs: 500,
  });
  const bytes = new Uint8Array([1, 2, 3]);
  await assert.rejects(
    () => provider.parse(bytes, "application/pdf", "test.pdf", AbortSignal.timeout(2_000)),
    { message: /request failed/u },
  );
});
