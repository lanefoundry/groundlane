import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SearchProviderId } from "../core/contracts.js";
import type { SearchBudgetSnapshot, SearchBudgetTracker } from "../core/search-budget.js";
import { SEARCH_PROVIDER_IDS } from "../core/search-provider-catalog.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError } from "./common.js";

export const searchBudgetStatusInputSchema = z.object({
  provider: z.enum(["all", ...SEARCH_PROVIDER_IDS]).default("all"),
});

const searchBudgetSnapshotSchema = z.object({
  period: z.enum(["monthly", "daily", "minute"]),
  provider: z.string(),
  limited: z.boolean(),
  limit: z.number().int().nonnegative().optional(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative().optional(),
  exhausted: z.boolean(),
  resetAt: z.string().optional(),
});

const searchBudgetStatusDataSchema = z.object({
  checkedAt: z.string(),
  scope: z.literal("instance"),
  note: z.string(),
  budgets: z.array(searchBudgetSnapshotSchema),
});

export interface SearchBudgetStatusModuleOptions {
  budget: SearchBudgetTracker;
}

function snapshotsFor(
  budget: SearchBudgetTracker,
  providers: readonly SearchProviderId[],
): readonly SearchBudgetSnapshot[] {
  return budget.snapshots?.(providers) ?? providers.map((provider) => ({
    period: "monthly",
    provider,
    limited: false,
    used: 0,
    exhausted: false,
  }));
}

export function createSearchBudgetStatusModule(
  options: SearchBudgetStatusModuleOptions,
): McpModule {
  return {
    name: "search_budget_status",
    register(server: McpServer): void {
      server.registerTool(
        "search_budget_status",
        {
          description:
            "Return instance-local search attempt budget status for automatic provider routing.",
          inputSchema: searchBudgetStatusInputSchema,
          outputSchema: resultEnvelopeSchema(searchBudgetStatusDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        (input) => {
          try {
            const providers = input.provider === "all" ? SEARCH_PROVIDER_IDS : [input.provider];
            return structuredToolResult({
              ok: true,
              data: {
                checkedAt: new Date().toISOString(),
                scope: "instance",
                note:
                  "These are Groundlane in-memory attempt guardrails, not provider billing balances. Restarts and horizontal instances do not share counters.",
                budgets: snapshotsFor(options.budget, providers),
              },
            });
          } catch (error) {
            return toolError(error);
          }
        },
      );
    },
  };
}
