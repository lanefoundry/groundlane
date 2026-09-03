import assert from "node:assert/strict";
import test from "node:test";

import {
  filterCustomProviderBindings,
  isCustomProviderBinding,
  providerSecretBindingName,
  ScopedSecretAccessor,
} from "../../src/core/provider-secret-scope.js";

// ---------------------------------------------------------------------------
// PRD 620: Scoped secret accessor — custom provider secret isolation
// ---------------------------------------------------------------------------

void test("PRD 620: providerSecretBindingName derives correct binding for custom.acme", () => {
  assert.equal(
    providerSecretBindingName("custom.acme"),
    "GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN",
  );
});

void test("PRD 620: providerSecretBindingName handles hyphens", () => {
  assert.equal(
    providerSecretBindingName("custom.my-search"),
    "GROUNDLANE_CUSTOM_PROVIDER_MY_SEARCH_TOKEN",
  );
});

void test("PRD 620: providerSecretBindingName rejects non-custom IDs", () => {
  assert.throws(
    () => providerSecretBindingName("tavily"),
    { message: /not a custom provider/ },
  );
});

void test("PRD 620: ScopedSecretAccessor returns own provider token", () => {
  const bindings = {
    GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN: "secret-acme-123",
    GROUNDLANE_CUSTOM_PROVIDER_OTHER_TOKEN: "secret-other-456",
  };
  const accessor = new ScopedSecretAccessor("custom.acme", bindings);
  assert.equal(accessor.getSecret(), "secret-acme-123");
});

void test("PRD 620: ScopedSecretAccessor cannot read another custom provider's token", () => {
  const bindings = {
    GROUNDLANE_CUSTOM_PROVIDER_OTHER_TOKEN: "secret-other-456",
  };
  const accessor = new ScopedSecretAccessor("custom.acme", bindings);
  assert.equal(accessor.getSecret(), undefined);
});

void test("PRD 620: ScopedSecretAccessor returns undefined when no token configured", () => {
  const accessor = new ScopedSecretAccessor("custom.acme", {});
  assert.equal(accessor.getSecret(), undefined);
});

void test("PRD 620: ScopedSecretAccessor reports its binding name", () => {
  const accessor = new ScopedSecretAccessor("custom.my-search", {});
  assert.equal(accessor.getBindingName(), "GROUNDLANE_CUSTOM_PROVIDER_MY_SEARCH_TOKEN");
});

void test("PRD 620: validateBindings rejects GROUNDLANE_AUTH_TOKEN", () => {
  assert.throws(
    () => ScopedSecretAccessor.validateBindings({
      GROUNDLANE_AUTH_TOKEN: "admin-secret",
    }),
    { message: /protected secret/ },
  );
});

void test("PRD 620: validateBindings rejects built-in provider API keys", () => {
  const builtInKeys = [
    "TAVILY_API_KEY",
    "EXA_API_KEY",
    "BRAVE_API_KEY",
    "FIRECRAWL_API_KEY",
    "SERPAPI_API_KEY",
    "SEARCHAPI_API_KEY",
    "BROWSERBASE_API_KEY",
    "PARALLEL_API_KEY",
    "LINKUP_API_KEY",
    "KEENABLE_API_KEY",
    "TINYFISH_API_KEY",
    "SERPER_API_KEY",
    "YOU_API_KEY",
  ];
  for (const key of builtInKeys) {
    assert.throws(
      () => ScopedSecretAccessor.validateBindings({ [key]: "leaked" }),
      { message: /protected secret/ },
      `should reject ${key}`,
    );
  }
});

void test("PRD 620: validateBindings rejects BROWSERLESS_TOKEN", () => {
  assert.throws(
    () => ScopedSecretAccessor.validateBindings({
      BROWSERLESS_TOKEN: "browser-secret",
    }),
    { message: /protected secret/ },
  );
});

void test("PRD 620: validateBindings rejects arbitrary env entries", () => {
  assert.throws(
    () => ScopedSecretAccessor.validateBindings({
      HOME: "/root",
    }),
    { message: /not a recognized custom provider token binding/ },
  );
});

void test("PRD 620: validateBindings accepts valid custom provider tokens", () => {
  assert.doesNotThrow(() => {
    ScopedSecretAccessor.validateBindings({
      GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN: "valid-secret",
      GROUNDLANE_CUSTOM_PROVIDER_MY_SEARCH_TOKEN: "also-valid",
    });
  });
});

void test("PRD 620: validateBindings accepts empty bindings", () => {
  assert.doesNotThrow(() => {
    ScopedSecretAccessor.validateBindings({});
  });
});

void test("PRD 620: filterCustomProviderBindings strips non-custom entries", () => {
  const bindings = {
    GROUNDLANE_AUTH_TOKEN: "admin",
    TAVILY_API_KEY: "tavily-key",
    BROWSERLESS_TOKEN: "browser-key",
    GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN: "acme-secret",
    GROUNDLANE_CUSTOM_PROVIDER_BETA_TOKEN: "beta-secret",
    HOME: "/root",
    PATH: "/usr/bin",
  };
  const filtered = filterCustomProviderBindings(bindings);
  assert.deepEqual(Object.keys(filtered).sort(), [
    "GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN",
    "GROUNDLANE_CUSTOM_PROVIDER_BETA_TOKEN",
  ]);
  assert.equal(filtered["GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN"], "acme-secret");
  assert.equal(filtered["GROUNDLANE_CUSTOM_PROVIDER_BETA_TOKEN"], "beta-secret");
});

void test("PRD 620: filterCustomProviderBindings returns empty for no custom tokens", () => {
  const bindings = {
    GROUNDLANE_AUTH_TOKEN: "admin",
    TAVILY_API_KEY: "key",
  };
  const filtered = filterCustomProviderBindings(bindings);
  assert.deepEqual(filtered, {});
});

void test("PRD 620: isCustomProviderBinding recognizes valid patterns", () => {
  assert.equal(isCustomProviderBinding("GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN"), true);
  assert.equal(isCustomProviderBinding("GROUNDLANE_CUSTOM_PROVIDER_MY_SEARCH_TOKEN"), true);
});

void test("PRD 620: isCustomProviderBinding rejects non-matching patterns", () => {
  assert.equal(isCustomProviderBinding("GROUNDLANE_AUTH_TOKEN"), false);
  assert.equal(isCustomProviderBinding("TAVILY_API_KEY"), false);
  assert.equal(isCustomProviderBinding("RANDOM_ENV_VAR"), false);
  assert.equal(isCustomProviderBinding("GROUNDLANE_CUSTOM_PROVIDER_TOKEN"), false);
});

void test("PRD 620: ScopedSecretAccessor does not expose process.env", () => {
  const envSnapshot = { ...process.env } as Record<string, string | undefined>;
  const accessor = new ScopedSecretAccessor("custom.acme", envSnapshot);
  assert.equal(accessor.getSecret(), undefined);
  assert.equal(accessor.getBindingName(), "GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN");
});

void test("PRD 620: ScopedSecretAccessor with filtered bindings only sees own token", () => {
  const rawBindings = {
    GROUNDLANE_AUTH_TOKEN: "admin-secret",
    TAVILY_API_KEY: "tavily-key",
    GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN: "acme-token",
    GROUNDLANE_CUSTOM_PROVIDER_BETA_TOKEN: "beta-token",
  };
  const safe = filterCustomProviderBindings(rawBindings);
  const acmeAccessor = new ScopedSecretAccessor("custom.acme", safe);
  const betaAccessor = new ScopedSecretAccessor("custom.beta", safe);

  assert.equal(acmeAccessor.getSecret(), "acme-token");
  assert.equal(betaAccessor.getSecret(), "beta-token");

  assert.equal(safe["GROUNDLANE_AUTH_TOKEN" as keyof typeof safe], undefined);
  assert.equal(safe["TAVILY_API_KEY" as keyof typeof safe], undefined);
});
