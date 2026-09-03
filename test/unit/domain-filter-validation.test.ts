import assert from "node:assert/strict";
import test from "node:test";
import {
  domainFilterSpec,
  requestFilterMode,
  validateDomainFilters,
  validateDomainFiltersForRequest,
} from "../../src/core/domain-filter-validation.js";
import type { SearchRequest } from "../../src/core/contracts.js";

type FilterRequest = Pick<SearchRequest, "domains" | "excludeDomains" | "timeRange">;

// ---------------------------------------------------------------------------
// requestFilterMode: classifies request into one of five modes
// ---------------------------------------------------------------------------

void test("requestFilterMode returns none when no domains are specified", () => {
  assert.equal(requestFilterMode({}), "none");
  assert.equal(requestFilterMode({ domains: [], excludeDomains: [] }), "none");
});

void test("requestFilterMode returns include-only for include domains", () => {
  assert.equal(requestFilterMode({ domains: ["example.com"] }), "include-only");
});

void test("requestFilterMode returns exclude-only for exclude domains", () => {
  assert.equal(requestFilterMode({ excludeDomains: ["spam.com"] }), "exclude-only");
});

void test("requestFilterMode returns combined for both include and exclude", () => {
  assert.equal(
    requestFilterMode({ domains: ["example.com"], excludeDomains: ["spam.com"] }),
    "combined",
  );
});

void test("requestFilterMode treats empty arrays as none", () => {
  assert.equal(requestFilterMode({ domains: [], excludeDomains: ["spam.com"] }), "exclude-only");
  assert.equal(requestFilterMode({ domains: ["a.com"], excludeDomains: [] }), "include-only");
});

// ---------------------------------------------------------------------------
// domainFilterSpec: returns per-provider capability data
// ---------------------------------------------------------------------------

void test("domainFilterSpec returns known specs for catalog providers", () => {
  assert.equal(domainFilterSpec("tavily").mode, "combined");
  assert.equal(domainFilterSpec("tavily").timeRange, true);

  assert.equal(domainFilterSpec("exa").mode, "include-only");
  assert.equal(domainFilterSpec("exa").timeRange, false);

  assert.equal(domainFilterSpec("browserbase").mode, "none");
  assert.equal(domainFilterSpec("serper").mode, "none");

  assert.equal(domainFilterSpec("you").mode, "include-or-exclude");
  assert.equal(domainFilterSpec("firecrawl").mode, "include-or-exclude");

  assert.equal(domainFilterSpec("keenable").mode, "include-only");
  assert.equal(domainFilterSpec("keenable").maxIncludeDomains, 1);
});

void test("domainFilterSpec returns safe defaults for unknown providers", () => {
  const spec = domainFilterSpec("unknown_provider");
  assert.equal(spec.mode, "none");
  assert.equal(spec.timeRange, false);
});

// ---------------------------------------------------------------------------
// Filter mode: none
// ---------------------------------------------------------------------------

void test("mode none: browserbase rejects include domains", () => {
  const request: FilterRequest = { domains: ["example.com"] };
  assert.throws(
    () => validateDomainFilters(request, "browserbase"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("browserbase") &&
      error.message.includes("include-only"),
  );
});

void test("mode none: serper rejects exclude domains", () => {
  const request: FilterRequest = { excludeDomains: ["spam.com"] };
  assert.throws(
    () => validateDomainFilters(request, "serper"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

void test("mode none: browserbase rejects timeRange", () => {
  const request: FilterRequest = { timeRange: "day" };
  assert.throws(
    () => validateDomainFilters(request, "browserbase"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("time range"),
  );
});

void test("mode none: accepts plain query with no filters", () => {
  assert.doesNotThrow(() => validateDomainFilters({}, "browserbase"));
  assert.doesNotThrow(() => validateDomainFilters({}, "serper"));
});

// ---------------------------------------------------------------------------
// Filter mode: include-only
// ---------------------------------------------------------------------------

void test("mode include-only: exa accepts include domains", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ domains: ["example.com"] }, "exa"),
  );
});

void test("mode include-only: exa rejects exclude domains", () => {
  assert.throws(
    () => validateDomainFilters({ excludeDomains: ["spam.com"] }, "exa"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

void test("mode include-only: exa rejects combined include+exclude", () => {
  assert.throws(
    () =>
      validateDomainFilters(
        { domains: ["example.com"], excludeDomains: ["spam.com"] },
        "exa",
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

// ---------------------------------------------------------------------------
// Filter mode: exclude-only (no current provider is exclude-only, but the
// validation logic is still tested through mode compatibility)
// ---------------------------------------------------------------------------

void test("mode exclude-only: request with exclude-only passes on combined provider", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ excludeDomains: ["spam.com"] }, "tavily"),
  );
});

// ---------------------------------------------------------------------------
// Filter mode: include-or-exclude
// ---------------------------------------------------------------------------

void test("mode include-or-exclude: you accepts include-only", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ domains: ["example.com"] }, "you"),
  );
});

void test("mode include-or-exclude: you accepts exclude-only", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ excludeDomains: ["spam.com"] }, "you"),
  );
});

void test("mode include-or-exclude: you rejects combined include+exclude", () => {
  assert.throws(
    () =>
      validateDomainFilters(
        { domains: ["example.com"], excludeDomains: ["spam.com"] },
        "you",
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("combined"),
  );
});

void test("mode include-or-exclude: firecrawl rejects combined", () => {
  assert.throws(
    () =>
      validateDomainFilters(
        { domains: ["a.com"], excludeDomains: ["b.com"] },
        "firecrawl",
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

// ---------------------------------------------------------------------------
// Filter mode: combined
// ---------------------------------------------------------------------------

void test("mode combined: tavily accepts include+exclude together", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters(
      { domains: ["example.com"], excludeDomains: ["spam.com"] },
      "tavily",
    ),
  );
});

void test("mode combined: linkup accepts include-only subset", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ domains: ["example.com"] }, "linkup"),
  );
});

void test("mode combined: brave accepts exclude-only subset", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ excludeDomains: ["spam.com"] }, "brave"),
  );
});

// ---------------------------------------------------------------------------
// maxDomains enforcement
// ---------------------------------------------------------------------------

void test("maxDomains: keenable rejects two include domains", () => {
  assert.throws(
    () =>
      validateDomainFilters(
        { domains: ["a.com", "b.com"] },
        "keenable",
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("at most 1"),
  );
});

void test("maxDomains: keenable accepts exactly one include domain", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ domains: ["a.com"] }, "keenable"),
  );
});

void test("maxDomains: provider without limit accepts many domains", () => {
  const manyDomains = Array.from({ length: 20 }, (_, i) => `d${i}.com`);
  assert.doesNotThrow(() =>
    validateDomainFilters({ domains: manyDomains }, "tavily"),
  );
});

// ---------------------------------------------------------------------------
// timeRange support
// ---------------------------------------------------------------------------

void test("timeRange: exa rejects timeRange", () => {
  assert.throws(
    () => validateDomainFilters({ timeRange: "week" }, "exa"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("time range"),
  );
});

void test("timeRange: firecrawl rejects timeRange", () => {
  assert.throws(
    () => validateDomainFilters({ timeRange: "day" }, "firecrawl"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

void test("timeRange: searchapi rejects timeRange", () => {
  assert.throws(
    () => validateDomainFilters({ timeRange: "month" }, "searchapi"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

void test("timeRange: tavily accepts timeRange", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ timeRange: "week" }, "tavily"),
  );
});

void test("timeRange: linkup accepts timeRange", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters({ timeRange: "year" }, "linkup"),
  );
});

// ---------------------------------------------------------------------------
// Deployment cap precedence
// ---------------------------------------------------------------------------

void test("deployment cap rejects before provider-specific checks", () => {
  // tavily supports combined, but deployment cap of 2 rejects 3 total domains.
  assert.throws(
    () =>
      validateDomainFilters(
        { domains: ["a.com", "b.com"], excludeDomains: ["c.com"] },
        "tavily",
        { deploymentMaxDomains: 2 },
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("deployment limit"),
  );
});

void test("deployment cap allows requests within the limit", () => {
  assert.doesNotThrow(() =>
    validateDomainFilters(
      { domains: ["a.com"], excludeDomains: ["b.com"] },
      "tavily",
      { deploymentMaxDomains: 5 },
    ),
  );
});

void test("deployment cap takes precedence over provider mode errors", () => {
  // browserbase does not support domains at all, but deployment cap fires first.
  assert.throws(
    () =>
      validateDomainFilters(
        { domains: ["a.com", "b.com", "c.com"] },
        "browserbase",
        { deploymentMaxDomains: 2 },
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("deployment limit"),
  );
});

void test("deployment cap precedence in validateDomainFiltersForRequest", () => {
  // Even though tavily supports all these, the deployment cap rejects first.
  assert.throws(
    () =>
      validateDomainFiltersForRequest(
        { domains: ["a.com", "b.com", "c.com"] },
        undefined,
        ["tavily", "brave"],
        { deploymentMaxDomains: 2 },
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("deployment limit"),
  );
});

// ---------------------------------------------------------------------------
// validateDomainFiltersForRequest: multi-provider scenarios
// ---------------------------------------------------------------------------

void test("auto-routing: passes when at least one candidate supports the combination", () => {
  // Combined include+exclude: only tavily/brave/etc. support it, not exa or you.
  assert.doesNotThrow(() =>
    validateDomainFiltersForRequest(
      { domains: ["a.com"], excludeDomains: ["b.com"] },
      undefined,
      ["exa", "you", "tavily"],
    ),
  );
});

void test("auto-routing: rejects when no candidate supports the combination", () => {
  // Combined include+exclude with only exa and you available.
  assert.throws(
    () =>
      validateDomainFiltersForRequest(
        { domains: ["a.com"], excludeDomains: ["b.com"] },
        undefined,
        ["exa", "you"],
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("No candidate provider"),
  );
});

void test("auto-routing: rejects timeRange when no candidate supports it", () => {
  assert.throws(
    () =>
      validateDomainFiltersForRequest(
        { timeRange: "week" },
        undefined,
        ["exa", "firecrawl", "searchapi"],
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

void test("auto-routing: passes timeRange when at least one candidate supports it", () => {
  assert.doesNotThrow(() =>
    validateDomainFiltersForRequest(
      { timeRange: "day" },
      undefined,
      ["exa", "tavily"],
    ),
  );
});

void test("auto-routing: skips validation for plain queries without filters", () => {
  assert.doesNotThrow(() =>
    validateDomainFiltersForRequest({}, undefined, ["browserbase", "serper"]),
  );
});

void test("auto-routing: considers maxDomains in candidate matching", () => {
  // Only keenable available, but request has 2 include domains.
  assert.throws(
    () =>
      validateDomainFiltersForRequest(
        { domains: ["a.com", "b.com"] },
        undefined,
        ["keenable"],
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT",
  );
});

void test("explicit provider: validates strictly against that provider", () => {
  // Exa does not support exclude domains.
  assert.throws(
    () =>
      validateDomainFiltersForRequest(
        { excludeDomains: ["spam.com"] },
        "exa",
        ["exa", "tavily"],
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_INPUT" &&
      error.message.includes("exa"),
  );
});

void test("explicit provider: passes when the provider supports the filters", () => {
  assert.doesNotThrow(() =>
    validateDomainFiltersForRequest(
      { domains: ["a.com"], excludeDomains: ["b.com"], timeRange: "week" },
      "tavily",
      ["tavily"],
    ),
  );
});

// ---------------------------------------------------------------------------
// Unsupported combination rejection (comprehensive)
// ---------------------------------------------------------------------------

void test("unsupported: combined domains on include-or-exclude provider", () => {
  for (const provider of ["you", "firecrawl"] as const) {
    assert.throws(
      () =>
        validateDomainFilters(
          { domains: ["a.com"], excludeDomains: ["b.com"] },
          provider,
        ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "INVALID_INPUT",
      `Expected ${provider} to reject combined domains`,
    );
  }
});

void test("unsupported: any domain filter on none-mode providers", () => {
  for (const provider of ["browserbase", "serper"] as const) {
    assert.throws(
      () => validateDomainFilters({ domains: ["a.com"] }, provider),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "INVALID_INPUT",
      `Expected ${provider} to reject include domains`,
    );
    assert.throws(
      () => validateDomainFilters({ excludeDomains: ["a.com"] }, provider),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "INVALID_INPUT",
      `Expected ${provider} to reject exclude domains`,
    );
  }
});

void test("unsupported: exclude domains on include-only providers", () => {
  for (const provider of ["exa", "keenable"] as const) {
    assert.throws(
      () => validateDomainFilters({ excludeDomains: ["a.com"] }, provider),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "INVALID_INPUT",
      `Expected ${provider} to reject exclude domains`,
    );
  }
});

void test("unsupported: timeRange on providers that lack date range support", () => {
  for (const provider of ["exa", "firecrawl", "searchapi", "parallel", "browserbase", "serper"] as const) {
    assert.throws(
      () => validateDomainFilters({ timeRange: "day" }, provider),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "INVALID_INPUT",
      `Expected ${provider} to reject timeRange`,
    );
  }
});

// ---------------------------------------------------------------------------
// Error metadata
// ---------------------------------------------------------------------------

void test("errors carry the domain-filter stage and INVALID_INPUT code", () => {
  try {
    validateDomainFilters({ domains: ["a.com"] }, "browserbase");
    assert.fail("Expected an error");
  } catch (error: unknown) {
    assert.equal((error as { code: string }).code, "INVALID_INPUT");
    assert.equal((error as { stage: string }).stage, "domain-filter");
    assert.equal((error as { retryable: boolean }).retryable, false);
    assert.ok((error as { hint?: { code: string } }).hint?.code);
  }
});

void test("deployment cap error includes hint with deployment_cap code", () => {
  try {
    validateDomainFilters(
      { domains: ["a.com", "b.com", "c.com"] },
      "tavily",
      { deploymentMaxDomains: 2 },
    );
    assert.fail("Expected an error");
  } catch (error: unknown) {
    assert.equal(
      (error as { hint?: { code: string } }).hint?.code,
      "domain_filter.deployment_cap",
    );
  }
});
