import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Request, Response } from "express";

import type { McpRegistryFactory } from "./registry.js";

export const MCP_SERVER_INFO = {
  name: "groundlane",
  version: "0.1.0",
} as const;

export function createMcpHttpHandler(
  registryFactory: McpRegistryFactory,
): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    const registry = await registryFactory();
    const server = new McpServer(MCP_SERVER_INFO);
    // Omitting the session generator selects the SDK's stateless mode.
    const transport = new StreamableHTTPServerTransport();

    try {
      await registry.registerAll(server);
      // SDK 1.29's optional callback declarations conflict under
      // exactOptionalPropertyTypes, though this class implements Transport.
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, request.body as unknown);
    } finally {
      if (server.isConnected()) {
        await server.close();
      }
    }
  };
}
