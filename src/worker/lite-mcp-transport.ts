import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS } from "../mcp/server.js";
import type { McpRegistryFactory, McpRequestContext } from "../mcp/registry.js";

export async function handleLiteMcpRequest(
  request: Request,
  registryFactory: McpRegistryFactory,
  context: McpRequestContext,
): Promise<Response> {
  const registry = await registryFactory(context);
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: MCP_SERVER_INSTRUCTIONS,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await registry.registerAll(server);
  await server.connect(transport);
  return await transport.handleRequest(request);
}
