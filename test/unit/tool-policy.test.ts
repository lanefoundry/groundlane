import assert from "node:assert/strict";
import test from "node:test";

import { createToolPolicyModule } from "../../src/tools/tool-policy.js";

void test("tool_policy module has correct name", () => {
  const module = createToolPolicyModule();
  assert.equal(module.name, "tool_policy");
});

void test("tool_policy module register is a function", () => {
  const module = createToolPolicyModule();
  assert.equal(typeof module.register, "function");
});
