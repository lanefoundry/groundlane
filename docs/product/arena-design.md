# Groundlane Arena — Architecture

A neutral, open-source evaluation platform for comparing search, extraction, and document parsing providers side-by-side. Deploys on the same Cloudflare stack as Groundlane itself.

## System architecture

```
┌────────────────────────┐
│  Pages frontend (SPA)  │  Static React/Preact app
│  arena.groundlane.dev  │  Shows side-by-side results, voting UI, leaderboard
└──────────┬─────────────┘
           │ fetch
┌──────────▼─────────────┐
│  Arena Worker API       │  Cloudflare Worker
│  /api/match/new         │  Picks two random providers, dispatches same query
│  /api/match/:id/vote    │  Records vote, updates Elo
│  /api/leaderboard       │  Reads current ratings
│  /api/benchmark/trigger │  Starts automated benchmark run (cron or manual)
└──┬──────┬──────┬───────┘
   │      │      │
   │  ┌───▼──┐  │
   │  │  D1  │  │  Votes, matches, Elo ratings, benchmark runs
   │  └──────┘  │
   │            │
   │  ┌────────▼──┐
   │  │    R2     │  Test fixtures (queries, URLs, PDFs), benchmark results
   │  └───────────┘
   │
┌──▼──────────────────────┐
│  Groundlane MCP Server   │  Existing deployment
│  Provider dispatch       │  Same query → multiple providers simultaneously
└──────────────────────────┘
```

The Arena Worker calls Groundlane's existing tool handlers directly (shared library import for self-hosted, or authenticated MCP call for remote). Each match dispatches the same input to two randomly selected providers and returns both results anonymously (provider identity hidden until after the vote).

## Evaluation tracks

### Search track

**Metrics:** relevance (does the result answer the query?), freshness (are results current?), citation quality (do URLs work and match claims?), latency, cost per query.

**Corpus:** 50 queries across five strata — factual lookup (10), current events (10), technical documentation (10), multi-hop reasoning (10), ambiguous/subjective (10). Each has a ground-truth answer and required source URLs where applicable.

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

## Elo rating system

Each provider starts at 1500 Elo. When a user votes, the winner gains and loser loses points proportional to the upset probability (K-factor 32 for first 100 matches per provider, then 16). Ties split the point delta equally.

**Anonymous side-by-side:** The UI shows "Result A" and "Result B" with no provider label. The user picks the better result, or "tie". Provider identity is revealed after voting.

**Confidence:** Ratings below 50 votes show a "provisional" badge. The leaderboard shows 95% confidence intervals based on vote count.

**Anti-gaming:** One vote per match per IP. Rate limit: 20 votes per IP per hour. Votes from the same /24 subnet within 5 seconds of each other are flagged for review. No anonymous bulk voting API.

## Automated benchmark pipeline

A scheduled Worker cron (daily) or manual trigger runs the full test corpus against all configured providers. Each run:

1. Reads fixtures from R2 (`fixtures/search/*.json`, `fixtures/extraction/*.json`, `fixtures/document/*`)
2. Dispatches each fixture to every provider via Groundlane's tool handlers
3. Scores results against ground truth using the per-track rubric
4. Writes the scored run to D1 (`benchmark_runs` table) and detailed results to R2
5. Detects regressions: if a provider's automated score drops >10% from its 7-day rolling average, the run is flagged

Results are deterministic and reproducible: same fixtures, same scoring code, timestamped.

## Data model (D1)

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,          -- 'tavily', 'exa', 'brave', ...
  display_name TEXT NOT NULL,
  elo_search INTEGER DEFAULT 1500,
  elo_extraction INTEGER DEFAULT 1500,
  elo_document INTEGER DEFAULT 1500,
  votes_search INTEGER DEFAULT 0,
  votes_extraction INTEGER DEFAULT 0,
  votes_document INTEGER DEFAULT 0
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL,           -- 'search', 'extraction', 'document'
  query_id TEXT NOT NULL,        -- fixture identifier
  provider_a TEXT NOT NULL,
  provider_b TEXT NOT NULL,
  result_a TEXT,                 -- R2 key to full result
  result_b TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  winner TEXT NOT NULL,          -- 'a', 'b', 'tie'
  voter_hash TEXT NOT NULL,      -- SHA-256 of IP + date (not raw IP)
  voted_at INTEGER NOT NULL
);

CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  score_precision REAL,
  score_recall REAL,
  score_f1 REAL,
  latency_p50_ms INTEGER,
  latency_p95_ms INTEGER,
  cost_usd REAL,
  run_at INTEGER NOT NULL,
  results_r2_key TEXT            -- detailed per-fixture results
);
```

## Public leaderboard

The leaderboard page shows:

- **Overall ranking** per track (Elo-based from human votes)
- **Automated scores** per track (precision, recall, F1 from benchmark pipeline)
- **Cost efficiency** (F1 per dollar)
- **Latency percentiles** (p50, p95)
- **Sparkline trends** (7-day rolling score)

A JSON endpoint (`/api/leaderboard`) returns current rankings for embedding in the Groundlane README as a badge or link.

## MVP scope

**Build first:**
- Search track only (highest value, most providers to compare)
- 20 fixtures (subset of the 50-query corpus)
- Side-by-side voting UI (Pages SPA, minimal design)
- Elo ratings in D1
- Public leaderboard page
- Manual benchmark trigger (no cron yet)

**Defer:**
- Extraction and document tracks (add after search track is validated)
- Automated daily cron
- Regression detection and alerts
- README badge embedding
- Historical trend charts
- Provider self-submission (let providers submit their own API for evaluation)
