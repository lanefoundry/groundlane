<div align="center">

# Groundlane

**AI agent 值得信賴的 Web 存取層。**

[![CI](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml/badge.svg)](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-early_preview-orange.svg)

[快速開始](#快速開始) · [連接 Client](#連接-mcp-client) · [工具](#工具一覽) · [部署](#執行-groundlane) · [文件](#文件)

[English](README.md) · [繁體中文](README.zh-TW.md)

</div>

Groundlane 是開源的遠端 MCP server，也是 AI agent 的可信內容存取層。目前透過同一套受控介面提供 Web 搜尋、內容取得、確定性結構化抽取，以及 URL/raw HTML parsing。完整 document-processing roadmap 以結構化 conversion、deterministic extraction 與明確啟用的 model-assisted parsing 三層，涵蓋 Office/ODF/RTF、spreadsheets 與 structured text、EPUB/email、text/scanned/complex PDF、images、audio、tables、formulas、figures、metadata 與 citations。Document source 使用 bounded inline bytes、經 policy 檢查的公開 URL 或不透明且 storage-neutral 的 artifact reference；Cloudflare reference flow 由支援 upload handoff 的 client、Groundlane CLI 或 dashboard 使用短效 presigned URL，把大型／私人檔案直傳 R2 staging object，驗證並 immutable finalization 後才產生 opaque artifact reference。短效 R2 coordinate 不是公開 artifact identity，也不會被重用為 tool argument。Document processing 不會隱含建立 durable artifact、corpus membership 或 index；未來 file/document tool family 可使用下方公開說明的 bounded transient cache。Roadmap 也納入明確啟用的 operator-owned corpus control plane：Groundlane 負責可攜的 corpus identity、source enrollment、access、freshness、deletion 與 citation contracts，indexing 和 ranking backend 則保持可替換。Groundlane 不綁模型，將可替換 provider 收斂成穩定契約，並讓 operator 掌握 authentication 與資源限制；每種 roadmap format 與 corpus capability 都要個別通過安全、fixture、provenance、isolation 與品質 gate，才能稱為已支援。

> [!IMPORTANT]
> Groundlane 目前是早期預覽版（`0.1.0`），工具契約與部署行為仍可能調整。目標中的 OSS V1 Stable Release 是 operator-hosted open-source product；Managed Groundlane Cloud 已列入後續 roadmap，但目前還不是可用服務。Groundlane 不是 CAPTCHA solver，也不保證繞過所有反爬機制。

OSS V1 Stable 規劃為 Web + document release，不是純 Web release。Stable document profiles 目標包含 text-based PDF；DOCX、XLSX、PPTX；CSV、TXT、Markdown、JSON、XML、HTML；以及有明確 omissions、會拒絕 active、encrypted、nested 或 unsupported content 的 bounded ODF、RTF、EPUB、EML profiles。Scanned-PDF/image OCR、legacy Office conversion、complex layout/table/formula/figure recovery、scholarly extraction 與 bounded audio transcription 只有在各自品質、隔離、成本與 provenance gate 通過後，才可作 opt-in experimental engines 隨 V1 提供。Video processing 與 universal document fidelity 不屬於 V1 承諾。目前的 `parse` tool 尚未實作上述任何 file/document capability。

Document roadmap 採可配置且有界的 retention，不會默默永久保存。Working defaults 是 upload intent 15 分鐘、staging cleanup window 一小時、transient artifact 24 小時，以及 ownership-scoped processing cache 24 小時。Caller 可在 operator 公告範圍內調整 upload、artifact 與 cache expiry；超界 request 直接拒絕，不會靜默 clamp。Staging cleanup window 只由 operator 控制。Operator 可透過可觀測的 document policy 調整 defaults/maxima 或關閉 cache。明確 corpus enrollment 使用自己的 retention policy，預設保存到移除；延長 expiry 必須 explicit。

未來 document output 的 authoritative contract 是 versioned、provider-neutral canonical document envelope，第一版以 JSON serialization 傳輸。可重用 content core 與 per-source identity/provenance 分開 cache，避免相同 bytes 來自不同 URL 或 artifact 時沿用錯誤來源。Markdown 是預設的 agent-facing projection，不是 source of truth；text、structured 與 all-output mode 由 caller 明確選擇。Projection 需揭露 version、lossiness、omissions 與 canonical source references；任何超限 document output 都回 typed opaque result `ArtifactRef`，它與 cache entry 分開，也不能未經 explicit conversion 重新當 source。現有 URL/raw-HTML `parse` schema 保持相容，目前尚未實作此 roadmap contract。

未來 document execution 採明確雙軌。有界的 deterministic conversion/extraction 可在單一 end-to-end deadline 內同步完成；long-running work 使用 caller 明確建立的 async job。兩條路徑共用 canonical envelope、artifact、cache、provenance、policy 與 error contracts。同步 request 不會因 timeout、output size、queue pressure、fallback 或 engine choice 被 silent 轉成 durable job。第一個 async slice 會在 MCP Tasks 相容性驗證後代理 provider-owned document jobs；client support 不足時，再提供 explicit start/status/result/cancel tools。Groundlane 自行執行 long-running OCR、layout/VLM、audio 或其他文件工作，仍需另過 durable orchestration、volume、cost 與 isolation gate。目前 `parse` 尚未實作這套 lifecycle。

## 工具一覽

| 工具 | 功能 | 目前執行路徑 |
| --- | --- | --- |
| `web_fetch` | 將公開 URL 讀成 Markdown、text 或 HTML | bounded HTTP、本機正文正規化，以及符合條件時選用的 Jina/browser fallback |
| `web_search` | 搜尋公開 Web 並回傳正規化結果 | 十三個 provider 的有界自動融合、失敗時下一批 retry、明確單一來源、fallback 或 deep routing |
| `web_answer` | 從支援 answer 的 provider 取得 grounded answer | 並行 fan-out 或 fallback 到 You.com Answer 與 Linkup sourced answer，保留 provider attribution 與 citations |
| `web_research` | 從支援 research 的 provider 取得研究報告 | 並行 fan-out 或 fallback 到 Linkup Research、You.com Research 與 Parallel Responses，保留 citations |
| `web_content` | 透過 provider content API 抓取 URL 內容 | 並行 fan-out 或 fallback 到 Linkup Fetch、You.com Contents、Exa Contents、Tavily Extract、Firecrawl Scrape、TinyFish Fetch、Keenable Fetch |
| `web_map` | 從公開網站探索 URL | 並行 fan-out 或 fallback 到 Firecrawl Map 與 Tavily Map，保留 provider attribution |
| `web_crawl` | 對公開網站做有界 crawl | 並行 fan-out 或 fallback 到 Firecrawl Crawl 與 Tavily Crawl，限制頁數與內容大小 |
| `web_news` | 搜尋 news-specific provider index | 並行 fan-out 或 fallback 到 Brave News、Serper News、SerpApi Google News |
| `web_images` | 搜尋 image-specific provider index | 並行 fan-out 或 fallback 到 Brave Images、Serper Images、SerpApi Google Images |
| `web_extract` | 抽取具名欄位為結構化 JSON | Deterministic selector 與 bounded pattern engines，可設定單次 output cap；不暗中呼叫 LLM |
| `parse` | 將 URL 或 raw HTML 解析成可重用結構 | 本地 document、metadata、link、media 與 table parser；URL input 會先走 bounded fetch pipeline |
| `provider_balance` | 查詢 provider 帳號餘額 API | Linkup credits、You.com keyed credits、Firecrawl remaining credits、SerpApi searches left；未支援的 provider 會回明確診斷狀態 |
| `provider_capabilities` | 列出各 provider 功能與 Groundlane surface | 靜態 capability matrix，區分 vendor 自家功能與 Groundlane 目前實作工具 |
| `provider_quota` | 整合帳號餘額、本機工具 budget、capabilities 與 routing hints | provider-scoped 診斷視圖，同時看 billing status、Groundlane provider-dispatch guardrail、已 expose 工具、keyless 可用性與下一步檢查 |
| `search_budget_status` | 檢查 Groundlane 本機 provider attempt guardrail | process 內 daily/monthly counters，包含 limit、used、remaining、exhausted 與 reset metadata；不是 provider 帳務真相 |
| `error_log` | Operator-only：查詢 Groundlane error log | Cloudflare Analytics Engine 查詢，可依 tool、code、hintCode 或時間範圍過濾；回傳最多 `limit` 筆最近的 matching events，由新到舊 |

Fetch/extract/parse 在抓 URL 時會回報 `engine`、`backend`、`finalUrl`、`bytes`、`truncated` 等 retrieval provenance。自動搜尋預設每批最多選兩個互補 provider，經 canonical URL 去重與 RRF 融合後仍保留 selected/attempted/succeeded provider provenance；若某批 federated provider 全失敗，Groundlane 會在同一個 deadline 內嘗試下一批 eligible providers。非明確指定 provider 的 `web_search` fallback 會把單一 provider rejection、timeout、quota error、5xx 或 malformed response 視為 warning，並繼續嘗試下一個 eligible provider；明確指定 `provider` 時則保留該 provider 的錯誤，不會靜默切換來源。`web_answer`、`web_research`、`web_content`、`web_map`、`web_crawl`、`web_news` 與 `web_images` 預設並行 fan-out，並分別回傳各 provider 的結果，不做隱藏合成。明確指定 provider 時維持單一來源。沒有 search provider key 時，`web_fetch`、`web_extract` 與 URL-backed `parse` 仍可運作。

各 provider vendor 自家還有更多 API，Groundlane 目前沒有全部接成 MCP tool。請看 [provider inventory](docs/operations/provider-inventory.md) 的已查證 backlog，以及 vendor capability、已實作 Groundlane tool、live smoke、帳號餘額證據與 Groundlane 本機 attempt budget 之間的區分。

當 provider-backed tool 耗盡本機 attempt 或 `web_search` 回傳 0 results 時，先看 `provider_quota`：它會把 provider account-balance status、Groundlane 本機 provider-dispatch budget、已實作工具與 `searchRouting` hints 放在同一個視圖。`provider_balance` 只用來查 provider-owned account credits；`search_budget_status` 則用來細查本機 attempt counters。Balance 的 `not_configured` 代表 runtime 沒有該 provider balance API 需要的 credential，不代表 keyless quota 已耗盡。

### Research 相容性

`web_research` 刻意維持一個同步 MCP contract，即使 upstream provider 本身是 async。You.com Research 與 Parallel Responses 是同步回應；Linkup Research 則由 Groundlane 先以 `POST /v1/research` 建立 upstream task，再在同一個 request deadline 內輪詢 `GET /v1/research/{id}`，完成時回傳 report 與 citations。

較長的 Linkup research job 可能超過 MCP request。這時 Groundlane 會回有界的 timeout/cancellation error，不會無限等待；upstream provider task 仍可能在 Groundlane 之外繼續執行。想走最低成本的有界 Linkup path 時，使用 `effort=lite`、`strategy=fallback`、`provider=linkup`。

## 快速開始

需求：Node.js 22+、pnpm 10 與 Git。只有啟用 local browser backend 時才需要 Chromium。

```bash
git clone https://github.com/vincentxuu/groundlane.git
cd groundlane
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

在 `.env` 設定一組足夠長且隨機的 `GROUNDLANE_AUTH_TOKEN`，然後啟動 server：

```bash
set -a
source .env
set +a
pnpm dev
```

Groundlane 現在會在 `http://localhost:8080/mcp` 提供需要驗證的 Streamable HTTP MCP endpoint。Search key 是選填，只需設定想啟用的 provider。Keenable 可在沒有 key 時走 public endpoint，You.com 可在沒有 key 時走 free MCP Search profile；只有要使用 authenticated account allowance 時才設定 provider key。

### 部署到 Cloudflare

第一次部署到 Cloudflare 時，先登入 Wrangler、建立 OAuth 用的 KV
namespace、檢查目標環境已設定的 secret 名稱，再輸入兩組必要的
authentication secret 與選用的 provider keys，最後部署：

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler kv namespace create OAUTH_KV
# 把回傳的 id 貼進 wrangler.jsonc 的 kv_namespaces[0].id
pnpm secrets:status
pnpm secrets:setup
pnpm run deploy
```

這幾個 secret 指令只會操作 Cloudflare，不會讀取或修改本機 `.env`。
未指定 `--env` 時，Wrangler 會操作 `wrangler.jsonc` 的 top-level target；
若選用 named environment，status、setup 與 deploy 必須使用相同的 `--env`。

有兩組 authentication secret 是必要的，而且**值必須不同**：

- `GROUNDLANE_AUTH_TOKEN`——headless/CLI client（Codex、Claude Code、排程/雲端
  自動化）呼叫 `/mcp` 時用的 bearer token。
- `OAUTH_OWNER_PASSPHRASE`——把關互動式雲端連接器（claude.ai、ChatGPT）看到的
  `/authorize` 同意畫面。跟 bearer token 共用同一個值的話，同意頁一旦被釣魚就會
  連帶洩漏所有 headless client 在用的那組 token，所以要分開產生。

各自產生至少 32 個隨機字元，例如：

```bash
openssl rand -hex 32
```

把兩組都存進密碼管理器。執行 `pnpm secrets:setup`，在編號清單裡這兩個會列在
`authentication` 分類下（依序是 `GROUNDLANE_AUTH_TOKEN`、
`OAUTH_OWNER_PASSPHRASE`）——兩個都選，例如輸入 `1,2`，接著依提示分別貼上兩組
值（輸入時不會顯示字元，也不會回顯）。Search provider keys 全部選填。執行
`pnpm secrets:setup -- --help` 可查看安全的互動設定流程。Setup 會先顯示
一份編號清單；輸入例如 `2,4-6` 即可複選，接著只詢問選中的值，最後一次
bulk 更新。若想一次貼完，可將
[`cloudflare-secrets.example.env`](cloudflare-secrets.example.env) 複製成已被
git 忽略的 `.cloudflare-secrets.env`，填入需要的值後執行：

```bash
pnpm secrets:setup -- --from-file .cloudflare-secrets.env --dry-run
pnpm secrets:setup -- --from-file .cloudflare-secrets.env
```

匯入支援 `.env` 或 JSON，會拒絕未知名稱，也不會印出 secret 值。不需要
在本機保留時，設定完成後請刪除填過值的檔案。
部署後請依照 [Cloudflare 部署指南](docs/deployment/cloudflare.md)驗證 health、
readiness、authentication 與 MCP 行為。

push 到 `main` 後，GitHub Actions 會在 CI quality job 成功後自動部署。Repo
必須設定 `CLOUDFLARE_ACCOUNT_ID` 與 `CLOUDFLARE_API_TOKEN` Actions secrets，
並設定 `GROUNDLANE_AUTH_TOKEN` 給 post-deploy smoke 使用；詳見
[GitHub 持續部署](docs/deployment/cloudflare.md#continuous-deployment-from-github)。

Cloudflare Container deploy 會先在本機 build Docker image 再上傳。如果 `pnpm run deploy` 卡在讀取 Docker Hub metadata 或拉取 `node:22-bookworm-slim`，先檢查本機 Docker credential helper；這是本機 Docker／registry 問題，不是 Worker 或 TypeScript build 的結果。production smoke 才是最終部署證據：

```bash
GROUNDLANE_MCP_URL="https://your-worker.example/mcp" pnpm smoke
```

CI deploy 後會跑 `pnpm run wait:container` 和 `pnpm run smoke:retry`，所以
成功的 run 代表 Cloudflare Container application 已離開 provisioning，且
production MCP server 會回應預期的 tool contracts。Runtime 中，當 Cloudflare
回報 named Container instance 尚未 running 時，Worker 也會在已驗證的
`/readyz` 與 `/mcp` request 前先啟動該 instance。

## 連接 MCP client

在啟動 client 的 shell 匯出同一組 token：

```bash
export GROUNDLANE_AUTH_TOKEN="your-long-random-secret"
```

### Codex

```bash
codex mcp add groundlane \
  --url http://localhost:8080/mcp \
  --bearer-token-env-var GROUNDLANE_AUTH_TOKEN
```

### Claude Code

```bash
claude mcp add --transport http --scope user groundlane \
  http://localhost:8080/mcp \
  --header "Authorization: Bearer ${GROUNDLANE_AUTH_TOKEN}"
```

Claude Code 指令會把展開後的 token 寫入 MCP 設定。共用或正式環境應改用 secret-backed header helper，避免明文保存 token。

無人值守的排程／雲端自動化（cron、雲端 routine、workflow runner）也是用這組
bearer token：只要在該平台把 `GROUNDLANE_AUTH_TOKEN` 設成一次性 secret 即可，
不需要 OAuth。

### claude.ai / ChatGPT（OAuth）

互動式雲端連接器（claude.ai、ChatGPT 的 Custom Connector）認的是 OAuth，不接受
直接貼 API key。新增連接器時貼上部署好的 Worker `/mcp` 網址
（`https://your-worker.example/mcp`）。現代 client 可透過 CIMD 註冊，不需要另外
預註冊；DCR 相容 endpoint（`/register`）則需要 bearer token，避免未驗證流量
累積 OAuth state。細節見[Cloudflare 部署文件](docs/deployment/cloudflare.md)。
註冊完成後會跳出同意畫面。輸入部署時設定的 `OAUTH_OWNER_PASSPHRASE` 完成授權——
這是獨立於 `GROUNDLANE_AUTH_TOKEN` 的另一組 secret，僅用來把關這個同意畫面。

### 第一次呼叫

請 client 呼叫 `web_fetch`：

```json
{
  "url": "https://example.com/",
  "format": "markdown",
  "render": "never"
}
```

結構化回應會包含以下 envelope（節錄）：

```json
{
  "ok": true,
  "data": {
    "finalUrl": "https://example.com/",
    "title": "Example Domain",
    "content": "This domain is for use in illustrative examples...",
    "engine": "http",
    "backend": "direct",
    "truncated": false
  }
}
```

Server 執行時可用 `pnpm smoke` 驗證 MCP handshake，並對 `example.com` 呼叫 `web_fetch` 與 `web_extract`。

## 為什麼選 Groundlane？

- **一套 MCP 契約：**client 不需要理解每個 provider 的專屬 tool schema。
- **HTTP 優先：**普通內容不付 browser 成本；只有 rendering 與 wait condition 才動用 Chromium。
- **確定性抽取：**CSS selector 直接產生 structured output，不加入未要求的模型推論。
- **預設有界：**URL policy、DNS／redirect checks、單一 deadline、bytes／output caps 與 concurrency limits 都留在 Groundlane boundary。
- **Hosted fallback 必須明確啟用：**只有 operator 主動設定時才會把 preflight 驗證後的 public final URL 傳給 Jina Reader 或 Browserless。

## 執行 Groundlane

| 模式 | 適合情境 | 入口 |
| --- | --- | --- |
| Local Node | 開發與評估 | [快速開始](#快速開始) |
| Docker | 獨立 Node／Chromium container | `docker build -t groundlane .`，再執行 `docker run --rm -p 8080:8080 --env-file .env groundlane` |
| Cloudflare Worker + Container | 預期的 production topology | [部署到 Cloudflare](#部署到-cloudflare) |

## 支援的 adapters

| Groundlane 能力 | 已實作 adapters |
| --- | --- |
| Search | Linkup、Keenable、TinyFish、Parallel、Browserbase、Brave、SerpApi、SearchAPI.io、Tavily、Exa、Firecrawl、Serper、You.com |
| Grounded answer | Linkup、You.com |
| Research report | Linkup、You.com、Parallel |
| URL content API | Linkup、You.com、Exa、Tavily、Firecrawl、TinyFish、Keenable |
| Site map discovery | Firecrawl、Tavily |
| Bounded site crawl | Firecrawl、Tavily |
| News search | Brave、Serper、SerpApi |
| Image search | Brave、Serper、SerpApi |
| Account balance | Linkup、You.com、Firecrawl、SerpApi |
| Quota diagnostics | Provider quota summary 與本機 provider budget status |
| Hosted Reader fallback | Jina Reader（opt-in） |
| Browser rendering | Local Playwright 或 Browserless（opt-in） |
| Cloudflare runtime | 目前支援 Worker + Container deployment；Browser Run、AI Search、AI Gateway、Agents 與 Workflows 是已查到的未來 adapter surface |

### Provider 功能、收費與免費額度

以下資料於 **2026-08-30** 逐一查核 provider 官方 pricing／billing 頁。價格是未含可能稅額的公開美元牌價；enterprise 合約與登入後帳戶 offer 可能不同。「Groundlane tools」只列目前已有 runtime path 的功能，不把廠商尚未接入的產品算進來。月度／每日額度、餘額補回、持續限速免費與一次性 signup credits 也分開記錄。完整判斷方法與更多 browser／scraping 服務請看[免費搜尋、爬取與 Browser API 怎麼選](https://quidproquo.cc/posts/ai/2026-08-21-free-search-scraping-tools/)。

| Provider | Groundlane tools | 與目前工具相關的公開收費 | 免費額度與重要條件 |
| --- | --- | --- | --- |
| [Tavily](https://docs.tavily.com/documentation/api-credits) | Search、Content/Extract、Map、Crawl | PAYG 每 credit `$0.008`；basic／advanced Search 分別用 1／2 credits；Extract、Map、Crawl 依成功頁數公式扣 credit | 每月 1,000 credits，每月 1 日重置；免信用卡 |
| [Exa](https://exa.ai/docs/reference/pricing) | Search、Content | Search 起價 `$7/1k` requests；Contents 每個指定 content type 為 `$1/1k` pages；較深的 search mode 另有較高單價 | 新帳號一次取得 `$20`，之後每月 `$10` credits；免 payment method；reset anchor／rollover 未公開 |
| [Parallel](https://parallel.ai/pricing) | Search、Research | 10 results 的 Search 為 `$1–$5/1k` requests；Responses research 依 processor 為 `$10–$250/1k` | Eligible organization 每月 `$5`；必須綁卡、每張卡限一個 org，未用額度月底失效；signup／startup promotion 有另外的資格 |
| [Browserbase](https://docs.browserbase.com/account/billing/plans.md) | 只有 Search | Developer 每月 `$20`；付費方案 Search 超額為 `$7/1k` calls。Browser sessions、Fetch、Extract、Agents 是廠商功能，Groundlane 尚未暴露 | Free 每月含 1,000 次 Search 與 1 browser hour、3 concurrent sessions；免卡；Free Search 不提供 overage |
| [Brave](https://api-dashboard.search.brave.com/documentation/pricing) | Search、News、Images | Search 為 `$5/1k` requests。Brave Answers 採 query 加 token 的不同價格，且不是 Groundlane tool | 每個已選 product plan 每月有 `$5` credit；需綁卡做 anti-fraud 驗證；官方免費 credit 條款另要求 attribution |
| [Firecrawl](https://docs.firecrawl.dev/billing) | Search、Content/Scrape、Map、Crawl | Scrape／Crawl 每頁 1 credit、Map 每 call 1 credit、Search 每 10 results 2 credits；付費 self-serve plan 可買依方案換算的 `$5` reload batch | 每月 1,000 credits、免卡，通常不 rollover。Auto-reload 可設定上限或關閉。官方公開頁目前有一個 Standard headline 價格衝突，採購前需回 checkout 確認 |
| [SerpApi](https://serpapi.com/pricing) | Search、News、Images | Starter 每月 `$25`／1,000 次成功 searches；Developer `$75`／5,000。Cached、errored、failed search 不扣 | 每 billing cycle 250 次成功 searches，renewal 時重置；現行公開頁未說 Free 是否需綁卡 |
| [SearchAPI.io](https://www.searchapi.io/pricing) | Search | Developer 每月 `$40`／10,000 次成功 searches（`$4/1k`）；較大方案單價下降。只有 HTTP 200 search 計費 | 註冊 100 requests、免卡；這是有限 trial，沒有官方月度恢復說明；Groundlane 預設維持 opt-in |
| [Linkup](https://docs.linkup.so/pages/documentation/platform/pricing) | Search、Answer、Research、Content/Fetch | Standard Search `$0.005`、sourced answer `$0.006`、deep Search `$0.05–$0.055`；Fetch `$0.001–$0.01`；Research 每 call `$0.25–$2.50` | Professional email 註冊取得 `$20`；eligible account 每月是把餘額**補回** `$20`，不是固定再送 `$20`。資格與 top-up 日期未完整公開 |
| [Keenable](https://keenable.ai/pricing) | Search、Content/Fetch | 公開 headline 為 `$4/1k` requests，100 RPS+ 為 `$1/1k`；實際 SKU usage 可能不同，應讀 response usage | Verified organization 每月 100,000 requests。Keyless public Search／Fetch 不用這池額度，而是 per-IP shared pool：每小時 1,000、每秒 10 次 |
| [Serper](https://serper.dev/#pricing) | Search、News、Images | Prepaid pack 從 `$50`／50,000 queries（`$1/1k`）起，最大公開方案降至 `$0.30/1k`；購買的 credits 六個月後到期 | 註冊 2,500 queries、免卡；沒有官方月度 reset；Groundlane 預設維持 opt-in |
| [You.com](https://you.com/docs/administration/billing) | Search、Answer、Research、Content | Search 與 Answer 都是 `$5/1k` calls；Contents `$1/1k` pages；Research 從 `$12/1k` 起，依 effort tier 上升 | Keyless Search 每日 100 queries；有 key 的新帳號另有一次性 `$100` starter credit、免卡。兩者是不同額度；auto top-up 為 opt-in，且目前沒有 monthly spending cap |
| [TinyFish](https://www.tinyfish.ai/pricing) | Search、Content/Fetch | Search、Fetch 都是 `$0`；廠商 Agent `$0.016/step`、Browser `$0.002/minute`，但 Groundlane 未暴露這兩個付費 surface | Wallet 為 `$0` 時 Search 仍有 30 requests/minute、Fetch 150 URLs/minute 的免費額度；仍需 API key。新帳號 `$8` Wallet 是一次性，只供付費 surface 使用 |

Provider-backed routing 可套用保守的 per-instance 每月與每日嘗試次數 budget。這只是應用層護欄，不是 provider 帳務真相；provider dashboard 與 spend limit 仍是權威。`provider_quota` 會整合帳戶餘額、Groundlane 本機 provider-dispatch budget 與 capabilities；`provider_balance` 只會回報已實作官方 balance API 的 provider，目前是 Linkup、You.com、Firecrawl 與 SerpApi。Exa、Browserbase 與 Cloudflare 比較適合做 usage/cost diagnostics。Credentials、routing、limits 與 budget 語意請看[設定文件](docs/configuration.md)，目前 production provider 狀態、功能矩陣與 balance API 查證請看 [Provider inventory](docs/operations/provider-inventory.md)。

### Provider selection

自動 `web_search` 會依 `SEARCH_PROVIDER_ORDER`、capability filtering、provider health 與 attempt budgets 選 provider。預設順序優先放 renewable 或 account-backed provider，保留 keyless Keenable 與 You.com 作為低摩擦 fallback，並讓不可續用或無法用 API 量測餘額的 finite-trial provider 維持 opt-in。明確指定 `provider` 會跳過自動排序，但仍必須通過 credential、capability、URL safety 與 budget 檢查。

`web_search` 以外的 provider-backed tools 若使用 `strategy=parallel`，會回傳每個 selected provider 的 attributed results；若使用 `strategy=fallback`，會在第一個成功 provider 停下來以降低花費。

### Runtime 與帳務邊界

Cloudflare 目前是 Groundlane 的 production runtime，同時也有可成為未來 Groundlane adapter 的相關能力。AI Search 是給 operator-provided data 用的 managed search service，支援 Workers、REST 與 MCP。Browser Run / Browser Rendering 透過 REST API 或 Workers binding 提供 content、markdown、screenshot、PDF、accessibility tree、links、crawl 與 structured JSON browser actions。Agents 與 Workflows 提供 durable agent sessions、scheduled work、WebSockets、可恢復 steps 與 tool orchestration。AI Gateway 可提供 model observability、caching、retries、rate limiting 與 fallback。

這些服務和 provider router 裡的 public-web search providers 不是同一層。因此 Cloudflare 不會列在 `provider_balance`：這個 tool 只查詢 web-data provider 官方 API 暴露的 account balance，目前是 Linkup credits、You.com API credits、Firecrawl remaining credits 與 SerpApi searches left。

Cloudflare usage 需要透過 Cloudflare dashboard、billing exports、logs、metrics，或未來獨立的 Cloudflare diagnostics 追蹤。Container 成本看的是 active runtime resource，例如 vCPU、memory、disk、egress、Workers、Durable Objects 與 logs；這些單位和 search-provider requests/credits 是不同帳。Groundlane 的 local budgets 不會限制 Cloudflare runtime 花費。

未來 Cloudflare-specific Groundlane work 應該和 search-provider routing 分開：例如 Browser Run backend 給 rendered `web_fetch` / `web_content`、AI Search adapter 給 private/operator-owned indexes、Cloudflare diagnostics 查 runtime usage，以及用 Workflows 支撐長時間 research 或 crawl jobs。

大型 generated documentation sites 需要 source-aware parsing，而不是直接抽整頁 HTML。Cloudflare docs 有 Markdown pages、scoped `llms.txt` / `llms-full.txt` indexes，以及 API reference 的 OpenAPI schemas。Groundlane 對 Cloudflare docs 和類似網站應優先使用這些 machine-readable sources，再依 product、endpoint、heading 或 schema operation 切段。單純提高 `maxBytes` 或抽整個 `main` 是最後手段，因為還沒切到有用段落前就可能先撞到 output limits。目前 runtime path 會對 likely documentation URL 的 Markdown/text `web_fetch` 主動嘗試同 URL 的 `Accept: text/markdown`，再嘗試 Cloudflare-style `/index.md` source，並在 bounded direct failure 後查 same-origin scoped/root `llms.txt` manifest 找最接近的 Markdown page。一般 `/api/v1/...` machine API 不會只因 path 含有 `api` 就被當成文件頁，source discovery 也不會吞掉 request deadline 或 cancellation。Source Markdown cleanup 會先移除 front matter 與常見 docs chrome，再套用正常 output truncation。OpenAPI slicing 目前是純 JSON logic，等大型 schema discovery 有明確邊界後再自動接入 runtime fetch。

## 運作方式

```text
MCP client
    |
    v
Worker / Node HTTP edge       authentication, request identity
                              production 由 Cloudflare 承載
    |
    v
tool registry                 web_search | web_answer | web_research | web_content | web_map | web_crawl
                              web_news | web_images | web_fetch | web_extract | parse
                              diagnostics: provider_quota | provider_balance | search_budget_status | provider_capabilities | error_log
    |
    +-- provider router       可替換的 search adapters
    +-- safe HTTP + Reader    有界的內容取得與正文清理
    `-- browser backend       隔離的 local 或 hosted rendering
```

核心政策不依賴特定 search provider 或 browser runtime。未指定 selector 的 Markdown/text 會由 Mozilla Readability 與本機 fallback 清理；raw HTML 與明確 selector 則維持 deterministic DOM semantics。詳見[架構文件](docs/architecture.md)與可重跑的 [Reader benchmark](docs/research/reader-benchmark.md)。

## 安全與限制

Web retrieval 具有 SSRF 風險。Groundlane 將使用者 URL、redirect、provider 回傳 URL、browser subresource、WebSocket 與 DNS answer 全部視為不可信輸入。正式環境應保持 authentication、保留預設 limits，並套用 outbound network policy。

Groundlane **不保證**解開 CAPTCHA、隱藏自動化特徵，或取得 operator 原本無權存取的內容。能 render JavaScript 不代表已證明可繞過反爬。Local browser 最多等待偵測到的 access challenge 五秒；若原始 request deadline 沒有先到期，持續存在的 challenge 會回傳 retryable `UPSTREAM_ERROR`，stage 為 `browser-challenge`。`web_fetch` 不會自行花費 provider credits 轉用 `web_content`，caller 必須明確選擇 provider-backed retrieval。Threat model 與私下通報漏洞的方式請看 [SECURITY.md](SECURITY.md)。

## 專案狀態

- 目前 source version：`0.1.0` early preview，尚無穩定 tool-contract 保證。
- 已完成：十個 Web access MCP tools、四個 durable-crawl job tools（`crawl_create/status/result/cancel`）、一個 provider-backed schema extraction tool（`web_extract_schema`，benchmark-gated）、一個 document policy tool（`document_policy`）、七個 corpus lifecycle／search tools、一個 parser MCP tool、四個 provider 診斷 MCP tools、一個 operator 診斷 MCP tool、十三個 search adapters、provider-backed answer/research/content/map/crawl/news/images paths、自架 Reader、選用 Jina／Browserless backends、Cloudflare Worker + Container deployment，以及新增的 in-process runtimes（含 deterministic tests）：single-tenant multi-credential auth（統一 principal contract、managed-token rotation/revoke/audit、admin-only credential API、signed Worker→Container context）、corpus lifecycle／manifest truth source、async-task／durable-crawl lifecycle（含 idempotency guards）、single-URL schema extraction、document input／upload／artifact lifecycle、document cache／canonical-envelope／sync-async execution runtimes（含 deterministic tests）、stateful-resource／authenticated-session gates，以及 `groundlane credentials` operator CLI（`tsx scripts/groundlane-credentials.mts`）。新增 runtimes 使用 in-memory／fake ports（含 deterministic tests）；live D1／R2 綁定與 live client／smoke 驗證仍待後續。
- 下一步：把新的 multi-credential principal contract、managed-token registry runtime（fake-D1 port，已有 deterministic tests；live D1 綁定與 controlled smoke 待後續）與 admin-only credential API 接上 deployment（operator CLI 已可用：`tsx scripts/groundlane-credentials.mts`，建議加 package.json script，不加 `bin`）。新的 admin secret 會和既有 `GROUNDLANE_AUTH_TOKEN` 隔離；後者只保留為 legacy/local data-plane credential，永遠不取得 credential-management 權限。其他下一步包括補強工具契約與相容性 fixtures，保存 machine-readable Reader/parser/extractor benchmark artifacts，評估 async research API surface，加入 stateless login/challenge diagnostics，並先對新的 async-task lifecycle runtime 執行 live Claude／Codex／Cursor 驗證，再決定 async research API。短研究維持同步，provider 結果維持分開。已核准的 document-source contract 是 bounded inline bytes、經 policy 檢查的公開 URL 或 Groundlane-issued opaque `ArtifactRef`；Cloudflare reference upload path 由 MCP 建立 provisional upload intent，再由支援 upload handoff 的 client、CLI 或 dashboard 以 presigned PUT 直傳 R2 staging object，驗證與 immutable finalization 後才產生 artifact reference，self-host 則可替換 artifact backend。Operator-owned corpus lifecycle 與 `corpus_search` 已掛載（in-memory backend port），後續工作是 managed／external backend adapters。Scoped 結果帶有明確 corpus、freshness、access control、retention、deletion 與 backend provenance，不改變 public-Web `web_search`。泛用 LLM extraction、monitoring/scheduling、persistent authenticated browser sessions 與 Groundlane-owned durable orchestration仍是需逐項 demand gate 的 roadmap 候選，不是已承諾的 runtime 功能。未來若加入 authenticated browser，會使用獨立 opt-in tool family、人工 login/MFA、provider-owned opaque profile reference、明確 owner/TTL/delete 控制，並先限制在 read-only bounded navigation，再評估 Groundlane 是否代管 credential 或執行一般帳號操作。
- 開源參考來源已在產品需求文件分成 primary references 與 watchlist/discovery sources，避免低維護度候選專案預設變成 runtime 優先項。
- 規劃中的 document processing 包含 ownership-scoped、content-addressed result cache，working default 為 24 小時，並提供 bounded caller TTL/cache controls、完整 engine/version/source provenance，以及 deletion/invalidation 規則；這不代表啟用 Phase 0 Web response cache。
- 規劃中的 file/document output 使用 canonical structured envelope，包含 stable block/source references、typed tables、assets、formulas、citations、capability states、spans、warnings、errors 與 engine/model provenance。Markdown 維持預設 lossy projection；provider raw JSON 不會成為 public contract，現有 HTML `parse` schema 也不改變。
- 商業化 roadmap：OSS V1 Stable 維持 operator-hosted open-source product。Self-host 不需要 Groundlane Cloud 帳號、license server、activation check 或 mandatory phone-home。Managed Groundlane Cloud 是已核准的後續 phase，依 Internal Alpha、Invite-only Beta、Managed Cloud Public Launch 漸進發布。Tenant/secret isolation、allowance hard stop、abuse controls、Claude/Codex/Cursor compatibility、provider cost attribution、token revoke、project deletion 與基本 incident handling 通過前，不開放 public no-card trial。Cloud 使用 hosted Remote MCP endpoint 加 Web dashboard、具完整 provenance 的 preset-first routing，也不偷偷切換資金來源；OSS config 匯入 Cloud 仍是可選路徑。

詳細產品需求、能力矩陣、roadmap 與 acceptance criteria 位於[產品需求文件](docs/product/prd.md)。

## 文件

- [設定](docs/configuration.md)
- [架構](docs/architecture.md)
- [Cloudflare 部署](docs/deployment/cloudflare.md)
- [開源技術基礎](docs/open-source-foundations.zh-TW.md)
- [Reader benchmark](docs/research/reader-benchmark.md)
- [Parser benchmark](docs/research/parser-benchmark.md)
- [研究封存](docs/research/README.md)

## 參與貢獻與支援

一般 bug 與功能提案請使用 [GitHub Issues](https://github.com/vincentxuu/groundlane/issues)。送出 pull request 前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md) 與[行為準則](CODE_OF_CONDUCT.md)。安全漏洞請依 [SECURITY.md](SECURITY.md) 私下通報。

## 授權

Groundlane 使用 [Apache License 2.0](LICENSE) 授權。
