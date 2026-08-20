import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import {
  hasValidBearerToken,
  parseBearerToken,
  timingSafeTokenEqual,
  type TimingSafeSubtleCrypto,
} from "../../src/worker/auth.js";

const subtle: TimingSafeSubtleCrypto = {
  digest(algorithm, data) {
    return crypto.subtle.digest(algorithm, data);
  },
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ) {
    return timingSafeEqual(
      left instanceof ArrayBuffer
        ? new Uint8Array(left)
        : new Uint8Array(left.buffer, left.byteOffset, left.byteLength),
      right instanceof ArrayBuffer
        ? new Uint8Array(right)
        : new Uint8Array(right.buffer, right.byteOffset, right.byteLength),
    );
  },
};

void test("bearer parser accepts exactly one bearer credential", () => {
  assert.equal(parseBearerToken("Bearer secret"), "secret");
  assert.equal(parseBearerToken("bearer secret"), "secret");
  assert.equal(parseBearerToken("Basic secret"), undefined);
  assert.equal(parseBearerToken("Bearer secret extra"), undefined);
  assert.equal(parseBearerToken(null), undefined);
});

void test("token comparison hashes both values before timing-safe comparison", async () => {
  assert.equal(await timingSafeTokenEqual("secret", "secret", subtle), true);
  assert.equal(await timingSafeTokenEqual("short", "much-longer", subtle), false);
  assert.equal(await hasValidBearerToken("Bearer secret", "secret", subtle), true);
  assert.equal(await hasValidBearerToken(null, "secret", subtle), false);
});
