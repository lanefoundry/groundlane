# PRD deltas from open-source reference breakdown

Updated: 2026-08-30.

This is a proposed delta list for `docs/product/prd.md`. It does not directly
modify the PRD.

## Summary

The PRD should keep Groundlane's current product boundary: a small,
provider-neutral MCP control plane with stateless, bounded tools. Open-source
projects should be represented as design influences by capability line, not as a
flat list of projects to adopt. Provider docs and commercial platforms should be
classified separately from open-source runtimes.

Confidence: confirmed.

## Proposed PRD changes

| PRD area | Current gap | Proposed adjustment | Evidence | Confidence |
|---|---|---|---|---|
| Design influences | Open-source runtimes, hosted providers, document parsers, and discovery lists can read like one category. | Split references into `primary architecture`, `primary reader/parser`, `future runtime candidates`, `license-gated references`, `document ingestion references`, `provider/market references`, and `discovery sources`. | `docs/research/open-source-project-breakdown.md` grouping. | confirmed |
| Browser sessions | PRD should avoid implying stateful sessions are a small extension of `web_fetch`. | Add a future-session note: session tools need ownership, TTL, cleanup, isolation, audit, quota, and billing semantics. | Steel, Browserless, Playwright MCP patterns. | confirmed |
| Browser diagnostics | Browser tools are currently framed mainly as render fallback. | Add future diagnostics surface: accessibility snapshot, network events, console/errors, screenshots/PDF only when explicit. | Playwright MCP and Chrome DevTools MCP. | confirmed |
| Extraction engines | Future schema/LLM extraction can be conflated with deterministic `web_extract`. | State that `selector` and `pattern` remain deterministic; `schema`, `adaptive`, and `llm` engines require explicit engine labels, model/provider provenance, confidence, and cost controls. | Stagehand, Crawl4AI, Scrapling. | confirmed |
| Crawl jobs | `web_crawl` exists, but async/durable crawl design is not fully separated. | Add a crawl-job design track: durable queue, max depth/breadth/pages, skipped/failed URL summaries, cancellation, replay, and cost ledger. | Crawlee, Scrapy, Katana. | confirmed |
| Search/index | Metasearch and self-hosted search/index references need clearer placement. | Classify SearXNG as possible adapter/service reference; Nutch, YaCy, Marginalia as long-horizon index references, not MVP runtime candidates. | Search/index breakdown. | inferred |
| Reader quality | Reader parser references should not become simultaneous dependencies. | Keep Mozilla Readability as current core; use Metascraper, Postlight Parser, Trafilatura, Crawl4AI, and Scrapling for benchmark/corpus ideas before dependency adoption. | Reader/parser breakdown. | confirmed |
| Source-aware docs parsing | Generated docs parsing is becoming a separate product need. | Add source-aware docs parser roadmap: `llms.txt`, Markdown endpoints, OpenAPI schema slicing, heading/path extraction, bounded fallback selectors. | Groundlane existing architecture docs and source-aware parser research. | confirmed |
| Document ingestion | PRD needs a first-class document ingestion threat model before listing engines. | Add preflight contract: input kind, MIME, size, pages/sheets/slides, encrypted/scanned/text-based, OCR-needed, source spans, confidence, engine provenance, temp storage, sandbox. | MarkItDown, Docling, Apache Tika, PDF/OCR references. | confirmed |
| OCR/layout | OCR engines can be mistaken for deterministic parsers. | Add `model-assisted document engines` category with model license, runtime, confidence, language coverage, and GPU/CPU cost gates. | PaddleOCR, RapidOCR, EasyOCR, docTR, Surya, OLMOCR, Marker, MinerU. | inferred |
| Office/PDF adapters | Broad document converters hide file and process risks. | Require per-format adapters and fixtures for DOCX, spreadsheets, scientific PDFs, tables, scanned PDFs, and generic MIME extraction. | Mammoth, SheetJS, GROBID, pdf.js, pdfminer.six, pdfplumber, Camelot, Tabula, OCRmyPDF. | inferred |
| Provider capabilities | Vendor feature catalogs can outrun Groundlane implementation. | Keep provider inventory language: vendor feature, implemented Groundlane tool, live smoke, balance evidence, and local budget are separate fields. | `provider_capabilities` and provider breakdown. | confirmed |
| Billing and quotas | Cloudflare runtime spend, provider credits, and Groundlane local attempts can be conflated. | Add explicit rule that provider balances, local attempt budgets, one-time credits, monthly top-ups, and Cloudflare runtime billing are separate and cannot be converted without official rates. | Groundlane provider docs and architecture. | confirmed |
| License posture | Watchlist projects may accidentally look adopted. | Add PRD wording: AGPL/SSPL/commercial-license or model-heavy projects are design references only until legal/dependency/model review passes. | Browserless, Lightpanda, Firecrawl, HyperAgent, Browsertrix, SearXNG, OCR/model projects. | confirmed |
| Discovery process | Discovery sources are useful but weak evidence. | Add a periodic discovery process that uses GitHub Topics/Trending, OSSInsight, Ecosyste.ms, LibHunt, MCP registries, package registries, Zyte Open Source, and awesome/vendor lists only to seed official-source review. | Discovery source breakdown. | confirmed |

## Suggested PRD wording

Add this near the PRD's open-source influence section:

> Groundlane uses open-source projects as capability-line references, not as a
> flat adoption queue. Primary architecture references currently include Steel
> for browser/session separation, Playwright MCP for browser-tool ergonomics,
> Stagehand for future agent extraction APIs, Crawlee for bounded crawl
> orchestration, and Scrapy for mature crawl pipeline vocabulary. Mozilla
> Readability remains the current Reader core. License-gated or platform-scale
> projects such as Browserless, Lightpanda, Firecrawl server, HyperAgent,
> Browsertrix, and SearXNG are design references until license, deployment, and
> dependency review passes. Document ingestion is a separate future capability
> line that starts with preflight, sandboxing, page/byte/time limits, source
> spans, confidence, and engine provenance before selecting PDF, Office, OCR, or
> model-assisted backends.

Confidence: confirmed.

Add this near provider routing:

> Provider docs and commercial services calibrate adapter contracts and market
> expectations, but they do not become Groundlane runtime guarantees. Vendor
> features, implemented MCP tools, live smoke evidence, account balances, local
> attempt budgets, and Cloudflare runtime spend are separate concepts.

Confidence: confirmed.

## Not recommended for current PRD

| Idea | Reason to avoid now | Confidence |
|---|---|---|
| Commit to stateful browser sessions in MVP | Requires identity, cookies, storage, TTL, cleanup, observability, quotas, and billing semantics. | confirmed |
| Replace Groundlane fetch with Crawlee | Crawlee is crawl orchestration, not Groundlane's URL/security/output boundary. | confirmed |
| Add a Python sidecar for Crawl4AI, Trafilatura, Scrapy, MarkItDown, or Docling immediately | Runtime, sandbox, dependency, model, and process-boundary work should be designed first. | confirmed |
| Treat OCR/layout models as deterministic parsers | OCR/model output needs confidence, model provenance, language coverage, and cost controls. | inferred |
| Use Browserless, Firecrawl server, Lightpanda, HyperAgent, Browsertrix, or SearXNG as direct dependency without review | AGPL/SSPL/commercial or platform-scale risks remain unresolved. | confirmed |
| Use GitHub stars, trending, awesome lists, or vendor comparison blogs as roadmap justification | They are only discovery signals and must be followed by official-source verification. | confirmed |

## Next verification work

| Work item | Purpose | Suggested evidence |
|---|---|---|
| Pin official repo revisions for primary references | Prevent drift in license and architecture claims. | Commit SHA, LICENSE/NOTICE snapshot, dependency manifest review. |
| Read implementation internals for Steel, Playwright MCP, Stagehand, Crawlee, and Readability | Move more findings from README-confirmed to implementation-confirmed. | Notes on exact modules, tests, and failure paths. |
| Build a document ingestion fixture matrix | Decide first parser/OCR candidates from evidence instead of capability claims. | Text PDF, scanned PDF, table PDF, DOCX, XLSX, PPTX, HTML, ZIP, image samples with expected bounded outputs. |
| Add provider-market refresh checklist | Keep hosted/provider claims current. | Official pricing/quota/API docs, balance endpoint behavior, live smoke when credentials are in scope. |

