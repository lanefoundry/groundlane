import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { createGroundlaneServices } from "../../src/composition.js";
import { parseConfig } from "../../src/config.js";
import { createContainerApp } from "../../src/container/app.js";

const token = "document-output-integration-auth-token";

async function start(path: string) {
  const services = createGroundlaneServices(parseConfig({
    GROUNDLANE_AUTH_TOKEN: token, DOCUMENT_ARTIFACT_STATE_PATH: path,
    MAX_OUTPUT_CHARS: "1000", REQUEST_TIMEOUT_MS: "5000",
  }));
  const server = createServer(createContainerApp({ authToken: token, registryFactory: services.registryFactory }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "document-result-composition", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return {
    client,
    async close() {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await services.close();
    },
  };
}

void test("configured MCP stores oversized results, reads chunks after restart, and revokes access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-document-result-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "artifacts.sqlite");
  let service = await start(path);
  t.after(() => service.close());
  const names = (await service.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("document_result_read"));
  assert.ok(names.includes("document_result_delete"));
  const content = "Result across restart. ".repeat(200);
  const result = await service.client.callTool({ name: "document_parse", arguments: {
    source: { kind: "inline", dataBase64: Buffer.from(content).toString("base64"), mimeType: "text/plain", filename: "result.txt" },
    cacheMode: "bypass",
  } });
  const parsed = z.object({ ok: z.literal(true), data: z.object({ outputArtifact: z.object({ refId: z.string(), byteSize: z.number() }) }) }).parse(result.structuredContent);
  assert.ok(JSON.stringify(result.structuredContent).length < 1000);
  const refId = parsed.data.outputArtifact.refId;
  const defaultRead = await service.client.callTool({ name: "document_result_read", arguments: { refId } });
  assert.ok(JSON.stringify(defaultRead.structuredContent).length <= 1000);
  await service.close();
  service = await start(path);
  const chunks: Buffer[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const read = await service.client.callTool({ name: "document_result_read", arguments: { refId, offset, maxBytes: 300 } });
    const chunk = z.object({ ok: z.literal(true), data: z.object({ dataBase64: z.string(), nextOffset: z.number().nullable() }) }).parse(read.structuredContent);
    chunks.push(Buffer.from(chunk.data.dataBase64, "base64"));
    offset = chunk.data.nextOffset;
  }
  assert.equal(Buffer.concat(chunks).byteLength, parsed.data.outputArtifact.byteSize);
  const payload = z.object({ projection: z.object({ content: z.string() }) }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  assert.ok(payload.projection.content.includes("Result across restart."));
  const deleted = await service.client.callTool({ name: "document_result_delete", arguments: { refId } });
  z.object({ ok: z.literal(true), data: z.object({ deleted: z.literal(true), cleanupPending: z.literal(false) }) }).parse(deleted.structuredContent);
  const unavailable = await service.client.callTool({ name: "document_result_read", arguments: { refId } });
  assert.equal(unavailable.isError, true);
});
