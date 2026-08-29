Task: Analyze Groundlane usage issues from Keenable.ai research transcript.

Status:
- Checked memory registry for prior Groundlane notes.
- Located local implementation paths for OUTPUT_LIMIT, web_fetch, and web_extract limits.
- Confirmed Cloudflare search secrets exist and production search works for several explicit providers.
- Confirmed Jina is currently wired as a Reader backend, not a search provider.
- Added Keenable as a keyless/keyed web_search provider.
- Enabled Jina Reader in production deployment config.
- Improved web_extract limit/metadata ergonomics.
- Deployed Worker version ecb7218c-fd31-4d85-aaff-8d3abd61fb5c and Container version 13 using image tag 6be6a4ce.

Verification:
- pnpm lint: passed.
- pnpm typecheck: passed.
- pnpm test: passed, 126 tests.
- pnpm build: passed.
- git diff --check: passed.
- Keenable public endpoint direct smoke: HTTP 200, 2 results.
- Production MCP smoke: web_fetch/web_extract/web_search listed and basic fetch/extract passed.
- Production MCP web_search with provider=keenable: passed using keyless public endpoint.
external design comparison started 2026-08-29T08:15:45+08:00
auto provider fallback fix started 2026-08-29T08:19:56+08:00
auto provider fallback fix verified locally 2026-08-29T08:22:56+08:00
auto provider fallback fix deployed 2026-08-29T08:26:10+08:00 worker=731db129-faef-4b62-9fd5-e1c4b8caaeb9 container=14 image=auto-batch-20260829
production auto search smoke passed 2026-08-29T08:26:10+08:00 selected=linkup,keenable forced-bad-first-batch-fell-through=true
README update started 2026-08-29T08:31:25+08:00
linkup quota question 2026-08-29T08:35:14+08:00
brave domain filter support started 2026-08-29T08:35:57+08:00
brave domain filter support implemented 2026-08-29T08:45:00+08:00 mapping domains/excludeDomains to documented site: query operators
linkup quota docs correction started 2026-08-29T08:45:00+08:00 current official pricing says 4,000 free queries and docs expose /credits/balance
brave domain filter support verified and deployed 2026-08-29T08:43:41+08:00 worker=d837cba7-d9fb-4748-b83f-f26adb2cfea1 container=15 image=brave-domain-20260829
you.com free/keyed search support started 2026-08-29T09:14:00+08:00 pricing page and dashboard show usable free/credit allowance
provider inventory added 2026-08-29T09:14:00+08:00 docs/operations/provider-inventory.md records secret presence, smoke state, balance evidence, and capabilities
you.com free/keyed search support verified and deployed 2026-08-29T09:09:46+08:00 worker=8fea25aa-d5f5-4f9e-af63-260f9b980470 container=18 image=you-free-20260829
