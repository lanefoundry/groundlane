# Groundlane 可參考的開源專案

更新日期：2026-08-30。來源為 Groundlane `web_search`、`web_fetch` 查到的 GitHub Topics、GitHub Trending、OSSInsight、GitHub repository metadata、官方 README／docs，以及既有研究文件。GitHub stars、最近更新與授權標示會持續變動；本文件只用它們判斷「是否值得繼續看」，不把單一數字當成技術選型理由。

## 本輪查核摘要

- 原本的方向仍成立：Groundlane 應維持小型 TypeScript control plane，不整包 fork 任何 crawler/browser server。
- 參考清單需要分層：browser/session/MCP、crawler/search/index、Reader/parser/extractor、document ingestion、provider docs／market references 不能混在同一個 primary list。
- Steel、Playwright MCP、Stagehand、Crawlee、Scrapy 仍是主要架構或模式參考。
- Browserless、Lightpanda、Firecrawl、HyperAgent、Browsertrix Crawler 這類 AGPL/SSPL/commercial-license 或大型平台型 repo，只能在授權與部署邊界審完前作設計參考。
- Scrapling 的維護訊號與 BSD-3-Clause 授權比舊清單更強，應從「偶然候選」提升為 extractor/crawl watchlist。
- PDF/OCR/document parsing 已成獨立能力線。PaddleOCR、RapidOCR、EasyOCR、docTR、Docling、MarkItDown、anydoc、Unstructured、GROBID、pdf.js、pdfminer.six、OCRmyPDF、Tesseract、Surya、Layout Parser、OLMOCR、Apache Tika、Apache POI、Pandoc、Mammoth、SheetJS、PyMuPDF、pdfplumber、pypdf、Camelot、Tabula 應用來設計 adapter boundary、fixtures 與 benchmark，不應直接承諾 runtime。
- BrowserMCP、PageAgent、Kuri/Unbrowse 類新型 browser automation 專案值得放進 discovery，但執行邊界、repo 維護史或授權標示還不足以進 primary。
- GitHub Trending 與 OSSInsight 補到 Chrome DevTools MCP、browser-harness 這類短期活躍 browser tooling／harness 專案；它們是 browser/session discovery，不是 parser 或 retrieval runtime。
- webclaw、crw 類 Rust/local-first 或 Firecrawl-compatible 專案提醒 Groundlane 持續追蹤輕量 extraction/crawl/MCP server 方向；目前只作 discovery。
- 2026-08-30 追加查核顯示，GitHub 之外還有 Ecosyste.ms、LibHunt、MCP registry、awesome lists、package registries、Zyte open-source page 與 document/OCR benchmark lists 可作定期 discovery source；這些來源只能補候選與分類，不構成採用證據。

## 讀取程度

| 來源 | 讀取程度 | 用途 | 阻礙／限制 |
|---|---|---|---|
| GitHub repository metadata API | 一手 | 授權標示、語言、活躍度、topic、是否 archived | metadata 會漂移；完整採用仍需鎖 commit 讀 LICENSE/NOTICE 與 dependencies |
| GitHub Topics：`web-scraping`、`document-parsing` | 一手 | 發現高活躍候選與分類變化 | topic 排名是 discovery，不是採用排序 |
| GitHub Trending daily/weekly/language filters | 一手 | 發現短期活躍 browser tooling、MCP、agent harness 類候選 | trending 受時間窗與 GitHub opaque ranking 影響，只能當候選來源 |
| OSSInsight Trending / analysis pages | 一手 | 用 activity、language/category filters 交叉檢查 GitHub 熱門候選 | 2026-08-30 抓取時，OSSInsight 主頁標明 star-based ranking 暫停；AI trending growth figures 受 GitHub public events incomplete 影響，只能當 lower-bound/discovery |
| 專案官方 README／docs | 一手 | 能力、runtime、MCP/API surface、部署邊界 | README 可能是行銷式描述，不能取代 contract tests |
| Provider docs 與競品研究 | 一手／既有研究 | 校準 hosted capability、pricing/billing、adapter contract | 不是開源 runtime reference；價格與方案需另行重查 |

## Reference discovery sources

這些來源用來回答「還有哪些地方會記錄同一批 browser、crawler、parser、document ingestion 候選」。它們適合定期重查與補 taxonomy，但不能取代官方 repository、LICENSE、NOTICE、release notes、dependency review 或 Groundlane fixtures。

| 來源 | 可記錄的內容 | Groundlane 用法 | 限制 |
|---|---|---|---|
| [Ecosyste.ms Packages](https://packages.ecosyste.ms/) | npm、PyPI、crates.io、Maven、Docker Hub 等 package/version/dependency metadata | 查 runtime package、版本、download/keyword 訊號、跨 ecosystem dependency surface | 舊 `repos.ecosyste.ms/topics/...` topic pages 於本輪查核回 `410 Topic pages have been removed`；應優先用目前可用的 package/API endpoint |
| [awesome.ecosyste.ms](https://awesome.ecosyste.ms/) 與 GitHub awesome lists | curated scraper/crawler/parser lists、語言分組、JSON mirror | 補長尾候選與歷史專案，例如 `awesome-web-scraper`、`awesome-web-scraping`、`awesome-scrapers` | curated list 維護品質不一；列入清單不代表活躍、授權清楚或適合採用 |
| [LibHunt topic pages](https://www.libhunt.com/topic/web-crawling) | topic-based OSS ranking、語言、stars/score、project mentions | 定期掃 `web-crawling`、`document-parser`、`ocr`，補 Scrapy/Crawlee/Docling/OCR 類 watchlist | 排名與分數是 discovery signal；頁面含 sponsored/mentions，需逐案回官方 repo 驗證 |
| [MCP Registry](https://github.com/modelcontextprotocol/registry) 與 [mcpservers.org](https://mcpservers.org/) | MCP servers、browser automation、web scraping、search、PDF 類目錄 | 追蹤 Playwright MCP、Chrome DevTools MCP、BrowserMCP、Firecrawl MCP、provider MCP surfaces | MCP server catalog 不等於 safe public-web retrieval backend；仍需檢查 isolation、auth、output bounds 與 URL policy |
| npm、PyPI、crates.io、Maven Central、Homebrew | package release cadence、runtime availability、ecosystem adoption | 查 `crawlee`、`@crawlee/playwright`、`cheerio`、`Scrapy`、`trafilatura`、`Crawl4AI`、`docling`、`pdfplumber` 等 package surface | registry metadata 不足以確認 repo health、license compatibility 或 transitive dependency risk |
| [Zyte Open Source](https://www.zyte.com/open-source/) | Scrapy ecosystem projects：Scrapy、Spidermon、Parsel、w3lib、Queuelib、Protego、Itemloaders 等 | 補 Scrapy 周邊 pipeline、selector、robots、queue、monitoring reference | Zyte hosted products、Scrapy Cloud、Zyte API 是商業服務，不能混成開源 runtime capability |
| Document/OCR awesome lists 與 benchmark pages | OCR、document understanding、layout analysis、PDF/table extraction datasets 與 papers | 補 document ingestion 子線，例如 KIE、DLA、DQA、SDU、OCR、PDF processing tools | 研究 benchmark/model-assisted output 不能混成 deterministic parser；dataset/license/model artifact 需另審 |
| OSRepos、GitPlanet、StartupHub.ai、SaaSHub 類第三方目錄 | topic/category project discovery、alternatives lists | 作候選 seed，特別是找 GitHub topic 漏掉的新 repo | 品質與抗 bot 行為不穩；本輪 OSRepos fetch 只取得 challenge page，不能當主要證據 |
| Vendor blog annual lists：Apify、Firecrawl、Scrapfly、ScrapingBee、Thunderbit、Octoparse、KDnuggets 等 | 年度比較、近期新增工具、主觀分類 | 作定期重查入口，尤其補近期 web scraping/crawler/news 結果 | 常有商業立場、數字會漂移；只能作 discovery seed，不作採用排序或授權結論 |

本輪 Groundlane tool 狀態：`web_search`、`web_fetch`、`web_extract`、`parse`、`web_answer`、`web_content`、`web_news` 可取得候選與頁面內容；`web_research` 以 `auto` 查詢時曾 deadline exceeded，改用 `parallel` 後成功；`web_images` 的 Brave provider rejected request，SerpApi 可回傳文章入口；`web_map` 與 `web_crawl` 在本輪對 `mcpservers.org` 回 `PROVIDER_UNAVAILABLE`。這些是工具/provider 當下狀態，不代表對應網站沒有資料。

## 採用層級

| 層級 | 意義 | 採用前 gate |
|---|---|---|
| Primary architecture | 會直接影響 Groundlane tool contract、service boundary 或 MVP hardening | 必須能被 Groundlane URL policy、deadline、byte/output budget、cancellation 與 sanitized error contract 包住 |
| Primary reader/parser | 會影響 Reader、parser、metadata 或 extraction corpus | 必須有 deterministic fixtures；不能把 heuristic Reader 說成 selector extraction |
| Future candidate | 未來可作 runtime dependency 或 adapter，但不屬 MVP | 需 license/dependency review、bounded fixture、CI fake tests、rollback path |
| Watchlist | 值得追蹤，但不該影響近期 roadmap commitment | 定期重查活躍度、授權、runtime 重量與安全邊界 |
| Discovery | 用來補 taxonomy、特殊演算法或找 benchmark corpus | 不能寫成「Groundlane 將採用」 |
| Provider docs / market | 商業 provider 或 hosted service 參考 | 只能校準 adapter/output/billing，不等於開源可自架能力 |

## Primary architecture references

| 專案 | 可借鏡的能力 | 授權／邊界 | 建議 |
|---|---|---|---|
| [Steel](https://github.com/steel-dev/steel-browser) | session API、CDP endpoint、browser lifecycle、stateless scrape/screenshot/PDF、proxy chain、debug UI | GitHub metadata 顯示 TypeScript、Apache-2.0、近期活躍 | 最接近 Groundlane 的 browser/session 產品參考；深入讀 controller、process manager、quick-action routes 與 proxy manager，但不 fork 完整 UI/API |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Streamable HTTP、tool registration、client isolation、CDP connection、accessibility snapshot、output limits | TypeScript、Apache-2.0、近期活躍 | MCP 層主要參考；官方 origin flags 不能當 SSRF security boundary，Groundlane 仍保留 DNS pinning、安全 proxy 與 redirect/subresource policy |
| [Stagehand](https://github.com/browserbase/stagehand) | `act` / `observe` / `extract`、Zod structured output、token-efficient page context、OTel | TypeScript、MIT、近期活躍 | 未來 schema extraction 和 agent actions 的 API 參考；MVP 不引入 LLM act/observe/extract |
| [Crawlee](https://github.com/apify/crawlee) | HTTP/browser unified crawlers、request queue、retry、session/proxy rotation、fingerprints、autoscaling、Playwright integration | TypeScript、Apache-2.0、近期活躍 | `web_crawl` 或 async crawl job 的第一 runtime candidate；不能替代單頁 `web_fetch` |
| [Scrapy](https://github.com/scrapy/scrapy) | scheduler、downloader/spider middleware、item pipeline、signals/stats、retry、AutoThrottle | Python、BSD-3-Clause、成熟且活躍 | 借鏡 pipeline hooks、failure semantics 與 ops vocabulary；不引入 Python crawler runtime |

## Browser/session watchlist

| 專案 | 可借鏡的能力 | 主要限制 | 建議 |
|---|---|---|---|
| [Browserless](https://github.com/browserless/browserless) | Chromium Docker、queue/concurrency、health check、crash recovery、WebSocket API、debug viewer | GitHub license metadata 為 non-standard；repo/README 指向 SSPL 或 commercial licensing；hosted anti-bot/proxy capability 不等於開源能力 | 很值得讀 operations design；未完成法律審查前不作 dependency 或 fork base |
| [Lightpanda](https://github.com/lightpanda-io/browser) | Zig headless browser、CDP server、低資源 browser fast path、Markdown dump、HTTP MCP session isolation | AGPL-3.0；非 Chromium，複雜網站相容性與 anti-bot 表現需獨立測試 | 作低成本 render fast path 實驗候選；不能替換 Playwright backend |
| [Browser Use](https://github.com/browser-use/browser-use) / [browser-harness](https://github.com/browser-use/browser-harness) | autonomous browser agent、task loop、tools、memory、Docker、self-healing harness、persistent browser/cloud browser patterns | Python 且偏 agent reasoning/task harness，不是單純 retrieval execution layer | 只看 agent-facing tool UX、task loop 與 harness failure semantics；不併入 Groundlane runtime |
| [HyperAgent](https://github.com/hyperbrowserai/HyperAgent) | `perform` / `ai` / `extract`、action cache、Playwright fallback | AGPL，且偏 AI automation SDK | 看 API shape；不進 dependency path |
| [BrowserMCP](https://github.com/BrowserMCP/mcp) | 透過 MCP 控制使用者既有瀏覽器、browser extension 與 Playwright MCP-derived tool surface | 產品邊界偏 local desktop/browser-extension，不是 isolated remote browser service | Discovery only；可借鏡「user-owned browser」和 remote container browser 的邊界差異 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Chrome DevTools protocol、debugging/performance/network tooling、coding-agent-facing MCP server | 偏 debugging/tooling，不是 remote retrieval backend；DevTools access 不等於 safe public-web fetch policy | Discovery only；可借鏡 diagnostics 與 browser observation surface |
| [PageAgent](https://github.com/alibaba/page-agent) | in-page GUI agent、自然語言控制 Web interface、TypeScript agent/browser automation surface | 偏前端頁內 agent/action，不是 Groundlane retrieval backend | Discovery only；可追蹤 agent-friendly action API |
| [Kuri](https://github.com/justrach/kuri) | Zig-native CDP snapshots、HAR recording、standalone fetcher、mobile automation | 新 repo、stars/維護史較短，GitHub license metadata 非標準 | Discovery only；可追蹤 CDP snapshot 與 broker 設計 |
| Selenium / Selenium MCP 類專案 | WebDriver、Grid、跨瀏覽器 automation | Groundlane 已用 Playwright；WebDriver 不等於 anti-bot/CAPTCHA bypass | negative/boundary reference；不列 runtime candidate |

## Reader、parser 與 extractor references

| 專案 | 可借鏡的能力 | 是否適合直接整合 | 建議 |
|---|---|---|---|
| [Mozilla Readability](https://github.com/mozilla/readability) | Firefox Reader View 使用的 article scoring、metadata、link density、element cap | 高：JavaScript、Apache-2.0；已可搭配不執行 script 的 DOM implementation | 保留作 Reader core；輸出仍受 sanitizer、byte/output caps 與 benchmark gate 約束 |
| [htmlparser2](https://github.com/fb55/htmlparser2) / [parse5](https://github.com/inikulin/parse5) | forgiving parser 與 spec-compliant parser 的取捨、DOM/AST substrate、selector engine 邊界 | 中高：JavaScript；屬低階 substrate | 只作 parser substrate，不取代 URL/security/output contracts |
| [Metascraper](https://github.com/microlinkhq/metascraper) | Open Graph、JSON-LD、HTML meta 與 fallback rules | 中高：JavaScript、MIT；dependency/rule set 需控制 | 可作 metadata fallback 參考，先用 fixtures 比較規則價值 |
| [Postlight Parser](https://github.com/postlight/parser) | 正文、作者、日期、lead image 與 domain-specific extractors | 中：JavaScript、Apache-2.0；domain-specific extractors 需警惕膨脹 | 適合 corpus benchmark，不急著和 Readability 同時依賴 |
| [Trafilatura](https://github.com/adbar/trafilatura) | text/metadata/comment extraction、multi-format output、crawl/download/extract 分層 | 概念高／dependency 低：Python | 拆能力和 fixtures；不新增 Python sidecar |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Fit Markdown、BM25 filtering、citations、chunking、CSS/LLM schema extraction、deep crawl recovery | 概念高／dependency 低：Python；browser integration 強 | 借鏡 output contract、waiting UX、LLM-friendly Markdown；不把 LLM extraction 併入 deterministic parser |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | adaptive/resilient selector、pattern-based scraping、single request 到 crawl 的抽象、MCP topic | Watchlist high：Python、BSD-3-Clause、GitHub topic 顯示活躍 | 提升為 extractor/crawl watchlist；任何 self-healing selector 都需獨立 contract 與 fixtures |
| [AutoScraper](https://github.com/alirezamika/autoscraper) | example-driven extraction | Watchlist low：維護度需重查 | 只作概念參考；不列 primary |

## Crawl、search 與 index references

| 專案 | 可借鏡的能力 | 主要限制 | 建議 |
|---|---|---|---|
| [Katana](https://github.com/projectdiscovery/katana) | scope rules、JS endpoint/XHR extraction、similarity dedupe、duration/response/domain caps、headless hybrid | Go security crawler，不是 Node library | 看 URL frontier、scope 與 bounds；不作 MVP dependency |
| [Browsertrix Crawler](https://github.com/webrecorder/browsertrix-crawler) | Brave/Puppeteer browser crawl、CDP capture、WARC/high-fidelity archival | AGPL；目標是 preservation，不是 LLM-ready Reader | 作 archival 與 crawl capture 參考 |
| [SearXNG](https://github.com/searxng/searxng) | metasearch adapters、provider categories、result normalization、privacy-first routing | Python、AGPL；沒有自己的全網 index | 適合獨立部署後由 Groundlane adapter 呼叫；不進 core |
| [Apache Nutch](https://github.com/apache/nutch) | 大規模 crawler、plugin pipeline、long-running index ingestion | Java/Hadoop-oriented，遠超 Container MVP | 研究自建 index 架構；不作近期 runtime |
| [searcharvester](https://github.com/StevenBlack/searcharvester) / [YaCy](https://github.com/yacy/yacy_search_server) / [Marginalia Search](https://github.com/MarginaliaSearch/MarginaliaSearch) | 搜尋來源聚合、self-hosted search/index 邊界、alternative index 思路 | 維護度、部署重量與產品邊界需重查 | Discovery/watchlist；只補 taxonomy，不導向 MVP |
| [webclaw](https://github.com/0xMassi/webclaw) / [crw](https://github.com/us/crw) | Rust local-first extraction/crawl/MCP server、Firecrawl/Tavily-compatible API、HTML-to-Markdown 與 lightweight server 方向 | 新專案；webclaw 為 AGPL-3.0，crw 的 benchmark 與授權需完整審查 | Discovery only；可追蹤輕量 self-hosted extraction/crawl 產品線 |

## Document ingestion references

| 專案 | 可借鏡的能力 | 主要限制 | 建議 |
|---|---|---|---|
| [MarkItDown](https://github.com/microsoft/markitdown) / [anydoc](https://github.com/firecrawl/anydoc) / [Pandoc](https://github.com/jgm/pandoc) | Office/PDF/HTML/image/audio 到 Markdown、Rust/Node/Python document conversion、universal markup conversion、LLM ingestion output | local file threat model 與任意 parser dependency 需隔離；anydoc 不做 scanned/image-only PDF OCR；Pandoc 是 GPL/Haskell/process boundary | 設計 document adapter boundary；遠端 URL、local file ingestion 與 hosted OCR fallback 分開 |
| [Docling](https://github.com/docling-project/docling) / [Unstructured](https://github.com/Unstructured-IO/unstructured) | layout-aware document conversion、partition/chunk/enrich pipeline、table/figure handling、多格式 structured output、GenAI-ready output | Python-heavy；模型/依賴重量、execution ownership 與 enterprise workflow assumptions 需評估 | 高價值 benchmark/reference；不作 MVP default |
| [GROBID](https://github.com/grobidOrg/grobid) | scholarly PDF header、citation、reference、bibliography、full-text structure extraction | Java service/runtime；模型與 service lifecycle 需隔離 | 科學論文／citation-aware document parsing 參考 |
| [Mammoth](https://github.com/mwilliamson/mammoth.js) / [SheetJS](https://github.com/SheetJS/sheetjs) / [Apache POI](https://github.com/apache/poi) | DOCX-to-HTML、spreadsheet data extraction、Microsoft Office document APIs | Mammoth/SheetJS 較貼近 JS adapter；POI 是 Java runtime；SheetJS GitHub repo 指向新 home，需重查 canonical source | Office-specific adapter references；需格式別 fixtures |
| [pdf.js](https://github.com/mozilla/pdf.js) | JavaScript PDF rendering、text layer、page model 與 browser-compatible PDF handling | 偏 viewer/rendering；文字順序、table 與 semantic structure 仍需另外處理 | JS-side PDF inspection/text extraction reference |
| [pdfminer.six](https://github.com/pdfminer/pdfminer.six) / [PyMuPDF](https://github.com/pymupdf/PyMuPDF) / [pypdf](https://github.com/py-pdf/pypdf) | low-level PDF text extraction、page range、metadata、layout primitives、PDF manipulation | Python/native dependency boundary 各不相同；不能直接暴露 host filesystem | PDF low-level adapter candidates，先做 byte/page/time fixtures |
| [pdfplumber](https://github.com/jsvine/pdfplumber) / [Camelot](https://github.com/camelot-dev/camelot) / [Tabula](https://github.com/tabulapdf/tabula-java) | PDF table extraction、line/cell detection、stream/lattice 類 table heuristics | Camelot/Tabula 多針對 text-based PDFs；Java/native dependencies 需隔離 | table extraction benchmark/reference；需 scanned PDF fallback metadata |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) / [RapidOCR](https://github.com/RapidAI/RapidOCR) / [EasyOCR](https://github.com/JaidedAI/EasyOCR) / [docTR](https://github.com/mindee/doctr) / [Surya](https://github.com/datalab-to/surya) | OCR、layout analysis、reading order、table recognition、多語辨識、PDF/image 到 Markdown/JSON；RapidOCR 另提供 ONNX Runtime、OpenVINO、MNN、PaddlePaddle、TensorRT、PyTorch 等 runtime backend 方向 | 模型 artifact、runtime backend、latency、confidence、fallback metadata 需明確；不是每個 OCR engine 都處理 layout/table | OCR/layout backend reference；不作預設 parser |
| [Layout Parser](https://github.com/Layout-Parser/layout-parser) / [OLMOCR](https://github.com/allenai/olmocr) | document image layout analysis、PDF linearization for LLM datasets/training | Layout Parser 維護節奏需重查；OLMOCR 是 model-assisted PDF linearization，不是 deterministic parser | layout/model-assisted watchlist；需和 deterministic parser output 分開標示 |
| [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) / [Tesseract](https://github.com/tesseract-ocr/tesseract) | scanned PDF OCR layer、searchable PDF、OCR engine packaging、deterministic preprocessing | 不應直接處理任意 host filesystem 或寫回文件 | OCR preprocessing reference；受 byte/page/time limits 與 sandbox policy 約束 |
| [Apache Tika](https://github.com/apache/tika) | MIME detection、多格式 text extraction、metadata extraction、server mode | Java service/runtime，format coverage 廣但 output contract 需收斂 | general document parser reference；不直接變成 universal parser |
| [MinerU](https://github.com/opendatalab/MinerU) / [Marker](https://github.com/VikParuchuri/marker) / [Dolphin](https://github.com/bytedance/Dolphin) | PDF layout recovery、OCR、formula/table extraction、document image parsing、PDF/Office 到 Markdown/JSON、benchmark corpus | MinerU 與 Dolphin license metadata 非標準；模型重量、license 與 deployment boundary 需重查 | High-signal watchlist；不列第一批 runtime candidate |
| [opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf) / [pdf-inspector](https://github.com/firecrawl/pdf-inspector) / [anytomd-rs](https://github.com/developer0hye/anytomd-rs) / [FileToMarkdown](https://github.com/jojomondag/FileToMarkdown) / [any2md](https://github.com/rocklambros/any2md) | PDF accessibility、tagged-PDF、scanned vs text-based classification、routing hints、file-to-Markdown experiments | 新專案／scope narrow；需驗證 license、quality 與 maintenance | Discovery；可借鏡 document routing metadata 與 conversion UX |

## Provider docs 與商業服務邊界

這些來源會影響 Groundlane 的 provider adapter、billing wording、output normalization 或產品定位，但不應寫成「開源專案參考」：

| 來源 | 可借鏡的能力 | 明確邊界 |
|---|---|---|
| Tavily、Exa、Jina、Firecrawl、SerpApi、SearchAPI.io、TinyFish | search、contents、reader、rerank、crawl/map、structured extraction 的 hosted API contract | 不複製 index；不把 hosted capability 描述成自架開源能力 |
| Parallel、Linkup、You.com、Keenable | web intelligence control plane、cited/structured result、research API、independent index 或 retrieval workflow | pricing、quota、eligibility 必須查官方頁；不把 provider result 當 Groundlane hidden synthesis |
| Browserbase、Hyperbrowser、Zyte、Bright Data、Apify Platform | managed browser、proxy、CAPTCHA、sessions、Actor marketplace | 商業託管能力走 provider adapter；不混入 open-source runtime list |
| Cloudflare Containers | Worker control plane + isolated Node/Playwright workload | deployment platform，不是 Groundlane core contract 或開源 browser runtime |

## 採用決策

1. 保留 Groundlane 現有安全 fetch 核心，不整包換成別人的 server。
2. `web_fetch`、`web_search`、`web_extract`、`parse` 保持 stateless；stateful browser sessions 另案設計。
3. 參照 Steel 把 browser lifecycle、stateless quick actions 與 stateful sessions 分開，但 MVP 不公開 session handles。
4. 參照 Playwright MCP 的 Streamable HTTP、tool schema、session isolation 與 accessibility snapshot；SSRF、redirect、DNS pinning、subresource policy 仍由 Groundlane 自己處理。
5. 參照 Stagehand、Crawl4AI、Scrapling 的 agent-friendly extraction UX，但 deterministic selector/pattern/schema 與 LLM extraction 必須分開標示。
6. 多頁 crawl 才評估 Crawlee；採用前需證明能沿用 Groundlane 的 URL policy、deadline、bytes、output、concurrency、queue 與 cancellation 邊界。
7. Crawl4AI、Trafilatura、Scrapy 先借鏡契約與 pipeline，不新增 Python sidecar。
8. Document ingestion 先定義 input kind、byte/page/time limits、sandbox/file permission、source spans、confidence、model artifact policy 與 fallback metadata，再評估 MarkItDown、anydoc、Pandoc、Mammoth、SheetJS、Apache POI、Docling、Unstructured、GROBID、pdf.js、pdfminer.six、PaddleOCR、RapidOCR、EasyOCR、docTR、Surya、Layout Parser、OLMOCR、OCRmyPDF、Apache Tika、PyMuPDF、pdfplumber、pypdf、Camelot、Tabula。
9. Browserless、Lightpanda、Firecrawl、HyperAgent、Browsertrix、SearXNG 等授權敏感或大型平台型 repo，在授權與 dependency review 前只作設計參考。
10. Selenium 只保留為 browser automation boundary reference，不導入第二套 driver。

## 授權風險摘要

- 較容易進入 dependency review：Steel（Apache-2.0）、Playwright MCP（Apache-2.0）、Crawlee（Apache-2.0）、Stagehand（MIT）、Metascraper（MIT）、Postlight Parser（Apache-2.0）、Scrapling（BSD-3-Clause）、Docling（MIT）、anydoc（MIT）、PaddleOCR（Apache-2.0）、RapidOCR（Apache-2.0）、EasyOCR（Apache-2.0）、docTR（Apache-2.0）、pdf.js（Apache-2.0）、Mammoth（BSD-2-Clause）、SheetJS（Apache-2.0，但 canonical source 需重查）、Camelot（MIT）、Tabula（MIT）。
- 主要作概念／adapter 參考：Scrapy（BSD-3-Clause，但 Python runtime）、Trafilatura（Python）、Crawl4AI（Python）、MarkItDown（Python）、Pandoc（GPL/Haskell/process boundary）、Unstructured（Python-heavy）、GROBID（Java service）、Apache Tika／Apache POI（Java）、pdfminer.six/PyMuPDF/pdfplumber/pypdf（Python/native dependency boundary）、Surya/Layout Parser/OLMOCR/OCRmyPDF/Tesseract（OCR/model/process boundary）。
- 需要特別審查：Browserless（non-standard / SSPL / commercial）、Lightpanda（AGPL-3.0 / commercial）、Firecrawl server（AGPL-3.0）、HyperAgent（AGPL）、Browsertrix Crawler（AGPL）、SearXNG（AGPL）。
- Discovery only：Chrome DevTools MCP、BrowserMCP、browser-harness、PageAgent、Kuri、webclaw、crw、searcharvester、YaCy、Marginalia Search、MinerU、Marker、GitHub topic/trending 新進專案。
- 授權結論只依當下 repo 標示，不構成法律意見；實際採用仍應鎖定 commit，讀完整 LICENSE、NOTICE、CLA、Docker image 與 transitive dependency license。

## PRD 對齊規則

- PRD 的 `Design influences` 應引用本文件的分類，不應再把 provider docs、商業平台、watchlist、document ingestion 與 primary architecture 混稱為 `primary references`。
- PRD 可把 Steel、Playwright MCP、Stagehand、Crawlee、Scrapy、Mozilla Readability、htmlparser2/parse5、Metascraper/Postlight Parser、Trafilatura、Crawl4AI 作為核心設計影響；document ingestion 則應分成 general conversion、PDF low-level、table extraction、OCR/layout、scientific PDF、routing metadata 幾條子線。
- PRD 應把 Browserless、Lightpanda、Firecrawl、HyperAgent、Browsertrix、SearXNG 標成 license/dependency-gated design references。
- PRD 應把 Scrapling、AutoScraper、Katana、Nutch、Chrome DevTools MCP、BrowserMCP、browser-harness、PageAgent、Kuri、webclaw、crw、searcharvester、YaCy、Marginalia、MinerU、Marker、GitHub Topics、GitHub Trending、OSSInsight 標成 watchlist/discovery。
- PRD 應把 Tavily、Exa、Jina、SerpApi、SearchAPI.io、TinyFish、Parallel、Linkup、You.com、Keenable、Cloudflare Containers 標成 provider/deployment/market references，而不是開源 runtime references。

## 建議先讀的檔案順序

1. Steel：session controller、browser process manager、quick-actions routes、proxy manager。
2. Playwright MCP：HTTP transport、browser context factory、tool registration、snapshot/output handling。
3. Stagehand：`act`、`observe`、`extract` 與 schema validation。
4. Crawlee：AutoscaledPool、SessionPool、ProxyConfiguration、PlaywrightCrawler。
5. Readability、Metascraper、Postlight Parser：Reader/metadata corpus 與 failure semantics。
6. Scrapling、Crawl4AI、Trafilatura：resilient extraction、Markdown output 與 parser benchmark ideas。
7. MarkItDown、anydoc、Pandoc、Mammoth、SheetJS、Apache POI、Docling、Unstructured、GROBID、pdf.js、pdfminer.six、PaddleOCR、RapidOCR、EasyOCR、docTR、Surya、Layout Parser、OLMOCR、OCRmyPDF、Apache Tika、PyMuPDF、pdfplumber、pypdf、Camelot、Tabula：document ingestion adapter threat model 與 fixtures。
