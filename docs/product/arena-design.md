# Groundlane Arena — Architecture

A neutral, open-source evaluation platform for comparing search, extraction, and document parsing providers side-by-side. Deploys on the same Cloudflare stack as Groundlane itself.

## System architecture

```
┌──────────────────────────────────────────────────┐
│  arena.groundlane.dev                             │
│  Cloudflare Worker (TanStack Start SSR)           │
│                                                    │
│  Pages:                     Server functions:      │
│  /                          /api/match/new         │
│  /match/:id                 /api/match/:id/vote    │
│  /leaderboard               /api/leaderboard       │
│  /benchmark                 /api/benchmark/trigger  │
│  /about                     /api/providers          │
│                                                    │
│  ┌──────────┐  ┌────────────────┐                  │
│  │  D1      │  │  R2            │                  │
│  │  arena-db│  │  arena-fixtures│                  │
│  └──────────┘  └────────────────┘                  │
│                                                    │
│  Service Binding ─────────────────────────┐        │
└───────────────────────────────────────────┼────────┘
                                            │
                                ┌───────────▼──────────┐
                                │  Groundlane MCP       │
                                │  Worker               │
                                │  Provider dispatch    │
                                └──────────────────────┘
```

Arena 是一個獨立的 Cloudflare Worker（TanStack Start SSR），透過 Service Binding 呼叫 Groundlane MCP Worker 的 tool handlers。每場比賽對同一個 query 用 adaptive pairing 選出兩個 provider dispatch，結果匿名展示（投票後才揭示 provider identity）。

## Tech stack

參考 [offernow](https://github.com/lanefoundry/offernow) 的同構 Cloudflare-native stack，Arena 共用相同的技術選型以降低維護成本。

| Layer | Choice | Why |
|---|---|---|
| **Runtime** | Cloudflare Worker + D1 + R2 | 與 Groundlane 同帳號部署，直接 import tool handlers |
| **Framework** | [TanStack Start](https://tanstack.com/start) (React 19 SSR) | Leaderboard 需要 SSR（SEO + 社群分享 OG），TanStack Start 原生支援 Cloudflare Worker 作為 server runtime |
| **Router** | TanStack Router (file-based routes) | 類型安全路由，`/leaderboard`、`/match/:id`、`/benchmark` 等頁面自然對應 |
| **Data fetching** | TanStack Query | SSR prefetch + client revalidation，leaderboard 即時更新不需整頁刷新 |
| **UI** | Tailwind CSS v4 + shadcn/ui (CVA + clsx + tailwind-merge) | 投票按鈕、結果卡片、leaderboard 表格等元件可直接用 shadcn 基礎元件 |
| **Charts** | Lightweight inline SVG (sparklines, CI bars) | 排行榜的 sparkline 和信賴區間不需要重量級 charting library |
| **Icons** | [Sketchy Icons](https://www.npmjs.com/package/sketchyicons) (@sketchyicons/react) | 手繪風格圖標，與 Arena 的中立評測調性契合 |
| **Build** | Vite 8 + @cloudflare/vite-plugin | 開發即部署一致，HMR + Worker 模擬 |
| **Lint / Format** | Biome | 單一工具取代 ESLint + Prettier |
| **TypeScript** | TypeScript 6, strict mode | D1 binding types + tool handler response types 全程型別安全 |

### 部署拓撲

```
arena.groundlane.dev          → Cloudflare Worker (TanStack Start SSR)
                                 ├─ D1: arena-db (votes, matches, Elo, benchmarks)
                                 ├─ R2: arena-fixtures (test corpus, raw results)
                                 └─ Service Binding → Groundlane MCP Worker
```

TanStack Start 在 Cloudflare Worker 上跑 SSR，不需要額外的 Pages 部署。前端和 API 都在同一個 Worker 裡，`/api/*` 路由由 server functions 處理。

### 與 Groundlane 主站的關係

Arena 是獨立的 Worker 部署，不修改 Groundlane MCP Server 的程式碼。兩者的整合方式：

- **開發時**：Arena import Groundlane 的 tool handler 作為 library（shared package）
- **Production**：透過 Cloudflare Service Binding 呼叫 Groundlane Worker，零網路延遲
- **Self-hosted**：直接 import tool handler，不經 Service Binding

## Page routes

TanStack Router file-based routes under `src/routes/`:

| Route | Page | Description |
|---|---|---|
| `/` | Landing | Arena 簡介 + 最近一場比賽的 CTA + leaderboard 摘要 |
| `/match/$matchId` | Match | Side-by-side 投票頁面：顯示 Result A / Result B，投票後揭示 provider |
| `/leaderboard` | Leaderboard | 排行榜主頁：分 track tab，顯示 Elo / CI / F1 / cost / sparkline |
| `/benchmark` | Benchmark | 自動化 benchmark 歷史：per-provider score 時間軸 + regression flags |
| `/about` | About | 方法論說明：Elo 機制、fixture 來源、privacy policy、provider participation |

SSR 頁面：`/leaderboard` 和 `/` 需要 SSR（SEO + OG meta 供社群分享）。其餘頁面 CSR 即可。

## API endpoints

所有 API 路由由 TanStack Start server functions 處理，prefix `/api/`。

### `POST /api/match/new`

建立一場新比賽。

```typescript
// Request
{ track: 'search' | 'extraction' | 'document' }

// Response 200
{
  matchId: string,
  track: string,
  queryId: string,
  queryText: string,           // fixture 的 query 內容
  resultA: SearchResult[],     // normalized, 最多 5 筆
  resultB: SearchResult[],
  createdAt: number
}

// SearchResult (normalized)
{
  title: string,               // truncated 80 chars
  snippet: string,             // truncated 200 chars, stripped formatting
  domain: string               // domain only, no full path
}
```

### `POST /api/match/:id/vote`

為一場比賽投票。

```typescript
// Request
{ winner: 'a' | 'b' | 'tie' | 'both_bad' }

// Response 200
{
  matchId: string,
  winner: string,
  providerA: string,           // revealed after vote
  providerB: string,
  latencyA_ms: number,
  latencyB_ms: number,
  estimatedCostA_usd: number | null,
  estimatedCostB_usd: number | null,
  eloChange: { a: number, b: number } | null  // null for both_bad
}

// Error 409: already voted on this match
// Error 429: rate limit exceeded
```

### `GET /api/leaderboard`

取得排行榜資料。

```typescript
// Query params
?track=search                  // optional, default all tracks

// Response 200
{
  track: string,
  fixtureVersion: string,
  providers: {
    id: string,
    displayName: string,
    elo: number,
    votes: number,
    provisional: boolean,      // < 300 votes
    ciLow: number | null,      // Phase 2: 95% CI lower bound
    ciHigh: number | null,
    scoreF1: number | null,    // from latest benchmark
    latencyP50_ms: number | null,
    latencyP95_ms: number | null,
    costPerCall_usd: number | null,
    pricingModel: string | null,
    sparkline7d: number[]      // daily F1 scores, last 7 days
  }[],
  updatedAt: number
}
```

### `POST /api/benchmark/trigger`

手動觸發 benchmark（需 admin auth）。

```typescript
// Request
{
  track: 'search' | 'extraction' | 'document',
  providers?: string[]         // optional, default all eligible
}

// Response 202
{
  runId: string,
  track: string,
  fixtureVersion: string,
  providerCount: number,
  status: 'started'
}
```

### `GET /api/providers`

列出所有 provider 及其狀態。

```typescript
// Response 200
{
  providers: {
    id: string,
    displayName: string,
    tracks: ('search' | 'extraction' | 'document')[],
    eligible: boolean,
    optedOut: boolean,
    pricingModel: string | null,
    estimatedCostPerCall_usd: number | null
  }[]
}
```

## Initial provider roster (MVP search track)

MVP 的 search track 從 Groundlane 現有 14 家 search adapter 中選擇有穩定 API 且 quota 足夠評測的 provider。

| Provider | Type | MVP inclusion | Notes |
|---|---|---|---|
| Tavily | Keyed | Yes | 主流 agent search，1,000 free credits/month |
| Exa | Keyed | Yes | Neural search，1,000 free requests/month |
| Brave | Keyed | Yes | 2,000 free queries/month |
| Serper | Keyed | Yes | Google SERP，2,500 free queries |
| SerpApi | Keyed | Yes | Google/Bing SERP，100 free searches/month |
| Linkup | Keyed | Yes | Sourced search，有 free tier |
| You.com | Keyed/Keyless | Yes | Keyless daily MCP profile 可用 |
| Firecrawl | Keyed | Yes | 500 free credits |
| TinyFish | Keyed | Evaluate | 較新的 provider，需驗證穩定度 |
| Parallel | Keyed | Evaluate | 需確認 search 獨立可用 |
| SearchAPI | Keyed | Defer | Opt-in finite-trial SERP provider |
| Browserbase | Keyed | Defer | 主要是 browser，search 非主力 |
| Keenable | Keyed | Defer | 較小眾 |
| SearXNG | Self-hosted | Defer | 需要自架，不適合 hosted arena |

MVP 至少 **8 家 provider** 參與 search track，確保配對多樣性。

## Evaluation tracks

### Search track

**Metrics:** relevance (does the result answer the query?), freshness (are results current?), citation quality (do URLs work and match claims?), latency, cost per query.

**Corpus:** 50 queries across five strata — factual lookup (10), current events (10), technical documentation (10), multi-hop reasoning (10), ambiguous/subjective (10). Each has a ground-truth answer and required source URLs where applicable. See [Fixture versioning and maintenance](#fixture-versioning-and-maintenance) for staleness policy.

**Scoring:** Automated precision/recall against ground truth for the top-5 results. Human voting for subjective relevance and readability of snippets.

**Example:** Query "Cloudflare Workers WASM size limit 2026" — ground truth: 64 MiB (source: Cloudflare changelog 2026-09-04).

### Extraction track

**Metrics:** heading preservation, table structure accuracy, code block fidelity, link completeness, metadata extraction, noise ratio (boilerplate removed).

**Corpus:** 30 URLs — news articles (10), documentation pages (10), e-commerce product pages (5), academic pages (5). Each has a reference Markdown extraction reviewed by a human editor.

**Scoring:** Automated diff against reference extraction (character-level F1). Human voting for readability and completeness.

**Example:** URL `https://docs.cloudflare.com/workers/platform/limits/` — reference extraction preserves the limits table with all columns intact.

### Document track

**Metrics:** character accuracy (vs ground truth text), table cell accuracy, metadata extraction, format detection correctness.

**Corpus:** 20 test files — text PDF (5), scanned PDF (5), DOCX with tables (3), XLSX (2), mixed CJK content (3), legacy .doc (2). Each has a ground-truth text extraction.

**Scoring:** Automated character-level accuracy and table cell F1. Human voting for scanned PDF readability.

**Example:** A two-page scanned exam paper in Traditional Chinese — ground truth is the manually transcribed text.

## Provider pairing strategy

Provider pairing uses adaptive sampling rather than pure random selection. The goals are: maximize information gain per match, avoid wasted matches from provider failures, and ensure new providers converge to stable ratings quickly.

Reference: [LMSYS Chatbot Arena adaptive sampling](https://www.lmsys.org/blog/2023-12-07-leaderboard/)

### Eligibility

Before pairing, the Arena Worker filters the candidate pool:

1. Provider must have a configured, non-expired API key (or be a keyless provider with remaining daily quota).
2. Provider must not be marked `opted_out` in the `providers` table.
3. Provider must not have exhausted its Groundlane-local attempt budget for the current period.

A provider that fails eligibility is silently excluded from pairing — never dispatched with the expectation of failure.

### Pairing algorithm

1. From the eligible pool, apply **sampling weights** based on vote count:
   - New provider (< 300 votes in this track): weight **3×** — accelerates convergence.
   - Top-5 provider by Elo: weight **2×** — maintains community engagement.
   - All others: weight **1×**.
2. Prefer pairs where the Elo gap is **< 200** — matches between close-ranked providers yield more information. When no such pair exists, fall back to uniform random from the eligible pool.
3. **Randomize A/B position** for every match (left/right assignment) to prevent position bias.

### Handling failures

If one provider returns an error, empty result set, or times out after dispatch:

- The match is recorded with `status = 'invalid'` and **excluded from Elo calculation**.
- The failure is logged in `match_failures` for regression analysis and provider health dashboards.
- The voter sees a message: "One provider failed to respond. This match won't count — try another."

This prevents Elo pollution from one-sided matches while preserving failure data for diagnostics.

## Result presentation

Side-by-side display follows a normalized contract to prevent display bias. Research shows response length alone can inflate Elo by ~41 points ([Polyrating, ICLR 2025](https://arxiv.org/abs/2504.06949)).

### Display rules

1. Results labeled **"Result A"** and **"Result B"** — no provider name, logo, or identifying metadata.
2. A/B position randomized per match (stored in `matches.position_swap`).
3. Search results use a **uniform card format**:
   - Title: truncated at 80 characters.
   - Snippet: truncated at 200 characters, stripped of provider-specific formatting (bold, links within snippet).
   - URL: display domain only (e.g., `docs.cloudflare.com`), no full path.
   - Maximum **5 results** displayed per side.
4. Metadata that could bias voting (latency, result count, provider-specific badges) is **hidden until after the vote**.

### Vote options

Four options instead of three:

| Option | Elo effect | Notes |
|---|---|---|
| **A is better** | A wins, B loses | Standard Elo update |
| **B is better** | B wins, A loses | Standard Elo update |
| **Tie** | Half-win/half-loss for both | Elo delta split equally |
| **Both bad** | No Elo update | Recorded for query difficulty analysis |

After voting, the UI reveals: provider identities, actual latencies, and estimated cost per query.

Reference: [Search Arena](https://arxiv.org/html/2506.05334v1) uses a similar four-option model with post-vote reveal.

## Rating system

### Phase 1 — Incremental Elo (MVP)

Each provider starts at 1500 Elo. K-factor 32 for the first 300 matches per provider per track, then 16. Ties split the point delta equally.

**Provisional badge:** Providers with fewer than **300 votes** in a track show a "provisional" badge. Rankings among provisional providers are not displayed as ordered — they appear in a separate "evaluating" section.

**Anti-gaming:** One vote per match per IP. Rate limit: 20 votes per IP per hour. Votes from the same /24 subnet within 5 seconds of each other are flagged for review. No anonymous bulk voting API.

### Phase 2 — Bradley-Terry with bootstrap CI

Incremental Elo is order-dependent and lacks confidence intervals. Phase 2 replaces the ranking engine:

1. **Bradley-Terry MLE** refit hourly from all votes. Mathematically equivalent to Elo's pairwise model but order-independent and more stable.
2. **Bootstrap resampling** (1,000 iterations) produces 95% confidence intervals per provider per track.
3. Providers whose CIs overlap are marked **"statistically tied"** on the leaderboard.
4. Incremental Elo remains as a real-time display signal between BT refits.

References: [LMSYS switched to BT in Dec 2023](https://www.lmsys.org/blog/2023-12-07-leaderboard/), [am-ELO (ICML 2025)](https://arxiv.org/abs/2505.03475) jointly estimates model scores and annotator reliability.

## Fixture versioning and maintenance

Ground truth decays. RealTimeQA attempted weekly curation of news-based ground truth and ceased updates due to unsustainable manual costs. Groundlane avoids this by splitting the corpus into two tiers with different maintenance cadences.

Reference: [HoH benchmark (2025)](https://arxiv.org/abs/2503.04800) on temporal drift in ground truth.

### Stable tier (40 queries per track)

Covers factual lookup, technical documentation, multi-hop reasoning, and ambiguous/subjective strata.

- **Review cadence:** quarterly, by a maintainer.
- **Versioning:** each fixture carries `version` (semver), `created_at`, and `verified_at` timestamps.
- **Storage:** `fixtures/{track}/stable/v{YYYY}Q{N}/` in R2.
- Ground truth changes bump the fixture version; benchmark runs record the fixture version used.

### Temporal tier (10 queries per track)

Covers current events and time-sensitive queries.

- **Rotation cadence:** monthly. Old queries are archived (not deleted); new queries replace them.
- **Automated staleness check:** a weekly Worker cron re-fetches each ground-truth source URL. If the URL returns 404 or the content hash has changed, the fixture is marked `stale` and excluded from automated benchmarks until a maintainer reviews it.
- **Storage:** `fixtures/{track}/temporal/v{YYYY}-{MM}/` in R2.

### Comparability rule

The leaderboard and automated benchmark comparisons only use runs against the **same fixture version**. Cross-version comparisons are available in the historical data but not surfaced on the default leaderboard view.

## Cost estimation

Provider pricing models are heterogeneous (per-request, per-credit, subscription, keyless free tier) and no existing arena normalizes cost reliably. Groundlane uses a **static price table** maintained manually, not real-time billing deltas.

### Schema addition

```sql
ALTER TABLE providers ADD COLUMN estimated_cost_per_call_usd REAL;
ALTER TABLE providers ADD COLUMN pricing_model TEXT;       -- 'per_request' | 'per_credit' | 'subscription' | 'free'
ALTER TABLE providers ADD COLUMN pricing_note TEXT;         -- e.g. "Tavily: 1 credit = $0.008"
ALTER TABLE providers ADD COLUMN pricing_verified_at INTEGER;
```

### Leaderboard cost column

- **Cost efficiency** = `score_f1 / estimated_cost_per_call_usd`.
- Providers with `pricing_model = 'free'` show "Free tier" instead of a numeric ratio.
- Disclaimer on the leaderboard: *"Cost estimates are based on published provider pricing as of {pricing_verified_at}. Actual costs depend on your plan, volume, and provider terms."*
- Price table reviewed and updated quarterly alongside stable fixture review.

## Automated benchmark pipeline

A scheduled Worker cron (daily) or manual trigger runs the full test corpus against all configured providers. Each run:

1. Reads fixtures from R2, respecting the current fixture version and excluding `stale` temporal fixtures.
2. Dispatches each fixture to every eligible provider via Groundlane's tool handlers.
3. Scores results against ground truth using the per-track rubric.
4. Writes the scored run to D1 (`benchmark_runs` table with `fixture_version`) and detailed results to R2.
5. Detects regressions: if a provider's automated score drops >10% from its 7-day rolling average, the run is flagged.

Results are deterministic and reproducible: same fixtures, same scoring code, timestamped.

## Data model (D1)

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,                    -- 'tavily', 'exa', 'brave', ...
  display_name TEXT NOT NULL,
  elo_search INTEGER DEFAULT 1500,
  elo_extraction INTEGER DEFAULT 1500,
  elo_document INTEGER DEFAULT 1500,
  votes_search INTEGER DEFAULT 0,
  votes_extraction INTEGER DEFAULT 0,
  votes_document INTEGER DEFAULT 0,
  estimated_cost_per_call_usd REAL,
  pricing_model TEXT,                     -- 'per_request' | 'per_credit' | 'subscription' | 'free'
  pricing_note TEXT,
  pricing_verified_at INTEGER,
  opted_out INTEGER DEFAULT 0,           -- 1 = provider requested removal
  opted_out_at INTEGER
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL,                    -- 'search', 'extraction', 'document'
  query_id TEXT NOT NULL,                 -- fixture identifier
  fixture_version TEXT NOT NULL,          -- e.g. 'v2026Q3' or 'v2026-09'
  provider_a TEXT NOT NULL,
  provider_b TEXT NOT NULL,
  position_swap INTEGER DEFAULT 0,       -- 1 = display order was swapped
  result_a TEXT,                          -- R2 key to full result
  result_b TEXT,
  status TEXT DEFAULT 'pending',         -- 'pending', 'voted', 'invalid'
  created_at INTEGER NOT NULL
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  winner TEXT NOT NULL,                   -- 'a', 'b', 'tie', 'both_bad'
  voter_hash TEXT NOT NULL,               -- SHA-256 of IP + daily_salt
  voted_at INTEGER NOT NULL
);

CREATE TABLE match_failures (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  provider_id TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,                     -- sanitized, no secrets
  failed_at INTEGER NOT NULL
);

CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  fixture_version TEXT NOT NULL,
  score_precision REAL,
  score_recall REAL,
  score_f1 REAL,
  latency_p50_ms INTEGER,
  latency_p95_ms INTEGER,
  cost_usd REAL,                          -- estimated from static price table
  run_at INTEGER NOT NULL,
  results_r2_key TEXT                     -- detailed per-fixture results
);

-- Indexes for common queries
CREATE INDEX idx_matches_track_status ON matches(track, status);
CREATE INDEX idx_matches_created_at ON matches(created_at);
CREATE INDEX idx_votes_match_id ON votes(match_id);
CREATE INDEX idx_votes_voter_hash ON votes(voter_hash, voted_at);
CREATE INDEX idx_match_failures_match_id ON match_failures(match_id);
CREATE INDEX idx_benchmark_runs_track_provider ON benchmark_runs(track, provider_id, run_at);
```

## Public leaderboard

The leaderboard page shows:

- **Overall ranking** per track (Elo-based from human votes, with provisional/established distinction)
- **Confidence intervals** (Phase 2: 95% bootstrap CI from Bradley-Terry; providers with overlapping CIs marked "statistically tied")
- **Automated scores** per track (precision, recall, F1 from benchmark pipeline)
- **Cost efficiency** (F1 per dollar, with "Free tier" label where applicable)
- **Latency percentiles** (p50, p95)
- **Sparkline trends** (7-day rolling score)

Providers with fewer than 300 votes appear in a separate **"Evaluating"** section, not ranked against established providers.

A JSON endpoint (`/api/leaderboard`) returns current rankings for embedding in the Groundlane README as a badge or link.

## Data retention and privacy

- `voter_hash` = SHA-256(IP + daily_salt). Raw IP addresses are never stored.
- `daily_salt` rotates every 24 hours and is not persisted after rotation — historical votes cannot be traced back to IP addresses.
- Match results (full provider responses) are stored in R2. After 90 days, raw results are deleted; only aggregate scores in D1 are retained.
- No cookies, no cross-session identity tracking, no fingerprinting.
- Fixture queries are authored by the Groundlane team. User-submitted queries are not accepted in MVP.
- GDPR: voter_hash with rotating salt is not considered personal data under standard interpretations, but the privacy policy will document the hashing method for transparency.

## Provider participation policy

Groundlane evaluates providers through their **public APIs** using the operator's own API keys. No special "arena-optimized" endpoints are accepted.

### Opt-out

A provider may request opt-out via GitHub issue or email:

1. The provider is removed from the leaderboard and future pairing.
2. Historical matches are retained but marked `opted_out` — the provider name is replaced with "Provider (opted out)" on public views.
3. Elo scores of other providers are **not retroactively recalculated** — removing historical matches would destabilize all ratings.
4. Opt-out is reversible: a provider can request re-inclusion, starting from 1500 Elo with a provisional badge.

### Self-submission

Provider self-submission (letting providers register their own API for evaluation) is deferred to post-MVP. When implemented, self-submitted providers will use the same public API, same fixtures, and same scoring — no separate "vendor track."

### Anti-gaming

- Providers cannot select which queries they are tested on.
- All providers receive identical input for the same fixture.
- Benchmark runs are timestamped and fixture-versioned; score manipulation via selective fixture targeting is detectable.

Reference: [The Leaderboard Illusion (2025)](https://arxiv.org/abs/2504.06949) documents selection bias risks in arena-style evaluations.

## References

| Source | Relevance |
|---|---|
| [LMSYS Chatbot Arena](https://www.lmsys.org/blog/2023-12-07-leaderboard/) | Adaptive sampling, BT-over-Elo, bootstrap CI |
| [Search Arena (2025)](https://arxiv.org/html/2506.05334v1) | Side-by-side search evaluation with citations |
| [Parallel Benchmarks](https://parallel.ai/benchmarks) | Search provider head-to-head methodology |
| [am-ELO (ICML 2025)](https://arxiv.org/abs/2505.03475) | Joint model + annotator reliability estimation |
| [Polyrating (ICLR 2025)](https://arxiv.org/abs/2504.06949) | Length bias detection (~41 Elo inflation) |
| [HoH Benchmark (2025)](https://arxiv.org/abs/2503.04800) | Temporal drift in ground truth |
| [Open Model Arena](https://github.com/pete-builds/open-model-arena) | Lightweight self-hosted arena reference |
| [openbench (Groq)](https://github.com/groq/openbench) | Multi-provider eval infrastructure |
| [DR-Arena](https://arxiv.org/html/2601.10504v1) | Deep research agent evaluation (future `web_research` track) |

## MVP scope

**Build first:**
- Search track only (highest value, most providers to compare)
- 20 fixtures (subset of the 50-query corpus, stable tier only for MVP)
- Adaptive pairing with eligibility filtering
- Normalized side-by-side voting UI (Pages SPA) with four vote options
- Incremental Elo ratings in D1 with 300-vote provisional threshold
- Static cost price table
- Public leaderboard page with provisional/established sections
- Manual benchmark trigger (no cron yet)
- Privacy and provider participation policies documented

**Phase 2:**
- Bradley-Terry MLE with hourly batch refit and bootstrap 95% CI
- "Statistically tied" markers on leaderboard
- Temporal fixture tier with monthly rotation and automated staleness checks
- Automated daily benchmark cron
- Regression detection and alerts
- Historical trend charts
- Extraction and document tracks

**Defer:**
- Provider self-submission
- README badge embedding
- am-ELO annotator reliability weighting
