# Groundlane research archive

These documents capture the product, market, naming, and open-source research behind Groundlane's initial scope. They are decision inputs, not claims that every researched capability is implemented.

Research snapshots are dated. Prices, product features, repository licenses, and vendor documentation can change; verify current primary sources before making procurement, legal, or architecture decisions. Citations in each document point to the source pages reviewed at the time.

## Start here

1. [Competitive landscape and positioning](competitive-landscape.md) — the main market overview and initial product wedge.
2. [Product scope](product-scope.md) — how the browser retrieval engine fits into a wider agent web access layer.
3. [Brand decision](brand-decision.md) — why the public project is named Groundlane.

## Competitor research

- [Extended competitor map](extended-competitors.md) — web-intelligence APIs, search/data providers, model-native tools, and extraction platforms.
- [Verified free tiers and trial credits](free-tiers.md) — current recurring allowances, finite signup pools, and recommended routing order.
- [Provider inventory](../operations/provider-inventory.md) — current production secret presence, live smoke state, balance evidence, and capability matrix.
- [Browser infrastructure appendix](appendix-browser-infrastructure.md) — Browserbase, Browserless, Steel, and Hyperbrowser.
- [Scraping platforms appendix](appendix-scraping-platforms.md) — Bright Data, ZenRows, and ScrapingBee.
- [Agent platforms appendix](appendix-agent-platforms.md) — Cloudflare Browser Run, Browser Use, Firecrawl, and Apify.

## Engineering references

- [Open-source references](open-source-references.md) — projects and licenses considered as design influences.
- [Source-aware documentation parser](source-aware-docs-parser.md) — parser cascade and first runtime slice for large generated docs.
- [Reader benchmark](reader-benchmark.md) — reproducible article extraction benchmark against Mozilla Readability fixtures.
- [Parser benchmark](parser-benchmark.md) — local parser regression corpus for document, metadata, links, media, and tables.

## Naming note

Groundlane is the public project and product name. **Groundlane Browser** refers only to the internal browser execution engine used as a fallback behind `web_fetch` and `web_extract`; it is not a separate external API or top-level product.
