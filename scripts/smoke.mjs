import assert from "node:assert/strict";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.GROUNDLANE_MCP_URL ?? "http://127.0.0.1:8080/mcp";
const token = process.env.GROUNDLANE_AUTH_TOKEN;

if (!token) {
  throw new Error("GROUNDLANE_AUTH_TOKEN is required");
}

const client = new Client({ name: "groundlane-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["web_extract", "web_fetch", "web_search"]);

  const fetched = await client.callTool({
    name: "web_fetch",
    arguments: {
      url: "https://example.com/",
      format: "markdown",
      render: "never",
    },
  });
  assert.equal(fetched.isError, undefined);
  assert.equal(fetched.structuredContent?.ok, true);

  const extracted = await client.callTool({
    name: "web_extract",
    arguments: {
      url: "https://example.com/",
      render: "never",
      fields: [{ name: "heading", selector: "h1", value: "text" }],
    },
  });
  assert.equal(extracted.isError, undefined);
  assert.equal(extracted.structuredContent?.ok, true);

  if (process.env.GROUNDLANE_SMOKE_BROWSER === "1") {
    const rendered = await client.callTool({
      name: "web_fetch",
      arguments: {
        url: "https://example.com/",
        format: "text",
        render: "always",
      },
    });
    assert.equal(rendered.isError, undefined);
    assert.equal(rendered.structuredContent?.ok, true);
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, endpoint, tools: names }, null, 2)}\n`,
  );
} finally {
  await client.close();
}
