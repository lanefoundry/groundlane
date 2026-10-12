import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createGroundlaneServices } from "../../src/composition.js";
import { parseConfig } from "../../src/config.js";
import { createContainerApp } from "../../src/container/app.js";

async function startGuidanceClient(t: TestContext, storageEnabled: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-agent-guidance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "guidance-integration-auth-token-for-tests";
  const services = createGroundlaneServices(parseConfig({ GROUNDLANE_AUTH_TOKEN: token,
    ...(storageEnabled ? { DOCUMENT_ARTIFACT_STATE_PATH: join(directory, "artifacts.sqlite") } : {}), MAX_OUTPUT_CHARS: "1000" }));
  const server = createServer(createContainerApp({ authToken: token, registryFactory: services.registryFactory }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "document-agent-guidance", version: "1" });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await services.close();
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

void test("oversized parse results tell agents how to read the saved projection", async (t) => {
  const client = await startGuidanceClient(t, true);
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((tool) => tool.name === "web_fetch")?.description ?? "", /PDF.*document_parse/);
  assert.match(tools.find((tool) => tool.name === "web_content")?.description ?? "", /PDF.*document_parse/);
  assert.match(tools.find((tool) => tool.name === "document_parse")?.description ?? "", /document_result_read_text/);
  const result = await client.callTool({ name: "document_parse", arguments: {
    source: { kind: "inline", dataBase64: Buffer.from("Saved projection. ".repeat(200)).toString("base64"), mimeType: "text/plain", filename: "result.txt" }, cacheMode: "bypass",
  } });
  const guidance = z.object({ data: z.object({
    outputArtifact: z.object({ refId: z.string() }),
    nextAction: z.object({ tool: z.literal("document_result_read_text"), arguments: z.object({ refId: z.string(), contentOffset: z.literal(0) }) }),
    instruction: z.string(),
  }) }).parse(result.structuredContent);
  assert.equal(guidance.data.nextAction.arguments.refId, guidance.data.outputArtifact.refId);
  assert.match(guidance.data.instruction, /nextContentOffset/);
  assert.ok(JSON.stringify(result.structuredContent).length < 1000);
});

void test("PDF rejection gives a bounded document_parse URL source template", async (t) => {
  const client = await startGuidanceClient(t, false);
  const url = "https://example.com/lecture.pdf";
  const result = await client.callTool({ name: "web_content", arguments: { url } });
  const error = z.object({ error: z.object({ hint: z.object({ code: z.literal("web_content.binary_url"), text: z.string() }) }) }).parse(result.structuredContent);
  assert.match(error.error.hint.text, /document_parse/);
  assert.ok(error.error.hint.text.includes(JSON.stringify({ source: { kind: "url", url: "<same PDF URL>" } })));
  const longUrl = `https://example.com/lecture.pdf?key=${"x".repeat(1500)}`;
  const bounded = await client.callTool({ name: "web_content", arguments: { url: longUrl } });
  assert.ok(JSON.stringify(bounded.structuredContent).length <= 1000);
  assert.ok(!JSON.stringify(bounded.structuredContent).includes(longUrl));
});

void test("storage-disabled agent guidance offers bounded recovery without unavailable readers", async (t) => {
  const client = await startGuidanceClient(t, false);
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some(tool => tool.name === "document_result_read_text"));
  const description = tools.find(tool => tool.name === "document_parse")?.description ?? "";
  assert.match(description, /storage is unavailable/);
  assert.doesNotMatch(description, /document_result_read_text/);
  const result = await client.callTool({ name: "document_parse", arguments: {
    source: { kind: "inline", dataBase64: Buffer.from("Large projection. ".repeat(200)).toString("base64"), mimeType: "text/plain", filename: "result.txt" }, cacheMode: "bypass",
  } });
  const error = z.object({ error: z.object({ code: z.literal("OUTPUT_LIMIT"), hint: z.object({ text: z.string() }) }) }).parse(result.structuredContent);
  assert.match(error.error.hint.text, /unchanged retries will not help/);
  assert.match(error.error.hint.text, /output=text/);
  assert.doesNotMatch(error.error.hint.text, /document_result_read/);
});
