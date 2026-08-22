# Web access providers with renewable or ongoing free usage

Verified: 2026-08-22. All figures below come from provider-owned pricing or product pages. Pricing changes frequently; verify again with Groundlane before making routing or budget decisions.

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
| [Linkup](https://www.linkup.so/pricing) | Eligible accounts are topped back up to a $20 balance each month | Search, fetch, research | This is a balance refill, not $20 added each month; eligibility and exact top-up date are not fully public |
| [Apify](https://apify.com/pricing) | $5 platform/Actor spend each month; no card | Specialized Actors, crawling, proxy-backed jobs | Usage depends on Actor price, compute, proxy, storage, and transfer |
| [Cloudflare Browser Run](https://developers.cloudflare.com/browser-rendering/pricing/) | Workers Free: 10 browser minutes/day; Workers Paid: 10 browser hours/month included | Browser, Markdown, scrape, JSON, crawl | Paid overage is $0.09/browser-hour; session concurrency is billed separately after included capacity |
| [Browserless](https://www.browserless.io/pricing) | 1,000 units/month; no card | Managed browser fallback | Two concurrent browsers; one-minute maximum session; a unit covers up to 30 seconds, with proxy/CAPTCHA surcharges |
| [Jina Reader](https://jina.ai/reader/) | Ongoing keyless access at 20 RPM | LLM-ready fetch/Reader backend | This applies to `r.jina.ai`; it is rate-limited capacity rather than a monthly pool |

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

At the time of this pricing snapshot, Groundlane's default automatic order exposed exactly these recurring-monthly-free search providers:

1. Tavily
2. Exa
3. Linkup (eligible accounts; conservative local cap)
4. Parallel
5. Browserbase Search (1,000 Search calls/month on its Free plan)
6. Brave Search API
7. Firecrawl Search
8. SerpApi

Apify, Cloudflare Browser Run, Browserless, and ZenRows may also have recurring
allowances, but they are Actor, browser, or retrieval services rather than a
compatible general-search provider. Browserless is therefore implemented as a
browser backend; the others belong behind future backend adapters, not in the
default automatic order. The implementation also exposes Serper and You.com as
opt-in provider values, but their REST allowances remain finite trials rather
than recurring capacity.

## Signup or finite trial pools

These pages advertise free usage but do not state that it resets every month. Treat them as onboarding credits, not permanent capacity.

| Service | Free pool | Best Groundlane role |
| --- | --- | --- |
| [Serper](https://serper.dev/) | 2,500 queries; no card | Low-cost Google SERP provider |
| [SearchAPI.io](https://www.searchapi.io/pricing) | 100 requests; no card | Google and vertical SERP provider |
| [ScrapingBee](https://www.scrapingbee.com/pricing/) | 1,000 API credits; no card | Proxy/browser-backed page retrieval |
| [Jina Search](https://jina.ai/reader/) | Each new key includes 10 million non-commercial tokens; no monthly refill is stated | Search trial only; `s.jina.ai` does not allow keyless requests |
| [You.com REST API](https://you.com/api) | $100 complimentary API credits; no card | Search and contents trial; separate from the keyless Search MCP |

## Do not choose for a new integration

- [Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview) gives existing customers 100 free queries/day, but it is closed to new customers and scheduled to discontinue on 2027-01-01. Groundlane should not add a new adapter for it.

## Current routing order

For a low-cost development deployment, Groundlane defaults to:

1. Tavily
2. Exa
3. Linkup
4. Parallel
5. Browserbase
6. Brave
7. Firecrawl
8. SerpApi

Automatic searches select at most two complementary providers from the ordered
candidate pool and merge exact canonical-URL matches with RRF. Callers can still
pin one provider or request sequential fallback. Every attempted provider uses
its own instance-local monthly budget; counters reset at the start of each UTC
month and skip exhausted providers. These counters are guardrails rather than
billing records: restarts reset them and multiple instances do not share state,
so provider dashboards remain authoritative. Linkup is attempted only when a
key is configured and has a conservative default cap of 100 attempts. Finite
pools such as Serper and You.com REST remain opt-in and default to a zero cap.

For retrieval, prefer Groundlane's bounded HTTP path first. Operators can then opt into Jina Reader for eligible Markdown fallback and choose either Container-local Playwright or Browserless for rendering. Cloudflare Browser Run, Firecrawl Scrape, and other hosted retrieval paths remain future adapters.
