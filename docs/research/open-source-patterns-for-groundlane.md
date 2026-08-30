# Open-source patterns for Groundlane

Updated: 2026-08-30.

This document extracts reusable patterns from
`docs/research/open-source-project-breakdown.md`. It is intentionally
cross-project: the point is not to pick a winner, but to identify patterns that
can survive Groundlane's URL policy, one deadline, byte/output bounds,
cancellation propagation, sanitized errors, and fixture-based verification.

## Pattern matrix

| Pattern | Seen in | Why it matters | Groundlane application | Adoption gate | Confidence |
|---|---|---|---|---|---|
| Stateless quick actions separated from stateful sessions | Steel, Browserless, Playwright MCP | Simple one-shot fetch/screenshot/PDF calls have different ownership, expiry, and billing semantics from reusable browser sessions. | Keep `web_fetch`, `web_extract`, `parse`, `web_content`, `web_map`, and `web_crawl` bounded and request-scoped; design future `create_session` / `navigate` / `release_session` separately. | Session handles need ownership, TTL, cleanup, isolation, spend limits, audit events, and cancellation tests. | confirmed |
| Accessibility or structured page state before screenshots | Playwright MCP, Stagehand, Chrome DevTools MCP | Structured page state is cheaper and easier for agents to act on than pixels. | Future browser diagnostics should return bounded accessibility/tree/network artifacts before image-heavy outputs. | Verify output caps and sensitive data redaction; screenshots remain explicit. | confirmed |
| Deterministic extraction and LLM extraction are separate engines | Groundlane current `web_extract`, Stagehand, Crawl4AI, Scrapling | Users need to know whether a selector/pattern result is deterministic or model-generated. | Keep current `selector` and bounded `pattern` engines deterministic; add future `schema` or `llm` engines only with explicit labels and cost/model provenance. | Schema fixtures, model/provider policy, confidence/error fields, no hidden synthesis. | confirmed |
| One deadline across all phases | Crawlee, Crawl4AI, provider tools as cautionary references | Crawl/browser/provider systems often reset timers between queue, fetch, render, parse, and poll stages. Groundlane should not. | Continue carrying one abort signal through search/provider fan-out, HTTP fetch, Reader, browser, map, crawl, and research polling. | Tests must prove queued and active work stops without leaking browser/process/provider tasks where Groundlane controls them. | confirmed |
| Queue and crawl are their own product surface | Crawlee, Scrapy, Browserless, Nutch | Queue state changes failure, billing, cancellation, and replay semantics. | Do not overload `web_fetch` into recursive crawl. Keep `web_crawl` bounded today and design async crawl jobs separately. | Durable queue ledger, max pages/depth/breadth, URL policy per discovered URL, skipped/failed URL summaries. | confirmed |
| Provider capability is not implemented tool support | Firecrawl, Browserbase, You.com, Linkup, Parallel, Cloudflare | Vendors expose more than Groundlane wires into MCP; docs can outrun implementation. | Preserve `provider_capabilities` and `provider_quota` distinction between vendor features, implemented tools, balance evidence, and local budgets. | Every provider surface needs runtime path, request/response mapping, errors, URL revalidation, and contract tests. | confirmed |
| Account balance, local budget, and platform spend are separate | Linkup, You.com, Firecrawl, SerpApi, Cloudflare | Credits, requests, runtime minutes, vCPU, and local attempt counters are different units. | Keep `provider_balance` for official provider balances; keep `search_budget_status` for local attempts; treat Cloudflare billing separately. | Never convert units without official rate; document reset cadence and instance-local versus durable counters. | confirmed |
| Hosted unblocker/proxy/browser remains an adapter | Browserbase, Browserless, Bright Data, Zyte, Apify Platform, Firecrawl | Open-source crawler orchestration does not provide residential IPs, CAPTCHA solving, or managed fingerprints. | Keep managed browser/proxy/anti-bot behind opt-in provider adapters and explicit credentials. | Provider terms, privacy, spend controls, URL policy, and sanitized errors. | confirmed |
| Reader is a normalization stage, not a network backend | Mozilla Readability, Postlight Parser, Trafilatura | Article extraction begins after the page is fetched; it cannot decide whether the URL was safe to contact. | Preserve Groundlane Reader behind safe HTTP/browser fetch and report `engine`/`backend` provenance separately from Reader normalization. | Sanitizer-like cleanup, active attribute stripping, metadata/output caps, fixture benchmark. | confirmed |
| Parser substrate choice is a low-level tradeoff | htmlparser2, parse5, linkedom in Groundlane | Fast forgiving parsing and spec compliance produce different behavior under malformed HTML. | Keep parser decisions behind `parse` and Reader internals, not public provider contracts. | Corpus comparing malformed HTML, tables, metadata, links, media, and memory usage. | inferred |
| Source-aware documentation parsing beats raising output limits | Cloudflare docs research, parser benchmark, MarkItDown, Docling | Large generated docs need Markdown/OpenAPI/manifest slicing, not huge HTML extraction. | Expand source-aware docs parser for docs sites with `llms.txt`, Markdown endpoints, OpenAPI schemas, and heading/path slicing. | Bounded discovery, cache policy, schema operation slicing, fixtures per docs platform. | confirmed |
| Document ingestion starts with routing metadata | MarkItDown, Docling, Apache Tika, pdf-inspector, opendataloader-pdf | File parsing needs to know input kind, text-based versus scanned PDF, page count, MIME, and format support before choosing a backend. | Add future document preflight: MIME, size, pages/sheets/slides, encrypted/scanned/text-based, OCR-needed, unsafe features. | Local file threat model, sandbox, byte/page/time/temp-storage caps, per-format fixtures. | confirmed |
| OCR/layout/model output is probabilistic and must say so | PaddleOCR, RapidOCR, EasyOCR, docTR, Surya, OLMOCR, Marker, MinerU | OCR and visual layout models have confidence, model artifacts, runtime cost, and license concerns. | Treat OCR/layout as separate `model-assisted` document engines with confidence and model provenance. | Model licenses, CPU/GPU budgets, language coverage, scanned-PDF fixtures, fallback metadata. | inferred |
| External converter processes need a narrow wrapper | Pandoc, Apache Tika, Apache POI, GROBID, Tabula, OCRmyPDF | Powerful parsers often require Java/Haskell/native binaries and file I/O. | If adopted, run as isolated adapters with allowlisted formats and no host filesystem exposure. | Process sandbox, timeout, memory/temp limits, zip-bomb protections, sanitized stderr/errors. | inferred |
| Domain-specific parsers belong behind explicit modes | GROBID, Camelot, Tabula, Mammoth, SheetJS | A scholarly PDF parser or table extractor should not be sold as universal document understanding. | Expose future adapters by task or input class, e.g. `scientific_pdf`, `pdf_tables`, `docx`, `spreadsheet`. | Fixtures per domain, explicit unsupported cases, confidence/error semantics. | inferred |
| Discovery sources refresh taxonomy only | GitHub Topics, Trending, OSSInsight, Ecosyste.ms, LibHunt, MCP registries, awesome lists | Catalogs are good at finding names and bad at proving suitability. | Maintain a watchlist process, but require official repo/docs/license/dependency review before PRD adoption. | Candidate must pass official-source verification and Groundlane gates before becoming roadmap evidence. | confirmed |

## Capability-line recommendations

### browser/session/MCP

Groundlane should keep browser sessions out of the stateless MVP tools. Steel and
Browserless show why: once sessions exist, product semantics include identity,
cookies, storage, expiry, cleanup, debugging, concurrency, and billing. The
short-term win is to improve browser diagnostics and output contracts, borrowing
from Playwright MCP and Chrome DevTools MCP, while keeping the current safe URL
policy in front of every navigation, redirect, subresource, worker, and
WebSocket.

Confidence: confirmed.

### crawler/search/index

Crawlee is the most plausible TypeScript runtime candidate for a future
operator-owned crawl worker, but it should not become Groundlane's security
boundary. Scrapy, Katana, Nutch, and Browsertrix are more useful as mature
vocabularies for scheduler, middleware, URL frontier, archival capture, and
stats design. SearXNG and independent-index projects belong to the search/index
product line, not to Reader or browser rendering.

Confidence: confirmed for Crawlee and Scrapy; inferred for the broader index
watchlist.

### Reader/parser/extractor

Readability remains the right default Reader core because it is local,
well-bounded, and already fixture-backed in this repo. Metascraper and Postlight
Parser are benchmark references for metadata and article extraction quality.
Crawl4AI, Trafilatura, and Scrapling are more valuable as API and output
references than as runtime dependencies because they would pull Groundlane
toward Python/model/browser complexity.

Confidence: confirmed for Readability and Crawl4AI; inferred for the remaining
parser candidates.

### document ingestion/PDF/OCR/Office

Document ingestion should start as a routing and safety contract, not as a
promise to parse everything. MarkItDown's own security warning is the clearest
signal: document converters operate with process privileges unless wrapped.
Docling shows the richer target shape: format routing, unified document model,
OCR/layout fallback, service/MCP modes, and AI-friendly exports. Groundlane
should first define input classes, preflight metadata, limits, source spans,
confidence, and engine provenance, then choose format-specific adapters.

Confidence: confirmed for MarkItDown and Docling; inferred for most format and
OCR engines.

### provider docs/market references

Provider docs should calibrate Groundlane's adapter contracts, not define
Groundlane's core architecture. Hosted search/content/crawl/browser providers
remain replaceable behind MCP tools with attributed results. Pricing, balances,
eligibility, and reset cadence are time-sensitive and must be refreshed from
official sources before implementation or publication.

Confidence: inferred, because provider pricing and availability drift quickly.

## Roadmap gates distilled from the research

| Gate | Required evidence |
|---|---|
| Official-source verification | Official repo/docs page fetched, exact capability and license noted, hosted versus open-source boundary recorded. |
| LICENSE/NOTICE/dependency review | Reviewed pinned revision, transitive dependencies, Docker images, model artifacts, and attribution obligations. |
| Groundlane URL policy | Every user URL, discovered URL, provider-returned URL, redirect, and browser subresource passes the existing public HTTP(S) policy. |
| One end-to-end deadline | Queue, provider, HTTP, reader, browser, parser, OCR, and polling share the same abort/deadline budget. |
| Byte/output bounds | Input bytes, decoded bytes, pages, sheets, images, links, candidates, and output chars are capped locally. |
| Cancellation propagation | Queued work is removed, active work is aborted, browser/process resources are released, upstream polling stops where possible. |
| Sanitized errors | Provider bodies, response content, cookies, headers, secrets, and full queries are not logged or returned. |
| Deterministic fixtures or corpus | Every new engine has fake-based contract tests and representative fixtures before live-provider smoke tests. |

