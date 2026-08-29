import assert from "node:assert/strict";
import test from "node:test";

import { LinkupBalanceChecker } from "../../src/adapters/balance/linkup.js";
import { YouBalanceChecker } from "../../src/adapters/balance/you.js";
import { ProviderBalanceRegistry } from "../../src/core/provider-balance.js";

void test("You.com balance checker maps cents without leaking credentials", async () => {
  let requestedUrl = "";
  let apiKey = "";
  const checker = new YouBalanceChecker({
    apiKey: "you-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      return Promise.resolve(
        Response.json({
          data: {
            type: "account",
            id: "hashed-account",
            attributes: { balance: 9992 },
          },
        }),
      );
    },
  });

  const result = await checker.getBalance(new AbortController().signal);

  assert.equal(requestedUrl, "https://api.you.com/v1/billing/account_balance");
  assert.equal(apiKey, "you-secret");
  assert.deepEqual(result, {
    provider: "you",
    configured: true,
    status: "available",
    source: "api",
    balance: 9992,
    currency: "USD",
    unit: "cents",
    warnings: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /you-secret|hashed-account/u);
});

void test("You.com balance checker reports not configured for keyless MCP profile", async () => {
  const result = await new YouBalanceChecker().getBalance(new AbortController().signal);

  assert.equal(result.provider, "you");
  assert.equal(result.configured, false);
  assert.equal(result.status, "not_configured");
  assert.equal(result.source, "not_configured");
  assert.match(result.warnings[0] ?? "", /YOU_API_KEY/u);
});

void test("Linkup balance checker maps credit balance", async () => {
  let requestedUrl = "";
  let authorization = "";
  const checker = new LinkupBalanceChecker({
    apiKey: "linkup-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      return Promise.resolve(Response.json({ balance: 123.456 }));
    },
  });

  const result = await checker.getBalance(new AbortController().signal);

  assert.equal(requestedUrl, "https://api.linkup.so/v1/credits/balance");
  assert.equal(authorization, "Bearer linkup-secret");
  assert.deepEqual(result, {
    provider: "linkup",
    configured: true,
    status: "available",
    source: "api",
    balance: 123.456,
    unit: "credits",
    warnings: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /linkup-secret/u);
});

void test("provider balance registry marks unsupported providers without calling upstream", async () => {
  const registry = new ProviderBalanceRegistry({
    supportedProviders: ["you", "brave"],
    configuredProviders: ["brave"],
    checkers: [new YouBalanceChecker()],
  });

  assert.deepEqual(registry.providers(), ["you", "brave"]);
  const result = await registry.getBalance("brave", new AbortController().signal);

  assert.equal(result.provider, "brave");
  assert.equal(result.status, "unsupported");
  assert.equal(result.source, "not_implemented");
  assert.equal(result.configured, true);
});
