# Web access providers with renewable or ongoing free usage

Verified: 2026-08-22, with Linkup and You.com refreshed on 2026-08-29. All figures below come from provider-owned pricing or product pages. Pricing changes frequently; verify again with Groundlane before making routing or budget decisions.

## Recurring or ongoing free allowance

| Service | Free allowance | Best Groundlane role | Important limits |
| --- | --- | --- | --- |
| [Tavily](https://www.tavily.com/pricing) | 1,000 API credits/month; no card | Search, extract, later research | A request may consume more than one credit depending on operation |
| [Exa](https://exa.ai/pricing) | $20 signup credits, then $10 credits/month; no payment method | Search and contents | Search is listed at $7/1,000 requests; other endpoints use different rates |
| [Brave Search API](https://brave.com/search/api/) | $5 credits/month | Independent-index search | Search is $5/1,000 requests, so the credit covers about 1,000 basic searches; signup flow requires a card |
| [Firecrawl](https://www.firecrawl.dev/pricing) | 1,000 credits/month; no card | Search, scrape, crawl | Search costs 2 credits/10 results; scrape/crawl/map cost 1 credit/page |
| [SerpApi](https://serpapi.com/pricing) | 250 searches/month | Google organic SERP and later vertical engines | 50 throughput/hour; no ZeroTrace or legal shield on Free |
| [Parallel](https://parallel.ai/pricing) | Eligible organizations receive $5 credits/month | Search, extract, cited responses | Requires a card; credits expire monthly and overage is charged, so Groundlane uses a conservative attempt cap |
| [Browserbase](https://docs.browserbase.com/account/billing/plans) | 1,000 Search calls/month, 1,000 Fetch calls/month, and one browser hour | Search now; managed fetch/browser later | Different products have separate allowances and contracts |
| [Linkup](https://docs.linkup.so/pages/documentation/platform/pricing) | Eligible accounts receive $20 credits and monthly top-up; older/product copy may express this as query capacity | Search, fetch, research | Linkup documents `/credits/balance` for the authoritative account balance; successful calls deduct endpoint-dependent credits |
| [Apify](https://apify.com/pricing) | $5 platform/Actor spend each month; no card | Specialized Actors, crawling, proxy-backed jobs | Usage depends on Actor price, compute, proxy, storage, and transfer |
| [Cloudflare Browser Run](https://developers.cloudflare.com/browser-rendering/pricing/) | Workers Free: 10 browser minutes/day; Workers Paid: 10 browser hours/month included | Browser, Markdown, scrape, JSON, crawl | Paid overage is $0.09/browser-hour; session concurrency is billed separately after included capacity |
| [Browserless](https://www.browserless.io/pricing) | 1,000 units/month; no card | Managed browser fallback | Two concurrent browsers; one-minute maximum session; a unit covers up to 30 seconds, with proxy/CAPTCHA surcharges |
| [Jina Reader](https://jina.ai/reader/) | Ongoing keyless access at 20 RPM | LLM-ready fetch/Reader backend | This applies to `r.jina.ai`; it is rate-limited capacity rather than a monthly pool |
| [Keenable](https://docs.keenable.ai/credits) | Authenticated organizations get 100,000 free requests/month; keyless public endpoint is unmetered | Independent-index search and fetch | Keyed calls are limited to 10 requests/sec per organization; keyless calls share 1,000 requests/hour and 10 requests/sec per IP |
| [You.com Web Search](https://you.com/pricing) | 100 Search queries/day with no API key through the free MCP profile; new accounts also get $100 API credits | Web and news search, Contents, Answer, Research, Finance Research | Groundlane uses the free MCP profile when `YOU_API_KEY` is unset and the REST Search API when it is set; the Account Balance API reports keyed credit balance in cents |

## Cloudflare search products

Cloudflare currently exposes two different search concepts, neither of which is
an eligible Groundlane public-web provider today:

- **Cloudflare AI Search** indexes operator-owned or verified sources. Its
  2026-08-06 preview pricing includes a shared allowance of 2,000 queries per
  month, but it searches a private corpus rather than the public web.
- **Cloudflare Web Search** appears as an experimental Wrangler binding and CLI
  command. On the verified account, a live query returned
  `account_disabled (7078)`; the documentation URL returned 404 and no
  recurring free allowance was published. Groundlane will reconsider it after
  Cloudflare documents availability and pricing.

## Eligible `web_search` providers

At the time of this pricing snapshot, Groundlane's default automatic order exposed these low-cost or free-allowance search providers:

1. Linkup (keyed accounts; conservative local cap; balance available through `provider_balance`)
2. Keenable (keyless public endpoint by default; conservative local cap)
3. You.com Web Search (keyless free MCP profile or keyed REST credits)
4. Parallel
5. Browserbase Search (1,000 Search calls/month on its Free plan)
6. Brave Search API
7. SerpApi
8. Tavily
9. Exa
10. Firecrawl Search

Apify, Cloudflare Browser Run, Browserless, and ZenRows may also have recurring
allowances, but they are Actor, browser, or retrieval services rather than a
compatible general-search provider. Browserless is therefore implemented as a
browser backend; the others belong behind future backend adapters, not in the
default automatic order. The implementation also exposes Serper as an opt-in
provider value, but its free allowance remains a finite trial rather than
recurring capacity.

## Signup or finite trial pools

These pages advertise free usage but do not state that it resets every month. Treat them as onboarding credits, not permanent capacity.

| Service | Free pool | Best Groundlane role |
| --- | --- | --- |
| [Serper](https://serper.dev/) | 2,500 queries; no card | Low-cost Google SERP provider |
| [SearchAPI.io](https://www.searchapi.io/pricing) | 100 requests; no card | Google and vertical SERP provider |
| [ScrapingBee](https://www.scrapingbee.com/pricing/) | 1,000 API credits; no card | Proxy/browser-backed page retrieval |
| [Jina Search](https://jina.ai/reader/) | Each new key includes 10 million non-commercial tokens; no monthly refill is stated | Search trial only; `s.jina.ai` does not allow keyless requests |
| [You.com REST/API credits](https://you.com/pricing) | $100 complimentary API credits; no card | Keyed Search, Contents, Answer, Research, and Finance Research |

## Do not choose for a new integration

- [Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview) gives existing customers 100 free queries/day, but it is closed to new customers and scheduled to discontinue on 2027-01-01. Groundlane should not add a new adapter for it.

## Current routing order

For a low-cost development deployment, Groundlane defaults to:

1. Linkup
2. Keenable
3. You.com
4. Parallel
5. Browserbase
6. Brave
7. SerpApi
8. Tavily
9. Exa
10. Firecrawl

Automatic searches select at most two complementary providers per batch from the
ordered candidate pool and merge exact canonical-URL matches with RRF. If the
first federated batch has no successful provider, Groundlane tries the next
eligible batch within the same deadline. Callers can still pin one provider or
request sequential fallback. Every attempted provider uses
its own instance-local monthly budget; counters reset at the start of each UTC
month and skip exhausted providers. These counters are guardrails rather than
billing records: restarts reset them and multiple instances do not share state,
so provider dashboards remain authoritative. Linkup is attempted only when a
key is configured and has a conservative default cap of 100 attempts; use
Groundlane's `provider_balance` tool or Linkup's dashboard for actual account balance. Keenable
uses its keyless public endpoint when `KEENABLE_API_KEY` is unset, or its
authenticated endpoint when the key is configured; the default local cap is
conservative because the keyless pool is shared per IP. You.com uses its
keyless free MCP profile when `YOU_API_KEY` is unset and the keyed REST Search
API when the key is configured; the default local cap is conservative because
Groundlane's guardrail is monthly while You.com's free profile is daily. For
keyed You.com accounts, `provider_balance` can refresh the remaining API credit
balance from You.com's official account-balance API.
Finite pools such as Serper remain opt-in and default to a zero cap.

For retrieval, prefer Groundlane's bounded HTTP path first. Operators can then opt into Jina Reader for eligible Markdown fallback and choose either Container-local Playwright or Browserless for rendering. Cloudflare Browser Run, Firecrawl Scrape, and other hosted retrieval paths remain future adapters.
