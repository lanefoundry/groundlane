Task: Add provider balance diagnostics and clarify provider capabilities.

Started: 2026-08-29T09:40:00+08:00

Plan:
- [x] Add a bounded `provider_balance` MCP tool for vendor account balance checks.
- [x] Implement You.com balance lookup from the documented account balance API.
- [x] Implement Linkup balance lookup against the documented credits endpoint with conservative parsing.
- [x] Add `provider_capabilities` so clients can inspect provider features without reading Markdown docs.
- [x] Update MCP contract tests, unit tests, README/docs, and provider inventory.
- Run lint, typecheck, tests, build, and diff whitespace checks.

Official docs checked through Groundlane:
- You.com account balance: `data.attributes.balance`, cents.
- Linkup credits balance: `{ balance: number }`, credits.

Implementation status:
- Local deterministic tests passed for provider balance adapters, capability catalog, and MCP tool registration.
- Deployed Worker `c87c4fdb-59b1-4a8f-9c2f-acb7fedb6c84`; Container version 19.
- Production `provider_balance` returned Linkup `13.396` credits and You.com `9986` cents.
- Fixed unsupported-provider `configured` diagnostics and deployed Worker
  `ac5b89d1-8b2d-4898-86f4-8c1f62ccc4d4`; Container instance version 20.
- Production smoke listed five tools:
  `provider_balance`, `provider_capabilities`, `web_extract`, `web_fetch`,
  `web_search`.
- Production explicit `provider_balance(provider=serper)` returned
  `configured: true`, `status: unsupported`.

## 2026-08-29 continuation: parallel extra tools

- [x] Change `provider_balance(provider=all)` from sequential provider checks to
  parallel fan-out under one request deadline.
- [x] Add `web_answer` as an executable cross-provider extra tool, not just a
  static catalog entry.
- [x] Implement first answer providers for You.com Answer API and Linkup
  `outputType=sourcedAnswer`.
- [x] Keep returned answers separate by provider with selected/attempted/
  succeeded metadata; no hidden LLM synthesis.
- [x] Verify local gates and production smoke after deployment.

Parallel's cited Responses API is intentionally not implemented in this pass:
the vendor feature is documented, but the exact endpoint and response contract
need a separate adapter verification before Groundlane exposes it as runtime
surface.

Verification:

- Local gate passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  and `git diff --check`.
- Production deploy version: `d5aa81c4-238b-4e12-8940-990869e860dc`;
  container app version 22 uses image digest
  `sha256:62baa37292b9ebb337ef8fb81cc98837a1708e9240f4ecfebd56e6fe2924ae53`.
- Production smoke listed:
  `provider_balance`, `provider_capabilities`, `web_answer`, `web_extract`,
  `web_fetch`, `web_search`.
- Live `web_answer` with `providers=["linkup","you"]`,
  `strategy="parallel"`, and `maxResults=1` succeeded for both providers.
  Groundlane returned result counts `[["linkup", 1, 1], ["you", 1, 0]]`,
  proving both parallel fan-out and local result limiting.
- Production `provider_balance(provider=all)` after live answer smoke returned
  Linkup `13.363` credits and You.com `9984` cents.
