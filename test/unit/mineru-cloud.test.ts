import assert from "node:assert/strict";
import test from "node:test";

import { MineruCloudProvider } from "../../src/adapters/document/mineru-cloud.js";

void test("MineruCloudProvider rejects empty API key", () => {
  assert.throws(
    () => new MineruCloudProvider({ apiKey: "" }),
    { message: /requires a valid API key/u },
  );
});

void test("MineruCloudProvider rejects API key with newlines", () => {
  assert.throws(
    () => new MineruCloudProvider({ apiKey: "key\nwith\nnewlines" }),
    { message: /requires a valid API key/u },
  );
});

void test("MineruCloudProvider rejects empty source", async () => {
  const provider = new MineruCloudProvider({ apiKey: "test-key" });
  await assert.rejects(
    () => provider.parse(new Uint8Array(0), "application/pdf", "test.pdf", AbortSignal.timeout(5_000)),
    { message: /Empty source/u },
  );
});

void test("MineruCloudProvider rejects oversized source", async () => {
  const provider = new MineruCloudProvider({ apiKey: "test-key", maxBytes: 100 });
  const bytes = new Uint8Array(200);
  await assert.rejects(
    () => provider.parse(bytes, "application/pdf", "big.pdf", AbortSignal.timeout(5_000)),
    { message: /exceeds the 100 byte limit/u },
  );
});

void test("MineruCloudProvider has correct providerId", () => {
  const provider = new MineruCloudProvider({ apiKey: "test-key" });
  assert.equal(provider.providerId, "mineru-cloud");
});

void test("MineruCloudProvider handles upstream connection failure", async () => {
  const provider = new MineruCloudProvider({
    apiKey: "test-key",
    timeoutMs: 500,
  });
  const bytes = new Uint8Array([1, 2, 3]);
  await assert.rejects(
    () => provider.parse(bytes, "application/pdf", "test.pdf", AbortSignal.timeout(2_000)),
    (error: Error) => {
      return error.message.includes("request failed") ||
        error.message.includes("rate limit") ||
        error.message.includes("API key is invalid") ||
        error.message.includes("returned HTTP");
    },
  );
});
