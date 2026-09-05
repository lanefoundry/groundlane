import assert from "node:assert/strict";
import test from "node:test";

import { validateMcpRoutingHeaders } from "../../src/core/mcp-routing.js";

const VERSION = "2026-07-28";

function body(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "routing-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

void test("modern routing headers must match protocol version and method", () => {
  const request = body("tools/list");
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: VERSION,
    method: "tools/list",
  }, request), undefined);
  assert.equal(validateMcpRoutingHeaders("POST", {
    method: "tools/list",
  }, request)?.cell, "protocol-version-header-missing");
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: "2025-11-25",
    method: "tools/list",
  }, request)?.cell, "header-body-version-mismatch");
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: VERSION,
    method: "resources/list",
  }, request)?.cell, "method-header-mismatch");
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: VERSION,
  }, request)?.cell, "method-header-missing");
});

void test("Mcp-Name mirrors named request bodies including canonical Base64", () => {
  const request = body("tools/call", { name: "工具", arguments: {} });
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: VERSION,
    method: "tools/call",
    name: "=?base64?5bel5YW3?=",
  }, request), undefined);
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: VERSION,
    method: "tools/call",
  }, request)?.cell, "name-header-missing");
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: VERSION,
    method: "tools/call",
    name: "different",
  }, request)?.cell, "name-header-mismatch");
  assert.equal(validateMcpRoutingHeaders("POST", {
    protocolVersion: VERSION,
    method: "tools/call",
    name: "=?base64?not-canonical!?=",
  }, request)?.cell, "name-header-invalid-encoding");
});

void test("Mcp-Name mirrors opaque task IDs for Tasks extension methods", () => {
  for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
    const request = body(method, { taskId: "task_owner-opaque" });
    assert.equal(validateMcpRoutingHeaders("POST", {
      protocolVersion: VERSION,
      method,
      name: "task_owner-opaque",
    }, request), undefined);
    assert.equal(validateMcpRoutingHeaders("POST", {
      protocolVersion: VERSION,
      method,
    }, request)?.cell, "name-header-missing");
    assert.equal(validateMcpRoutingHeaders("POST", {
      protocolVersion: VERSION,
      method,
      name: "provider-task-id",
    }, request)?.cell, "name-header-mismatch");
  }
});

void test("legacy traffic is not forced through modern standard headers", () => {
  assert.equal(validateMcpRoutingHeaders("POST", {}, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy", version: "1" },
    },
  }), undefined);
});
