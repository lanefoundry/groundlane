<div align="center">

# Groundlane

**AI agent 值得信賴的 Web 存取層。**

[![CI](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml/badge.svg)](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-early_preview-orange.svg)

[快速開始](#快速開始) · [連接 Client](#連接-mcp-client) · [工具](#工具一覽) · [部署](#執行-groundlane) · [文件](#文件)

[English](README.md) · [繁體中文](README.zh-TW.md)

</div>

Groundlane 是開源的遠端 MCP server，讓 AI agent 透過同一套受控介面搜尋 Web、讀取內容與進行確定性結構化抽取。它不綁模型，將可替換 provider 收斂成穩定契約，並讓 operator 掌握 authentication 與資源限制。

> [!IMPORTANT]
> Groundlane 目前是早期預覽版（`0.1.0`），工具契約與部署行為仍可能調整。它不是託管服務、CAPTCHA solver，也不保證繞過所有反爬機制。

## 工具一覽

| 工具 | 功能 | 目前執行路徑 |
| --- | --- | --- |
| `web_fetch` | 將公開 URL 讀成 Markdown、text 或 HTML | bounded HTTP、本機正文正規化，以及符合條件時選用的 Jina/browser fallback |
| `web_search` | 搜尋公開 Web 並回傳正規化結果 | 十一個 provider 的有界自動融合、失敗時下一批 retry、明確單一來源、fallback 或 deep routing |
| `web_answer` | 從支援 answer 的 provider 取得 grounded answer | 並行 fan-out 或 fallback 到 You.com Answer 與 Linkup sourced answer，保留 provider attribution 與 citations |
| `web_research` | 從支援 research 的 provider 取得研究報告 | 並行 fan-out 或 fallback 到 Linkup Research、You.com Research 與 Parallel Responses，保留 citations |
| `web_content` | 透過 provider content API 抓取 URL 內容 | 並行 fan-out 或 fallback 到 Linkup Fetch、You.com Contents、Exa Contents、Tavily Extract、Firecrawl Scrape、Keenable Fetch |
| `web_map` | 從公開網站探索 URL | 並行 fan-out 或 fallback 到 Firecrawl Map 與 Tavily Map，保留 provider attribution |
| `web_crawl` | 對公開網站做有界 crawl | 並行 fan-out 或 fallback 到 Firecrawl Crawl 與 Tavily Crawl，限制頁數與內容大小 |
| `web_news` | 搜尋 news-specific provider index | 並行 fan-out 或 fallback 到 Brave News、Serper News、SerpApi Google News |
| `web_images` | 搜尋 image-specific provider index | 並行 fan-out 或 fallback 到 Brave Images、Serper Images、SerpApi Google Images |
| `web_extract` | 抽取具名欄位為結構化 JSON | CSS selector 的 text、HTML 或 attribute，可設定單次 output cap；不暗中呼叫 LLM |
| `provider_balance` | 查詢 provider 帳號餘額 API | Linkup credits、You.com keyed credits、Firecrawl remaining credits、SerpApi searches left；未支援的 provider 會回明確診斷狀態 |
| `provider_capabilities` | 列出各 provider 功能與 Groundlane surface | 靜態 capability matrix，區分 vendor 自家功能與 Groundlane 目前實作工具 |
| `provider_quota` | 整合帳號餘額、本機工具 budget、capabilities 與 routing hints | provider-scoped 診斷視圖，同時看 billing status、Groundlane `web_search` guardrail、已 expose 工具、keyless 可用性與下一步檢查 |
| `search_budget_status` | 檢查 Groundlane 本機 search attempt guardrail | process 內 daily/monthly counters，包含 limit、used、remaining、exhausted 與 reset metadata；不是 provider 帳務真相 |

Fetch/extract 結果會回報 `engine`、`backend`、`finalUrl`、`bytes`、`truncated` 等 retrieval provenance。自動搜尋預設每批最多選兩個互補 provider，經 canonical URL 去重與 RRF 融合後仍保留 selected/attempted/succeeded provider provenance；若某批 federated provider 全失敗，Groundlane 會在同一個 deadline 內嘗試下一批 eligible providers。`web_answer`、`web_research`、`web_content`、`web_map`、`web_crawl`、`web_news` 與 `web_images` 預設並行 fan-out，並分別回傳各 provider 的結果，不做隱藏合成。明確指定 provider 時維持單一來源。沒有 search provider key 時，`web_fetch` 與 `web_extract` 仍可運作。

各 provider vendor 自家還有更多 API，Groundlane 目前沒有全部接成 MCP tool。請看 [provider inventory](docs/operations/provider-inventory.md) 的已查證 backlog，以及 vendor capability、已實作 Groundlane tool、live smoke、帳號餘額證據與 Groundlane 本機 attempt budget 之間的區分。

當 `web_search` 回傳 0 results 時，先看 `provider_quota`：它會把 provider account-balance status、Groundlane 本機 `web_search` budget、已實作工具與 `searchRouting` hints 放在同一個視圖。`provider_balance` 只用來查 provider-owned account credits；`search_budget_status` 則用來細查本機 attempt counters。Balance 的 `not_configured` 代表 runtime 沒有該 provider balance API 需要的 credential，不代表 keyless quota 已耗盡。

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
production MCP server 會回應預期的 tool contracts。

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
（`https://your-worker.example/mcp`），平台會自動完成 client 註冊（透過 CIMD 或
DCR，細節見[Cloudflare 部署文件](docs/deployment/cloudflare.md)）並跳出同意畫
面。輸入部署時設定的 `OAUTH_OWNER_PASSPHRASE` 完成授權——這是獨立於
`GROUNDLANE_AUTH_TOKEN` 的另一組 secret，僅用來把關這個同意畫面。

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
- **Hosted fallback 必須明確啟用：**只有 operator 主動設定時才會把 URL 傳給 Jina Reader 或 Browserless。

## 執行 Groundlane

| 模式 | 適合情境 | 入口 |
| --- | --- | --- |
| Local Node | 開發與評估 | [快速開始](#快速開始) |
| Docker | 獨立 Node／Chromium container | `docker build -t groundlane .`，再執行 `docker run --rm -p 8080:8080 --env-file .env groundlane` |
| Cloudflare Worker + Container | 預期的 production topology | [部署到 Cloudflare](#部署到-cloudflare) |

## 支援的 adapters

| Groundlane 能力 | 已實作 adapters |
| --- | --- |
| Search | Linkup、Keenable、Parallel、Browserbase、Brave、SerpApi、Tavily、Exa、Firecrawl、Serper、You.com |
| Grounded answer | Linkup、You.com |
| Research report | Linkup、You.com、Parallel |
| URL content API | Linkup、You.com、Exa、Tavily、Firecrawl、Keenable |
| Site map discovery | Firecrawl、Tavily |
| Bounded site crawl | Firecrawl、Tavily |
| News search | Brave、Serper、SerpApi |
| Image search | Brave、Serper、SerpApi |
| Account balance | Linkup、You.com、Firecrawl、SerpApi |
| Quota diagnostics | Provider quota summary 與本機 search budget status |
| Hosted Reader fallback | Jina Reader（opt-in） |
| Browser rendering | Local Playwright 或 Browserless（opt-in） |
| Cloudflare runtime | 目前支援 Worker + Container deployment；Browser Run、AI Search、AI Gateway、Agents 與 Workflows 是已查到的未來 adapter surface |

自動搜尋路由可套用保守的 per-instance 每月與每日嘗試次數 budget。這只是應用層護欄，不是 provider 帳務真相；provider dashboard 與 spend limit 仍是權威。`provider_quota` 會整合帳戶餘額、Groundlane 本機 `web_search` budget 與 capabilities；`provider_balance` 只會回報已實作官方 balance API 的 provider，目前是 Linkup、You.com、Firecrawl 與 SerpApi。Exa、Browserbase 與 Cloudflare 比較適合做 usage/cost diagnostics。Credentials、routing、limits 與 budget 語意請看[設定文件](docs/configuration.md)，目前 production provider 狀態、功能矩陣與 balance API 查證請看 [Provider inventory](docs/operations/provider-inventory.md)。

### Provider selection

自動 `web_search` 會依 `SEARCH_PROVIDER_ORDER`、capability filtering、provider health 與 attempt budgets 選 provider。預設順序優先放 renewable 或 account-backed provider，保留 keyless Keenable 與 You.com 作為低摩擦 fallback，並讓不可續用或無法用 API 量測餘額的 finite-trial provider 維持 opt-in。明確指定 `provider` 會跳過自動排序，但仍必須通過 credential、capability、URL safety 與 budget 檢查。

`web_search` 以外的 provider-backed tools 若使用 `strategy=parallel`，會回傳每個 selected provider 的 attributed results；若使用 `strategy=fallback`，會在第一個成功 provider 停下來以降低花費。

### Runtime 與帳務邊界

Cloudflare 目前是 Groundlane 的 production runtime，同時也有可成為未來 Groundlane adapter 的相關能力。AI Search 是給 operator-provided data 用的 managed search service，支援 Workers、REST 與 MCP。Browser Run / Browser Rendering 透過 REST API 或 Workers binding 提供 content、markdown、screenshot、PDF、accessibility tree、links、crawl 與 structured JSON browser actions。Agents 與 Workflows 提供 durable agent sessions、scheduled work、WebSockets、可恢復 steps 與 tool orchestration。AI Gateway 可提供 model observability、caching、retries、rate limiting 與 fallback。

這些服務和 provider router 裡的 public-web search providers 不是同一層。因此 Cloudflare 不會列在 `provider_balance`：這個 tool 只查詢 web-data provider 官方 API 暴露的 account balance，目前是 Linkup credits、You.com API credits、Firecrawl remaining credits 與 SerpApi searches left。

Cloudflare usage 需要透過 Cloudflare dashboard、billing exports、logs、metrics，或未來獨立的 Cloudflare diagnostics 追蹤。Container 成本看的是 active runtime resource，例如 vCPU、memory、disk、egress、Workers、Durable Objects 與 logs；這些單位和 search-provider requests/credits 是不同帳。Groundlane 的 local budgets 不會限制 Cloudflare runtime 花費。

未來 Cloudflare-specific Groundlane work 應該和 search-provider routing 分開：例如 Browser Run backend 給 rendered `web_fetch` / `web_content`、AI Search adapter 給 private/operator-owned indexes、Cloudflare diagnostics 查 runtime usage，以及用 Workflows 支撐長時間 research 或 crawl jobs。

大型 generated documentation sites 需要 source-aware parsing，而不是直接抽整頁 HTML。Cloudflare docs 有 Markdown pages、scoped `llms.txt` / `llms-full.txt` indexes，以及 API reference 的 OpenAPI schemas。Groundlane 對 Cloudflare docs 和類似網站應優先使用這些 machine-readable sources，再依 product、endpoint、heading 或 schema operation 切段。單純提高 `maxBytes` 或抽整個 `main` 是最後手段，因為還沒切到有用段落前就可能先撞到 output limits。目前 runtime path 會對 likely documentation URL 的 Markdown/text `web_fetch` 主動嘗試同 URL 的 `Accept: text/markdown`，再嘗試 Cloudflare-style `/index.md` source，並在 bounded direct failure 後查 same-origin scoped/root `llms.txt` manifest 找最接近的 Markdown page。Source Markdown cleanup 會先移除 front matter 與常見 docs chrome，再套用正常 output truncation。OpenAPI slicing 目前是純 JSON logic，等大型 schema discovery 有明確邊界後再自動接入 runtime fetch。

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
                              web_news | web_images | web_fetch | web_extract
                              diagnostics: provider_quota | provider_balance | search_budget_status | provider_capabilities
    |
    +-- provider router       可替換的 search adapters
    +-- safe HTTP + Reader    有界的內容取得與正文清理
    `-- browser backend       隔離的 local 或 hosted rendering
```

核心政策不依賴特定 search provider 或 browser runtime。未指定 selector 的 Markdown/text 會由 Mozilla Readability 與本機 fallback 清理；raw HTML 與明確 selector 則維持 deterministic DOM semantics。詳見[架構文件](docs/architecture.md)與可重跑的 [Reader benchmark](docs/research/reader-benchmark.md)。

## 安全與限制

Web retrieval 具有 SSRF 風險。Groundlane 將使用者 URL、redirect、provider 回傳 URL、browser subresource、WebSocket 與 DNS answer 全部視為不可信輸入。正式環境應保持 authentication、保留預設 limits，並套用 outbound network policy。

Groundlane **不保證**解開 CAPTCHA、隱藏自動化特徵，或取得 operator 原本無權存取的內容。能 render JavaScript 不代表已證明可繞過反爬。Threat model 與私下通報漏洞的方式請看 [SECURITY.md](SECURITY.md)。

## 專案狀態

- 目前 source version：`0.1.0` early preview，尚無穩定 tool-contract 保證。
- 已完成：十個 Web MCP tools、兩個 provider 診斷 MCP tools、十一個 search adapters、provider-backed answer/research/content/map/crawl/news/images paths、自架 Reader、選用 Jina／Browserless backends，以及 Cloudflare Worker + Container deployment。
- 下一步：async research job tools、structured extraction providers、finance research、durable quota ledger、更完整的 compatibility fixtures、cache policy 與營運 telemetry。

詳細方向與 acceptance criteria 位於[產品需求文件](docs/product/prd.md)。

## 文件

- [設定](docs/configuration.md)
- [架構](docs/architecture.md)
- [Cloudflare 部署](docs/deployment/cloudflare.md)
- [開源技術基礎](docs/open-source-foundations.zh-TW.md)
- [Reader benchmark](docs/research/reader-benchmark.md)
- [研究封存](docs/research/README.md)

## 參與貢獻與支援

一般 bug 與功能提案請使用 [GitHub Issues](https://github.com/vincentxuu/groundlane/issues)。送出 pull request 前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md) 與[行為準則](CODE_OF_CONDUCT.md)。安全漏洞請依 [SECURITY.md](SECURITY.md) 私下通報。

## 授權

Groundlane 使用 [Apache License 2.0](LICENSE) 授權。
