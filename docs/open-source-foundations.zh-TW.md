# 開源技術基礎

[English](open-source-foundations.md) | [繁體中文](open-source-foundations.zh-TW.md)

Groundlane 是小而清楚的 TypeScript control plane，不是任何單一 crawler 或 browser server 的 fork。本文件記錄哪些開源專案影響架構、Groundlane 可能採用什麼，以及哪些邊界刻意保持不同。

完整且會隨時間更新的 reference landscape 放在[開源專案參考清單](research/open-source-references.md)；本頁只保留較穩定的架構決策。

## 決策

Groundlane 保留目前 stateless 的 `web_fetch`、`web_search` 與 `web_extract` 核心；MVP 不加入 crawler framework dependency。

未來真的開始做多頁爬取時，[Crawlee](https://github.com/apify/crawlee) 是第一個實作候選：它使用 TypeScript、採 Apache-2.0 授權，並已有 request queue、retry、session pool、proxy configuration、autoscaling 與 Playwright integration。

其他主要專案則影響契約與內部設計，不會因此增加另一套 production runtime：

| 專案 | Groundlane 借鏡的部分 | Groundlane 不會假設的事 |
|---|---|---|
| [Crawlee](https://github.com/apify/crawlee) | 未來有界 crawl job 的 queue、retry、session、proxy 與 autoscaling | crawler queue 可以取代 Groundlane 的 URL、deadline、byte、output 或 cancellation policy |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | 適合 agent 的 Markdown、structured extraction、crawl result 與等待介面 | MVP 需要 Python sidecar，或 extraction 本身等於 anti-bot 能力 |
| [Scrapy](https://github.com/scrapy/scrapy) | downloader middleware、retry 分類、throttling、去重與營運統計 | 需要第二套 crawler runtime 或 Scrapy-specific 公開契約 |
| [Selenium](https://github.com/SeleniumHQ/selenium) | 跨瀏覽器 automation 的經驗 | 在 Playwright 旁加入第二套 driver，或宣稱 WebDriver 自己能繞過 challenge |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP browser tool 介面、client isolation 與 bounded output | origin flags 可以作為 SSRF security boundary |
| [Steel](https://github.com/steel-dev/steel-browser) | browser session lifecycle 與 process management | 把 stateful session 塞進 Groundlane 的 stateless MVP tools |

## 開源不等於託管網路

SDK 或 crawler 開源，不代表同品牌的 hosted platform 也是開源。例如 Crawlee 與 Apify SDK 是開源專案，Apify 的 managed execution 與 proxy service 則是另一個產品層。Groundlane 整合 hosted anti-bot、proxy、search、reader 或 browser provider 時，也維持相同區分。

因此 Groundlane 把兩件事分開：

```text
crawl orchestration（queue、retry、dedupe、budgets）
                         |
                         v
retrieval backends（safe HTTP、reader、browser、managed anti-bot adapter）
```

開源 orchestration 能提升可靠性與 self-hosting；住宅 IP、CAPTCHA solving、managed fingerprints 與 provider-operated unblocker 仍是明確的 adapters，各自有 credential、定價、隱私與使用條款。

## Crawlee 採用門檻

只有在以下條件全部成立後才加入 Crawlee：

1. Groundlane 已核准 `web_crawl` 或 asynchronous crawl-job contract，不是擴張 `web_fetch`。
2. 每個發現的 URL 與 redirect 都會在 retrieval 前通過既有 URL policy。
3. 單一 job budget 能限制頁數、深度、時間、redirect、response bytes、output bytes、concurrency 與 queue size。
4. Cancellation 能停止 queued／active work，並釋放 browser、proxy 與 network resources。
5. Request queue 與 result persistence 有明確 ownership、retention、tenancy 與 cleanup semantics。
6. Crawlee 的 retry／session 行為能映射到 Groundlane stable errors，而且不會暗中重設 deadline。
7. 測試不需 live provider credentials 或 unrestricted external network。

在這些條件完成前，目前的 fetch pipeline 更小、更容易審核，也更符合三個 stateless MCP tools 的需要。

## 第一個有界 crawl 契約

下一個 crawl primitive 應刻意保持狹窄：

```text
web_crawl(
  startUrl,
  maxPages,
  maxDepth,
  includePatterns,
  excludePatterns,
  render,
  timeoutMs,
  maxBytesPerPage,
  maxTotalOutputChars
)
```

它應回傳正規化的逐頁結果、略過／失敗 URL 摘要，以及明確的 budget exhaustion metadata。它不代表 persistent crawler fleet、無限制遞迴爬取、通用 anti-bot bypass，也不代表可以忽略網站政策。

## 授權紀律

複製程式碼或新增 dependency 前，貢獻者必須鎖定已審查 revision、閱讀 LICENSE／NOTICE、檢查 transitive licenses、保留必要 attribution，並記錄此次使用屬於 source reuse、dependency use、protocol compatibility 或 architectural inspiration。本文件是工程決策，不是法律意見。
