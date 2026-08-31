import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProviderBalanceResult } from "../core/contracts.js";
import { SEARCH_PROVIDER_IDS } from "../core/search-provider-catalog.js";
import type { ProviderBalanceRegistry } from "../core/provider-balance.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const providerBalanceInputSchema = z.object({
  provider: z.enum(["all", ...SEARCH_PROVIDER_IDS]).default("all"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
});

const providerBalanceResultSchema = z.object({
  provider: z.string(),
  configured: z.boolean(),
  status: z.enum(["available", "not_configured", "unsupported", "unknown"]),
  source: z.enum(["api", "configuration", "not_configured", "not_implemented"]),
  balance: z.number().optional(),
  currency: z.string().optional(),
  unit: z.enum(["credits", "cents", "requests"]).optional(),
  warnings: z.array(z.string()),
});

const providerBalanceDataSchema = z.object({
  checkedAt: z.string(),
  results: z.array(providerBalanceResultSchema),
});

export interface ProviderBalanceModuleOptions {
  registry: ProviderBalanceRegistry;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
}

function unknownResult(
  provider: string,
  error: unknown,
): ProviderBalanceResult {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Provider balance check failed";
  return {
    provider,
    configured: true,
    status: "unknown",
    source: "api",
    warnings: [message],
  };
}

export function createProviderBalanceModule(options: ProviderBalanceModuleOptions): McpModule {
  return {
    name: "provider_balance",
    register(server: McpServer): void {
      server.registerTool(
        "provider_balance",
        {
          description:
            "Return sanitized provider account-balance diagnostics for providers with official balance APIs.",
          inputSchema: providerBalanceInputSchema,
          outputSchema: resultEnvelopeSchema(providerBalanceDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const providers =
              input.provider === "all" ? options.registry.providers() : [input.provider];
            const results = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  async (signal) => {
                    const items = await Promise.all(providers.map(async (provider) => {
                      try {
                        return await options.registry.getBalance(provider, signal);
                      } catch (error) {
                        return unknownResult(provider, error);
                      }
                    }));
                    return items;
                  },
                  deadline,
                  extra.signal,
                  "provider_balance",
                ),
            );
            return structuredToolResult({
              ok: true,
              data: { checkedAt: new Date().toISOString(), results },
            });
          } catch (error) {
            return toolError(error, { tool: "provider_balance" });
          }
        },
      );
    },
  };
}
