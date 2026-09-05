import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createGroundlaneServices } from "../../src/composition.js";
import { parseConfig } from "../../src/config.js";
import { createContainerApp } from "../../src/container/app.js";

void test("operator smoke exact inventory matches the default production composition", async () => {
  // Keep the operator's independent exact-list assertion: do not derive its
  // expectation from the server under test and silently accept missing tools.
  const source = await readFile(new URL("../../scripts/smoke.mjs", import.meta.url), "utf8");
  const declaration = /assert\.deepEqual\(names, \[([\s\S]*?)\]\);/u.exec(source);
  assert.ok(declaration, "smoke must retain an explicit exact inventory assertion");
  const body = declaration[1];
  assert.equal(typeof body, "string");
  assert.ok(body !== undefined);
  const expected = [...body.matchAll(/"([a-z_]+)"/gu)].map(match => match[1]);
  assert.ok(expected.length > 0);
  const authToken = "smoke-inventory-local-test-token-only";
  const services = createGroundlaneServices(parseConfig({ GROUNDLANE_AUTH_TOKEN: authToken, BROWSER_BACKEND: "disabled" }));
  const server = createServer(createContainerApp({ authToken, registryFactory: services.registryFactory }));
  const client = new Client({ name: "smoke-inventory-regression", version: "1" });
  try {
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(address.port)}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), expected);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    await services.close();
  }
});
