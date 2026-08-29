import assert from "node:assert/strict";
import test from "node:test";

import { FirecrawlBalanceChecker } from "../../src/adapters/balance/firecrawl.js";
import { LinkupBalanceChecker } from "../../src/adapters/balance/linkup.js";
import { SerpApiBalanceChecker } from "../../src/adapters/balance/serpapi.js";
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

void test("Firecrawl balance checker maps remaining credits", async () => {
  let requestedUrl = "";
  let authorization = "";
  const checker = new FirecrawlBalanceChecker({
    apiKey: "firecrawl-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            remainingCredits: 987,
            planCredits: 1000,
            billingPeriodStart: "2026-08-01T00:00:00Z",
            billingPeriodEnd: "2026-08-31T23:59:59Z",
          },
        }),
      );
    },
  });

  const result = await checker.getBalance(new AbortController().signal);

  assert.equal(requestedUrl, "https://api.firecrawl.dev/v2/team/credit-usage");
  assert.equal(authorization, "Bearer firecrawl-secret");
  assert.deepEqual(result, {
    provider: "firecrawl",
    configured: true,
    status: "available",
    source: "api",
    balance: 987,
    unit: "credits",
    warnings: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /firecrawl-secret|billingPeriod/u);
});

void test("Firecrawl balance checker reports not configured without a key", async () => {
  const result = await new FirecrawlBalanceChecker().getBalance(new AbortController().signal);

  assert.equal(result.provider, "firecrawl");
  assert.equal(result.configured, false);
  assert.equal(result.status, "not_configured");
  assert.equal(result.source, "not_configured");
  assert.match(result.warnings[0] ?? "", /FIRECRAWL_API_KEY/u);
});

void test("SerpApi balance checker maps remaining searches", async () => {
  let requestedUrl = "";
  const checker = new SerpApiBalanceChecker({
    apiKey: "serpapi-secret",
    fetch: (url) => {
      requestedUrl = url;
      return Promise.resolve(
        Response.json({
          account_id: "account-id",
          api_key: "serpapi-secret",
          account_email: "owner@example.com",
          total_searches_left: 5958,
          plan_searches_left: 5958,
          extra_credits: 0,
          account_rate_limit_per_hour: 6000,
        }),
      );
    },
  });

  const result = await checker.getBalance(new AbortController().signal);
  const url = new URL(requestedUrl);

  assert.equal(url.origin + url.pathname, "https://serpapi.com/account.json");
  assert.equal(url.searchParams.get("api_key"), "serpapi-secret");
  assert.deepEqual(result, {
    provider: "serpapi",
    configured: true,
    status: "available",
    source: "api",
    balance: 5958,
    unit: "requests",
    warnings: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /serpapi-secret|owner@example.com|account-id/u);
});

void test("SerpApi balance checker reports not configured without a key", async () => {
  const result = await new SerpApiBalanceChecker().getBalance(new AbortController().signal);

  assert.equal(result.provider, "serpapi");
  assert.equal(result.configured, false);
  assert.equal(result.status, "not_configured");
  assert.equal(result.source, "not_configured");
  assert.match(result.warnings[0] ?? "", /SERPAPI_API_KEY/u);
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
