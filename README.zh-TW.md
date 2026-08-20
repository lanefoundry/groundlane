# Groundlane

[English](README.md) | [繁體中文](README.zh-TW.md)

**AI agent 值得信賴的 Web 存取層。**

Groundlane 是開源、供應商中立的遠端 MCP server，讓 AI agent 能在受控條件下存取公開 Web。它以一套穩定介面統一搜尋、內容擷取與確定性結構化抽取；搜尋服務可替換，難讀的 Markdown 頁面可先走選用的 Jina Reader，再升級到隔離的 local 或 Browserless 瀏覽器。

> [!IMPORTANT]
> Groundlane 目前是早期預覽版，工具契約與部署模型仍可能調整。它不是現成的託管服務，也不保證繞過所有反爬機制。

## 為什麼選 Groundlane？

- **不綁模型：**任何支援 Streamable HTTP MCP 的 client 都能使用，不必依賴模型供應商內建的 Web 工具。
- **不綁搜尋供應商：**只將具有每月重置免費額度的搜尋 API 放入 provider router，並共用同一份正規化結果契約。
- **HTTP 優先，必要時才用瀏覽器：**普通讀取維持快速；只有 JavaScript、等待條件或明確 fallback 訊號才動用 Chromium。
- **確定性抽取：**用 CSS selector 定義欄位並取得結構化 JSON，不暗中加入 LLM 推論步驟。
- **安全優先：**MCP endpoint 強制驗證，並限制 URL、redirect、網路、deadline、bytes、輸出與 concurrency。
- **部署控制權在自己手上：**control plane 與瀏覽器 workload 可部署在自己的環境，包括 Cloudflare Workers 與 Containers。

## MVP 工具

| 工具 | 用途 | 目前範圍 |
| --- | --- | --- |
| `web_fetch` | 將 URL 讀成 Markdown、純文字或 HTML | bounded HTTP、選用 Jina Reader，再使用 browser fallback |
| `web_search` | 透過已設定的 provider 搜尋 | 指定或自動路由到七個 provider |
| `web_extract` | 從頁面抽取具名欄位 | CSS selector；支援 text、HTML 或 attribute value |

瀏覽器自動化只是名為 **Groundlane Browser** 的內部執行引擎。MVP 不對外提供持久 browser session。

## 快速開始

### 前置需求

- Node.js 22 以上
- pnpm 10
- browser fallback 所需的 Chromium
- 若要使用 `web_search`，至少需要一組具每月循環免費額度的 provider API key
  （Tavily、Exa、Parallel、Browserbase、Brave、Firecrawl 或 SerpApi）

### 在本機執行

Clone 本 repository 後執行：

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
set -a
source .env
set +a
pnpm dev
```

請在 `.env` 設定足夠強的 `GROUNDLANE_AUTH_TOKEN`。要啟用搜尋，請加入一個或多個受支援 provider 的 API key。本機 server 會監聽 `PORT`，並提供：

- `POST /mcp` — 需要驗證的 Streamable HTTP MCP endpoint
- `GET /healthz` — process liveness
- `GET /readyz` — Container reachability 與 service configuration readiness

### 連接 MCP client

請在支援 Streamable HTTP 的 MCP client 設定 server URL 與 bearer token。不同 client 的設定格式不同，但連線值如下：

```text
URL: http://localhost:8080/mcp
Authorization: Bearer <GROUNDLANE_AUTH_TOKEN>
```

不要把 token 放在 query string，也不要提交到版本控制。

Server 執行後，請另開 shell、載入同一份 `.env`，驗證 MCP handshake 與 public HTTP path：

```bash
set -a
source .env
set +a
pnpm smoke
```

若也要驗證 browser path，請設定 `GROUNDLANE_SMOKE_BROWSER=1`。

## 設定

Groundlane 從環境變數讀取設定；完整本機範本請看 [.env.example](.env.example)。

| 變數 | 用途 | 預設值／範例 |
| --- | --- | --- |
| `GROUNDLANE_AUTH_TOKEN` | `/mcp` 必須使用的 bearer token | 必填 |
| `SEARCH_PROVIDER_ORDER` | 自動路由時的 provider 順序 | `tavily,exa,parallel,browserbase,brave,firecrawl,serpapi` |
| `SEARCH_MONTHLY_REQUEST_BUDGETS` | 每個 instance 的 provider 嘗試次數上限，每個 UTC 月重置 | 保守的免費方案預設值 |
| `TAVILY_API_KEY` | Tavily adapter credential | 選填 |
| `EXA_API_KEY` | Exa adapter credential | 選填 |
| `FIRECRAWL_API_KEY` | Firecrawl Search adapter credential | 選填 |
| `SERPAPI_API_KEY` | SerpApi Google Search adapter credential | 選填 |
| `BROWSERBASE_API_KEY` | Browserbase Search adapter credential | 選填 |
| `PARALLEL_API_KEY` | Parallel Search adapter credential | 選填 |
| `BRAVE_API_KEY` | Brave Search adapter credential | 選填 |
| `READER_BACKEND` | Markdown Reader fallback：`disabled` 或 `jina` | 預設 `disabled` |
| `BROWSER_BACKEND` | 瀏覽器能力：`disabled`、`local` 或 `browserless` | 預設 `disabled`；本機範本使用 `local` |
| `BROWSERLESS_TOKEN` | Browserless `/content` credential | 僅 `browserless` 必填 |
| `BROWSERLESS_REGION` | Browserless endpoint region：`sfo`、`lon` 或 `ams` | `sfo` |
| `REQUEST_TIMEOUT_MS` | 端到端 request deadline | 本機為 `30000` |
| `MAX_RESPONSE_BYTES` | 上游 response byte 上限 | 本機為 `2000000` |
| `MAX_OUTPUT_CHARS` | 回傳文字字數上限 | 本機為 `100000` |
| `MAX_CONCURRENCY` | 同時處理的 request 上限 | 本機為 `4` |
| `MAX_QUEUE` | 等候中的 request 上限 | 本機為 `16` |

沒有搜尋 credential 時，`web_fetch` 與 `web_extract` 仍可運作；只有對應的搜尋 provider 會無法使用。

每月 budget 會計算實際嘗試呼叫 provider 的次數，包含 retryable failure；達到設定上限後，同一個 Groundlane instance 不再選用該 provider。這是保守的應用層護欄，不是帳務真相：Container 重啟會清空計數，多個 instances 不共享狀態，而且部分服務採變動 credits。請同時開啟 provider 端消費限制，並依實際方案覆寫 budgets。

## 架構

```text
MCP client
    |
    v
Cloudflare Worker / Node HTTP edge
    |  authentication, limits, request identity
    v
tool registry
    |-- web_search  -> 每月免費 provider router（7 個 adapters）
    |-- web_fetch   -> safe HTTP -> 選用 Jina Reader -> browser fallback
    `-- web_extract -> fetch pipeline -> deterministic DOM extraction
```

核心政策與契約不依賴特定 provider 或 browser runtime。Browser backend 可選 Container-local Playwright 或 Browserless `/content`；輸出的 `engine` 與 `backend` 會揭露實際執行路徑，但公開 MCP 工具不變。Hosted backend 會收到請求的公開 URL，因此必須由 operator 主動啟用。

元件邊界、request flow 與設計決策請看[架構文件](docs/architecture.md)。

## 安全

Web retrieval 具備 SSRF 風險。Groundlane 會將使用者 URL、redirect、browser subresource 與搜尋 provider 回傳的 URL 全部視為不可信輸入。正式部署時應維持 authentication、使用 outbound network policy，並保留預設資源限制。

本專案**不保證**自動解開所有 CAPTCHA、不會被偵測，也不授權存取原本無權取得的內容。Operator 必須自行遵守目標網站條款、robots policy、隱私義務與適用法律。

安全模型與非公開漏洞通報方式請看 [SECURITY.md](SECURITY.md)。

## 部署

預期的 production topology 由 Cloudflare Worker 擔任公開 control plane，Cloudflare Container 執行 Node／Playwright 瀏覽器 workload。前置需求、secrets、部署與驗證步驟請看 [Cloudflare 部署指南](docs/deployment/cloudflare.md)。

## Roadmap

- [x] 定義供應商中立的 `web_fetch`、`web_search` 與確定性 `web_extract` 工具面
- [x] 加入具 provenance 的 opt-in Jina Reader 與 Browserless retrieval backends
- [ ] 穩定 MCP 契約並發布相容性 fixtures
- [ ] 強化 Cloudflare Worker + Container 部署與營運 telemetry
- [ ] 加入 cache adapter 與 provider health／cost-aware routing
- [ ] 加入 opt-in、具明確 budget 的 batch／crawl primitives
- [ ] 將 stateful browser session 當成獨立且具安全 lifecycle 的能力評估

Roadmap 只代表方向，不是版本承諾。現有範圍背後的依據請看[研究封存](docs/research/README.md)。

## 文件

- [架構](docs/architecture.md)
- [MVP 產品需求](docs/product/prd.md)
- [Cloudflare 部署](docs/deployment/cloudflare.md)
- [安全政策](SECURITY.md)
- [貢獻指南](CONTRIBUTING.md)
- [研究封存](docs/research/README.md)

## 參與貢獻

歡迎提交 issue 與 pull request。開始前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md) 與[行為準則](CODE_OF_CONDUCT.md)。安全漏洞請依 [SECURITY.md](SECURITY.md) 的方式私下回報。

## 授權

Groundlane 使用 [Apache License 2.0](LICENSE) 授權。
