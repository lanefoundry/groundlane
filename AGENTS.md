# Groundlane agent instructions

## Project boundary

Groundlane is an independent open-source TypeScript project. It is not part of
DaoDao and must not import DaoDao-specific code, configuration, terminology, or
deployment assumptions.

## Architecture

- `src/worker/`: Cloudflare Worker entry, authentication, routing, and Container lifecycle.
- `src/container/`: Node.js remote MCP HTTP server running in a Cloudflare Container.
- `src/core/`: pure orchestration, policies, limits, budgets, and contracts.
- `src/adapters/`: HTTP, reader, browser, search, and provider integrations.
- `src/tools/`: MCP tool definitions and handlers.
- `test/`: unit, contract, integration, and regression tests.
- `docs/`: product decisions, configuration, deployment, and time-sensitive research.

Keep provider-specific request and response mapping in `src/adapters/`. Keep
routing, quota policy, validation, and shared contracts provider-neutral in
`src/core/`.

## Dogfood Groundlane for web access

- Use Groundlane's `web_fetch`, `web_search`, and `web_extract` for public-web
  research, documentation checks, and representative smoke tests.
- This rule applies to the primary agent and every subagent.
- When changing Groundlane itself, prefer running the current checkout locally
  with a temporary development auth token so research exercises the code being
  edited. Use the deployed MCP only when the task explicitly concerns the
  deployed version.
- `web_fetch` and `web_extract` do not require a third-party search key.
  `web_search` must fail closed when no configured search provider is available.
- If Groundlane cannot retrieve a required source, record the exact bounded
  failure and treat it as product evidence. Do not claim that an untested
  provider path works.
- Browser rendering proves JavaScript execution, not reliable CAPTCHA or
  managed-challenge bypass. State the observed boundary accurately.

## Provider and quota rules

- Treat provider pricing, quota, API contracts, reset cadence, and product
  availability as time-sensitive. Verify them with Groundlane against official
  provider sources before implementation.
- Keep requests, successful requests, credits, currency balances, browser time,
  concurrency, RPM, daily pools, monthly pools, balance top-ups, and one-time
  trials as distinct concepts. Never convert between them without a verified
  rate.
- Local attempt budgets are safety guardrails, not provider billing truth.
  Document whether counters reset on process restart and whether instances share
  state.
- A provider is implemented only when it has a real runtime path, configuration,
  secret forwarding where applicable, bounded error handling, and contract
  tests. Catalog or UI presence alone is not execution proof.
- Keep one-time and eligibility-gated allowances opt-in unless automatic routing
  has an explicit, conservative hard stop.
- Never enable provider PAYG or automatic top-up implicitly.

## Security and reliability

- Use strict TypeScript and ESM. Do not use `any` or unsafe double casts.
- Treat every caller URL and every provider-returned URL as untrusted.
- Validate public HTTP(S) destinations before connecting. Preserve DNS-rebinding,
  redirect, private-address, and provider-returned URL protections.
- Preserve one end-to-end deadline. Do not reset timeouts between DNS, HTTP,
  reader, browser, provider, fallback, or output stages.
- Bound network bytes, decoded output, redirects, provider candidates,
  concurrency, and queue length.
- Propagate cancellation through queued work and upstream requests.
- Never log secrets, authorization headers, response bodies, full user queries,
  cookies, or provider error payloads.
- Map upstream failures to stable, sanitized Groundlane errors. A provider's
  HTTP 429 or quota exhaustion must remain distinguishable from malformed input.
- Secrets belong in environment variables or Cloudflare secrets, never tracked
  files, command output, documentation examples, or test snapshots.

## Engineering workflow

- Use `rg` and `rg --files` for repository discovery.
- Use `apply_patch` for source and documentation edits.
- Preserve unrelated and concurrent work in a dirty worktree. Refresh
  `git status` and the final diff before reporting scope.
- For multi-step work, keep one task-specific plan/progress file on disk. Use
  `/tmp` for ephemeral execution state; add repository documentation only when
  it is an intended project artifact.
- Use small scripts for large or repetitive extraction and validation work;
  return condensed results instead of copying large source bodies into context.
- Use subagents only for concrete, independent tasks. Give them explicit file
  ownership for edits, remind them that the worktree is shared, and require the
  same Groundlane web-access rules.

## Tests

- Add a test for every new pure logic or validation function.
- Write a failing regression test before fixing a bug.
- Provider tests must cover endpoint and authentication shape, request mapping,
  response normalization, capability filtering, quota/rate-limit mapping,
  malformed responses, secret non-disclosure, unsafe returned URLs, byte bounds,
  cancellation, and deadline preservation as applicable.
- Prefer deterministic fake-based contract tests. Run live provider smoke tests
  only when credentials and external-state authorization are already in scope,
  and report them separately from deterministic tests.

## Completion gate

Before declaring code changes complete, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Also run `git diff --check` and state clearly whether deployment, provider
credentials, live billing behavior, and production smoke tests were verified or
remain unproven.
