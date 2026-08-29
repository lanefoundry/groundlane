import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProviderBalanceResult, SearchProviderId } from "../core/contracts.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { ProviderBalanceRegistry } from "../core/provider-balance.js";
import { providerCapabilities } from "../core/provider-capabilities.js";
import type { SearchBudgetSnapshot, SearchBudgetTracker } from "../core/search-budget.js";
import { SEARCH_PROVIDER_IDS } from "../core/search-provider-catalog.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

export const providerQuotaInputSchema = z.object({
  provider: z.enum(["all", ...SEARCH_PROVIDER_IDS]).default("all"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
});

const accountBalanceSchema = z.object({
  configured: z.boolean(),
  status: z.enum(["available", "not_configured", "unsupported", "unknown"]),
  source: z.enum(["api", "configuration", "not_configured", "not_implemented"]),
  balance: z.number().optional(),
  currency: z.string().optional(),
  unit: z.enum(["credits", "cents", "requests"]).optional(),
  warnings: z.array(z.string()),
});

const budgetSchema = z.object({
  tool: z.literal("web_search"),
  period: z.enum(["monthly", "daily", "minute"]),
  scope: z.literal("instance"),
  source: z.literal("groundlane_local_budget"),
  limited: z.boolean(),
  limit: z.number().int().nonnegative().optional(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative().optional(),
  exhausted: z.boolean(),
  resetAt: z.string().optional(),
});

const searchRoutingSchema = z.object({
  searchCapable: z.boolean(),
  credentialConfigured: z.boolean(),
  keylessSearchCapable: z.boolean(),
  budgetLimited: z.boolean(),
  localBudgetExhausted: z.boolean(),
  nextChecks: z.array(z.string()),
});

const quotaProviderSchema = z.object({
  provider: z.string(),
  accountBalance: accountBalanceSchema,
  toolBudgets: z.array(budgetSchema),
  searchRouting: searchRoutingSchema,
  groundlaneTools: z.array(z.string()),
  filterSupport: z.string(),
  notes: z.array(z.string()),
});

const providerQuotaDataSchema = z.object({
  checkedAt: z.string(),
  note: z.string(),
  providers: z.array(quotaProviderSchema),
});

export interface ProviderQuotaModuleOptions {
  balanceRegistry: ProviderBalanceRegistry;
  budget: SearchBudgetTracker;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
}

function unknownBalance(provider: SearchProviderId, error: unknown): ProviderBalanceResult {
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

function budgetRows(snapshot: SearchBudgetSnapshot) {
  return {
    tool: "web_search" as const,
    period: snapshot.period,
    scope: "instance" as const,
    source: "groundlane_local_budget" as const,
    limited: snapshot.limited,
    ...(snapshot.limit === undefined ? {} : { limit: snapshot.limit }),
    used: snapshot.used,
    ...(snapshot.remaining === undefined ? {} : { remaining: snapshot.remaining }),
    exhausted: snapshot.exhausted,
    ...(snapshot.resetAt === undefined ? {} : { resetAt: snapshot.resetAt }),
  };
}

function isKeylessSearchCapable(provider: SearchProviderId): boolean {
  return provider === "keenable" || provider === "you";
}

function searchRoutingDiagnostics(
  provider: SearchProviderId,
  balance: ProviderBalanceResult,
  budgets: SearchBudgetSnapshot[],
  groundlaneTools: readonly string[],
) {
  const searchCapable = groundlaneTools.includes("web_search");
  const keylessSearchCapable = isKeylessSearchCapable(provider);
  const budgetLimited = budgets.some((snapshot) => snapshot.limited);
  const localBudgetExhausted = budgets.some((snapshot) => snapshot.exhausted);
  const nextChecks: string[] = [];

  if (!searchCapable) {
    nextChecks.push("Provider is not exposed through web_search.");
  }
  if (!balance.configured && !keylessSearchCapable) {
    nextChecks.push("Configure the provider key before web_search routing can use this provider.");
  }
  if (!balance.configured && keylessSearchCapable) {
    nextChecks.push(
      "web_search can use the keyless path; provider_balance may still report not_configured.",
    );
  }
  if (localBudgetExhausted) {
    nextChecks.push("Groundlane's local web_search budget is exhausted for this instance.");
  }
  nextChecks.push("Inspect web_search warnings for request-level selected, attempted, and succeeded providers.");

  return {
    searchCapable,
    credentialConfigured: balance.configured,
    keylessSearchCapable,
    budgetLimited,
    localBudgetExhausted,
    nextChecks,
  };
}

export function createProviderQuotaModule(options: ProviderQuotaModuleOptions): McpModule {
  return {
    name: "provider_quota",
    register(server: McpServer): void {
      server.registerTool(
        "provider_quota",
        {
          description:
            "Return a unified provider quota view: vendor account balance, Groundlane local tool budgets, and exposed capabilities.",
          inputSchema: providerQuotaInputSchema,
          outputSchema: resultEnvelopeSchema(providerQuotaDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const providers = input.provider === "all" ? SEARCH_PROVIDER_IDS : [input.provider];
            const balances = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  async (signal) =>
                    Promise.all(providers.map(async (provider) => {
                      try {
                        return await options.balanceRegistry.getBalance(provider, signal);
                      } catch (error) {
                        return unknownBalance(provider, error);
                      }
                    })),
                  deadline,
                  extra.signal,
                  "provider_quota",
                ),
            );
            const balancesByProvider = new Map(balances.map((balance) => [balance.provider, balance]));
            const budgets = options.budget.snapshots?.(providers) ?? [];
            const capabilities = providerCapabilities(providers);

            return structuredToolResult({
              ok: true,
              data: {
                checkedAt: new Date().toISOString(),
                note:
                  "accountBalance is provider-owned billing data when available; toolBudgets are Groundlane in-memory guardrails for this instance.",
                providers: capabilities.map((capability) => {
                  const balance = balancesByProvider.get(capability.provider) ?? {
                    provider: capability.provider,
                    configured: false,
                    status: "unsupported" as const,
                    source: "not_implemented" as const,
                    warnings: ["Provider does not expose a Groundlane balance checker"],
                  };
                  const providerBudgets = budgets.filter(
                    (snapshot) => snapshot.provider === capability.provider,
                  );
                  return {
                    provider: capability.provider,
                    accountBalance: {
                      configured: balance.configured,
                      status: balance.status,
                      source: balance.source,
                      ...(balance.balance === undefined ? {} : { balance: balance.balance }),
                      ...(balance.currency === undefined ? {} : { currency: balance.currency }),
                      ...(balance.unit === undefined ? {} : { unit: balance.unit }),
                      warnings: balance.warnings,
                    },
                    toolBudgets: providerBudgets.map(budgetRows),
                    searchRouting: searchRoutingDiagnostics(
                      capability.provider,
                      balance,
                      providerBudgets,
                      capability.groundlaneTools,
                    ),
                    groundlaneTools: [...capability.groundlaneTools],
                    filterSupport: capability.filterSupport,
                    notes: [...capability.notes],
                  };
                }),
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
