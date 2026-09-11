# Free-tier strategy

How to run Groundlane at $0 by stacking provider free tiers and free OCR/transcription APIs. All paths work in Worker-only (Lite) mode.

## Search provider free tiers

Groundlane's auto-fusion routing uses providers as batched fallbacks, so free tiers compound across providers.

| Provider | Monthly free volume | Permanent? | Card required? |
| --- | --- | --- | --- |
| SearXNG (self-hosted) | **Unlimited** (operator-hosted) | Yes | No (self-host cost only) |
| Keenable (keyed) | 100,000 requests | Yes | No (verified org) |
| Keenable (keyless) | ~24,000 (1,000/hr shared per IP) | Yes | No |
| You.com (keyless) | ~3,000 (100/day) | Yes | No |
| Tavily | 1,000 credits (resets monthly) | Yes | No |
| Firecrawl | 1,000 credits (resets monthly) | Yes | No |
| Browserbase | 1,000 Search calls | Yes | No |
| Brave | ~1,000 ($5 monthly credit) | Yes | Yes |
| SerpApi | 250 per billing cycle | Yes | Unknown |
| Exa | ~1,400 ($10 monthly credit) | Yes | No |
| Linkup | ~4,000 standard (top-up to $20) | Yes* | No |
| Parallel | ~1,000–5,000 ($5 monthly credit) | Yes | Yes |
| Serper | 2,500 total (no reset) | Trial only | No |
| SearchAPI.io | 100 total (no reset) | Trial only | No |

*Linkup eligibility and top-up reset date are not fully public.

### Theoretical maximum

With a self-hosted SearXNG instance, search volume is **unlimited** at zero API cost (only hosting cost). Without SearXNG, stacking all permanent renewable cloud tiers yields **~130,000+ searches/month** before any paid usage. With auto-fusion sending two providers per batch, roughly 65,000 deduplicated search calls.

### Recommended provider order

Prioritize self-hosted first, then renewable no-card providers, card-required renewable, one-time trials last:

```
searxng,keenable,you,browserbase,tavily,firecrawl,brave,serpapi,exa,linkup,parallel,serper,searchapi
```

## Non-search tool free usage

| Tool | Free source | Monthly free |
| --- | --- | --- |
| Content / Fetch | Keenable Fetch (keyless 150/min), TinyFish ($0), You.com (100/day) | ~30,000+ |
| Answer | Linkup ($20 pool), You.com (100/day) | ~3,000 |
| Map | Firecrawl + Tavily (shared credit pool) | ~1,000 |
| Crawl | Firecrawl + Tavily (shared credit pool) | ~500 pages |
| Research | Linkup ($0.25–2.50/call from $20 pool) | 8–80 calls |

## Document parsing and processing

### Built-in tools (zero config, zero cost)

All of these tools use the built-in `groundlane-bounded-document-v3` engine or pure JS heuristics. No external API needed, no cost, no API key.

| Tool | What it does |
| --- | --- |
| `document_parse` | Deterministic parsing of PDF (text-based), DOCX, XLSX, PPTX, ODF, CSV, TXT, Markdown, JSON, XML, HTML, RTF, EPUB, EML |
| `document_table_extract` | Extracts tables from PDFs using spatial heuristics (pdf.js coordinate analysis) |
| `document_archive_extract` | Extracts ZIP contents and parses each supported file through the same engine as `document_parse` |
| `document_email_extract` | Parses EML files with recursive MIME attachment extraction and per-attachment parsing |
| `document_chunk` | Splits parsed blocks into hierarchical multi-level chunks (default 2048→512→128 tokens) for RAG ingestion |
| `document_toc` | Extracts structured table-of-contents tree via Markdown `#`, HTML headings, ALL-CAPS, and Title Case heuristics |

### Academic paper metadata (zero config, zero cost)

| Tool | What it does |
| --- | --- |
| `paper_search` | Searches Semantic Scholar (free, 1k req/s unauthenticated) for academic papers with title, abstract, authors, citations, TL;DR, DOI, ArXiv ID, and open access PDF link |
| `paper_lookup` | Looks up a specific paper by Semantic Scholar ID, DOI, or ArXiv ID with full references and citations |

### External API tools (need API key, free tiers available)

The limitations below require external services.

## OCR (scanned PDFs, images)

Tesseract WASM does not work in Cloudflare Workers (requires Web Worker API, confirmed incompatible).

| Service | Free tier | Permanent? | Accuracy | Setup |
| --- | --- | --- | --- | --- |
| OCR.space | 25,000 requests/month, 1 MB/file | Yes | ~95% on clean docs | API key only, no cloud project |
| Workers AI (Moondream 3) | 10,000 Neurons/day (~15–25 calls) | Yes | Good for clean text | Zero setup, `env.AI.run()` |
| Google Cloud Vision | 1,000 units/month | Yes | Best-in-class, multilingual | GCP project + service account |
| Azure Doc Intelligence | 5,000 transactions/month | Yes | Best for forms/tables | Azure subscription + resource key |
| AWS Textract | 1,000 pages/month | First 3 months only | Top tier | IAM credentials |

**Recommendation:** OCR.space for volume (25k/mo, zero setup). Workers AI Moondream for same-ecosystem simplicity. Google Cloud Vision for accuracy on complex multilingual documents.

Workers AI usage: the Worker calls `env.AI.run("@cf/moondream-3", { image, prompt: "Extract all text" })` directly. PDF pages must be rendered to images first (callers submit images, or a pdf.js WASM renderer is used).

## Audio transcription

| Service | Free tier | Setup |
| --- | --- | --- |
| Workers AI (Whisper) | Included in 10,000 Neurons/day | `env.AI.run("@cf/openai/whisper")` |
| OpenAI Whisper API | Pay-per-use only | API key |
| Deepgram | $200 one-time credit | API key |

**Recommendation:** Workers AI Whisper. Same ecosystem, no external API key needed.

## Legacy Office conversion (.doc, .xls, .ppt)

These formats are not supported by `document_parse`. Convert to modern formats first.

| Service | Free tier | Setup |
| --- | --- | --- |
| CloudConvert | 25 conversions/day | API key |
| Zamzar | 25 conversions/month (free plan) | API key |

**Recommendation:** CloudConvert (25/day is sufficient for most use cases). Call from Worker via `fetch()`, receive the converted `.docx`/`.xlsx`/`.pptx`, then feed to `document_parse`.

## Cost summary

| Capability | Monthly free capacity | Cost |
| --- | --- | --- |
| Search (with SearXNG) | Unlimited | $0 (hosting cost only) |
| Search (cloud providers only) | ~130,000 | $0 |
| Content / Fetch | ~30,000 | $0 |
| Document parsing (built-in formats) | Unlimited | $0 |
| Table extraction (PDF) | Unlimited | $0 |
| Archive extraction (ZIP) | Unlimited | $0 |
| Email + attachment extraction | Unlimited | $0 |
| Hierarchical chunking (RAG) | Unlimited | $0 |
| TOC extraction | Unlimited | $0 |
| Academic paper search | Unlimited (1k req/s) | $0 |
| OCR | 25,000 (OCR.space) | $0 |
| Audio transcription | ~15–25 calls/day (Workers AI) | $0 |
| Legacy Office conversion | ~750/month (CloudConvert) | $0 |
| Cloudflare Worker hosting (Lite) | Workers free tier | $0 |
