# Contributing to Groundlane

Thank you for helping make web access safer and more portable for AI agents.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use a public issue for feature proposals and ordinary bugs.
- Do not open a public issue for a suspected vulnerability; follow [SECURITY.md](SECURITY.md).
- Keep changes focused. Discuss large tool-contract, security-boundary, or dependency changes before implementing them.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Prerequisites:

- Node.js 22 or newer
- pnpm 10

Clone this repository or your fork, then run:

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
pnpm test
```

Use test credentials and local targets while developing. Never commit API keys, bearer tokens, browser profiles, cookies, or captured private content.

## Project layout

```text
src/worker/      Cloudflare Worker entry and Container routing
src/container/   Node remote MCP server and browser process
src/core/        Pure contracts, policies, limits, and orchestration
src/adapters/    Search, HTTP, browser, cache, and telemetry adapters
src/tools/       MCP tool definitions and handlers
test/            Unit, contract, integration tests, and fixtures
docs/            Architecture, deployment, product, and research docs
```

See [docs/architecture.md](docs/architecture.md) before changing a boundary between these layers.

## Making a change

1. Create a focused branch from the current default branch.
2. Add or update tests with behavior changes.
3. Keep pure logic separate from network and browser adapters.
4. Update public documentation when configuration, tool contracts, errors, or deployment behavior changes.
5. Run the complete verification gate.

New pure logic and validation functions require tests. Bug fixes require a regression test that fails without the fix. UI-only test exemptions do not apply to this repository.

### Security invariants

Changes must not weaken these defaults:

- Treat URLs, redirects, provider results, browser subresources, WebSockets, and DNS answers as untrusted.
- Preserve one end-to-end deadline across cache, HTTP, provider, and browser stages.
- Bound request bytes, output, redirects, result count, concurrency, and queue depth.
- Keep secrets, authorization headers, response bodies, and full search queries out of logs.
- Return stable public errors rather than raw upstream failures.

If a proposal needs to relax an invariant, document the threat model and obtain maintainer agreement first.

## Verification

Run all checks before opening a pull request:

```bash
pnpm lint
pnpm exec wrangler types --check
pnpm typecheck
pnpm test
pnpm build
```

Tests that require live provider credentials or unrestricted external browsing must be opt-in and must not run in the default CI job.

To exercise the real Streamable HTTP boundary after starting a local server in another shell, load the same token and run the opt-in smoke check:

```bash
set -a
source .env
set +a
pnpm smoke
```

The smoke script connects to `GROUNDLANE_MCP_URL` (default `http://127.0.0.1:8080/mcp`), verifies the exact tool list, and calls fetch/extract against the reserved `example.com` documentation domain. Set `GROUNDLANE_SMOKE_BROWSER=1` to include the browser path.

## Pull requests

A useful pull request includes:

- the problem and intended outcome;
- the design choice and meaningful alternatives;
- tests or other verification evidence;
- security, compatibility, and operational effects;
- documentation updates, when user-visible behavior changes.

Maintainers may ask for a smaller change, additional tests, or an architecture note. Review comments apply to the code, not the contributor.

## Licensing

By submitting a contribution, you agree that it may be licensed under the repository's [Apache License 2.0](LICENSE). Only contribute work you have the right to submit. Note copied or adapted third-party material and preserve all required notices.
