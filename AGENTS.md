# Groundlane agent instructions

## Scope

Groundlane is an independent open-source TypeScript project. It is not part of DaoDao and must not import DaoDao-specific code or configuration.

## Architecture

- `src/worker/`: Cloudflare Worker entry, authentication, routing, and Container lifecycle.
- `src/container/`: Node.js remote MCP HTTP server running in a Cloudflare Container.
- `src/core/`: pure orchestration, policies, limits, and contracts.
- `src/adapters/`: network, browser, and search provider adapters.
- `src/tools/`: MCP tool definitions and handlers.
- `test/`: unit, contract, and integration tests.

## Engineering rules

- Use strict TypeScript and ESM. Do not use `any` or unsafe double casts.
- Every new pure logic or validation function needs a test.
- Bug fixes require a regression test first.
- Treat every URL and provider-returned URL as untrusted.
- Preserve one end-to-end deadline; do not reset timeouts between stages.
- Bound network bytes, output size, redirects, concurrency, and queue length.
- Never log secrets, response bodies, or full user queries.
- Use `apply_patch` for edits and preserve concurrent work.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before declaring work complete.
