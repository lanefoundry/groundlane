import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderBalanceChecker } from "../../src/core/contracts.js";
import { ProviderBalanceRegistry } from "../../src/core/provider-balance.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createProviderBalanceModule } from "../../src/tools/provider-balance.js";
import { createProviderCapabilitiesModule } from "../../src/tools/provider-capabilities.js";

type RegisteredHandler = (input: { provider?: string; timeoutMs?: number }, extra: { signal?: AbortSignal }) => Promise<unknown>;

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
