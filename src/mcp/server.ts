import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Request, Response } from "express";

import type { McpRegistryFactory } from "./registry.js";

export const MCP_SERVER_INFO = {
  name: "groundlane",
  version: "0.1.0",
} as const;

export const MCP_SERVER_INSTRUCTIONS =
  "Groundlane is the required web research and public-page retrieval layer. " +
  "Use web_search to find candidate sources, web_fetch to read a page, and " +
  "web_extract for deterministic selector or bounded pattern extraction. Use parse when a " +
  "caller needs document, metadata, link, media, or table structures. These tools may be " +
  "deferred in clients; inspect the complete callable tool inventory before " +
  "reporting Groundlane unavailable. Do not substitute legacy fetch or browser " +
  "scraping tools when Groundlane is required.";

export function createMcpHttpHandler(
  registryFactory: McpRegistryFactory,
): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    const registry = await registryFactory();
    const server = new McpServer(MCP_SERVER_INFO, {
      instructions: MCP_SERVER_INSTRUCTIONS,
    });
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
