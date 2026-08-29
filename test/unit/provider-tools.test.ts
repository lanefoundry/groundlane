import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderBalanceChecker } from "../../src/core/contracts.js";
import { ProviderBalanceRegistry } from "../../src/core/provider-balance.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { CompositeSearchBudget, DailySearchBudget, MonthlySearchBudget } from "../../src/core/search-budget.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createProviderBalanceModule } from "../../src/tools/provider-balance.js";
import { createProviderCapabilitiesModule } from "../../src/tools/provider-capabilities.js";
import { createProviderQuotaModule } from "../../src/tools/provider-quota.js";
import { createSearchBudgetStatusModule } from "../../src/tools/search-budget-status.js";

type RegisteredHandler = (input: { provider?: string; timeoutMs?: number }, extra: { signal?: AbortSignal }) => unknown;

function fakeServer() {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    handlers,
    server: {
      registerTool(name: string, _definition: unknown, handler: RegisteredHandler): void {
        handlers.set(name, handler);
      },
    },
  };
}

const checker: ProviderBalanceChecker = {
  id: "you",
  configured: () => true,
  getBalance: () =>
    Promise.resolve({
      provider: "you",
      configured: true,
      status: "available",
      source: "api",
      balance: 9992,
      currency: "USD",
      unit: "cents",
      warnings: [],
    }),
};

void test("provider_balance tool returns sanitized balance diagnostics", async () => {
  const { handlers, server } = fakeServer();
  const registry = new ProviderBalanceRegistry({
    supportedProviders: ["you", "brave"],
    checkers: [checker],
  });
  await createMcpRegistry([
    createProviderBalanceModule({
      registry,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("provider_balance");
  assert.ok(handler);
  const result = await handler({ provider: "all" }, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: { results?: Array<{ provider?: string; balance?: number; status?: string }> };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.results?.[0]?.provider, "you");
  assert.equal(envelope.data?.results?.[0]?.balance, 9992);
  assert.equal(envelope.data?.results?.[1]?.provider, "brave");
  assert.equal(envelope.data?.results?.[1]?.status, "unsupported");
});

void test("provider_balance all fans out to configured providers", async () => {
  const { handlers, server } = fakeServer();
  let active = 0;
  let maxActive = 0;
  const slowChecker = (id: "linkup" | "you"): ProviderBalanceChecker => ({
    id,
    configured: () => true,
    async getBalance(): Promise<Awaited<ReturnType<ProviderBalanceChecker["getBalance"]>>> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        provider: id,
        configured: true,
        status: "available",
        source: "api",
        balance: 1,
        unit: "credits",
        warnings: [],
      };
    },
  });
  const registry = new ProviderBalanceRegistry({
    supportedProviders: ["linkup", "you"],
    checkers: [slowChecker("linkup"), slowChecker("you")],
  });
  await createMcpRegistry([
    createProviderBalanceModule({
      registry,
      limiter: new ConcurrencyLimiter(2, 1),
      requestTimeoutMs: 5_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("provider_balance");
  assert.ok(handler);
  const result = await handler({ provider: "all" }, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: { results?: Array<{ provider?: string }> };
  };

  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data?.results?.map((item) => item.provider), ["linkup", "you"]);
  assert.equal(maxActive, 2);
});

void test("provider_capabilities tool exposes static provider features", async () => {
  const { handlers, server } = fakeServer();
  await createMcpRegistry([createProviderCapabilitiesModule()]).registerAll(server as never);

  const handler = handlers.get("provider_capabilities");
  assert.ok(handler);
  const result = await handler({ provider: "you" }, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: { providers?: Array<{ provider?: string; vendorFeatures?: string[] }> };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.providers?.[0]?.provider, "you");
  assert.ok(envelope.data?.providers?.[0]?.vendorFeatures?.includes("Research"));
});

void test("search_budget_status tool exposes instance-local attempt guardrails", async () => {
  const { handlers, server } = fakeServer();
  const monthly = new MonthlySearchBudget({ you: 3 }, () => new Date("2026-08-24T12:00:00Z"));
  const daily = new DailySearchBudget({ you: 2 }, () => new Date("2026-08-24T12:00:00Z"));
  const budget = new CompositeSearchBudget([monthly, daily]);
  assert.equal(budget.tryConsume("you"), true);
  await createMcpRegistry([createSearchBudgetStatusModule({ budget })]).registerAll(server as never);

  const handler = handlers.get("search_budget_status");
  assert.ok(handler);
  const result = await handler({ provider: "you" }, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: {
      scope?: string;
      budgets?: Array<{
        period?: string;
        provider?: string;
        limited?: boolean;
        limit?: number;
        used?: number;
        remaining?: number;
      }>;
    };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.scope, "instance");
  assert.deepEqual(
    envelope.data?.budgets?.map((item) => ({
      period: item.period,
      provider: item.provider,
      limited: item.limited,
      limit: item.limit,
      used: item.used,
      remaining: item.remaining,
    })),
    [
      { period: "monthly", provider: "you", limited: true, limit: 3, used: 1, remaining: 2 },
      { period: "daily", provider: "you", limited: true, limit: 2, used: 1, remaining: 1 },
    ],
  );
});

void test("provider_quota tool combines account balance, local budgets, and capabilities", async () => {
  const { handlers, server } = fakeServer();
  const registry = new ProviderBalanceRegistry({
    supportedProviders: ["you"],
    checkers: [checker],
  });
  const monthly = new MonthlySearchBudget({ you: 3 }, () => new Date("2026-08-24T12:00:00Z"));
  const daily = new DailySearchBudget({ you: 2 }, () => new Date("2026-08-24T12:00:00Z"));
  const budget = new CompositeSearchBudget([monthly, daily]);
  assert.equal(budget.tryConsume("you"), true);
  await createMcpRegistry([
    createProviderQuotaModule({
      balanceRegistry: registry,
      budget,
      limiter: new ConcurrencyLimiter(1, 1),
      requestTimeoutMs: 5_000,
    }),
  ]).registerAll(server as never);

  const handler = handlers.get("provider_quota");
  assert.ok(handler);
  const result = await handler({ provider: "you" }, {});
  const envelope = (result as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: {
      providers?: Array<{
        provider?: string;
        accountBalance?: { status?: string; balance?: number; unit?: string };
        toolBudgets?: Array<{ tool?: string; period?: string; remaining?: number }>;
        groundlaneTools?: string[];
      }>;
    };
  };

  const provider = envelope.data?.providers?.[0];
  assert.equal(envelope.ok, true);
  assert.equal(provider?.provider, "you");
  assert.equal(provider?.accountBalance?.status, "available");
  assert.equal(provider?.accountBalance?.balance, 9992);
  assert.equal(provider?.accountBalance?.unit, "cents");
  assert.deepEqual(
    provider?.toolBudgets?.map((item) => ({
      tool: item.tool,
      period: item.period,
      remaining: item.remaining,
    })),
    [
      { tool: "web_search", period: "monthly", remaining: 2 },
      { tool: "web_search", period: "daily", remaining: 1 },
    ],
  );
  assert.ok(provider?.groundlaneTools?.includes("provider_quota"));
});
