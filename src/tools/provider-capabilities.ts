import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { providerCapabilities } from "../core/provider-capabilities.js";
import { SEARCH_PROVIDER_IDS } from "../core/search-provider-catalog.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError } from "./common.js";

export const providerCapabilitiesInputSchema = z.object({
  provider: z.enum(["all", ...SEARCH_PROVIDER_IDS]).default("all"),
});

const providerCapabilitySchema = z.object({
  provider: z.string(),
  vendorFeatures: z.array(z.string()),
  groundlaneTools: z.array(z.string()),
  filterSupport: z.string(),
  balanceSupport: z.enum(["api", "dashboard", "not_implemented"]),
  notes: z.array(z.string()),
});

const providerCapabilitiesDataSchema = z.object({
  providers: z.array(providerCapabilitySchema),
});

export function createProviderCapabilitiesModule(): McpModule {
  return {
    name: "provider_capabilities",
    register(server: McpServer): void {
      server.registerTool(
        "provider_capabilities",
        {
          description:
            "List vendor features, Groundlane-exposed tools, filter support, and balance support per provider.",
          inputSchema: providerCapabilitiesInputSchema,
          outputSchema: resultEnvelopeSchema(providerCapabilitiesDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        (input) => {
          try {
            const providers = input.provider === "all" ? SEARCH_PROVIDER_IDS : [input.provider];
            return structuredToolResult({
              ok: true,
              data: { providers: providerCapabilities(providers) },
            });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
