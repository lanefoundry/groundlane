// --- D1 Row Types ---

export interface ProviderRow {
  id: string
  display_name: string
  tracks: string | null
  elo_search: number
  elo_extraction: number
  elo_document: number
  votes_search: number
  votes_extraction: number
  votes_document: number
  estimated_cost_per_call_usd: number | null
  pricing_model: string | null
  pricing_note: string | null
  pricing_verified_at: number | null
  opted_out: number
  opted_out_at: number | null
}

export interface MatchRow {
  id: string
  track: Track
  query_id: string
  fixture_version: string
  provider_a: string
  provider_b: string
  position_swap: number
  result_a: string | null
  result_b: string | null
  status: 'pending' | 'voted' | 'invalid'
  latency_a_ms: number | null
  latency_b_ms: number | null
  created_at: number
}

export interface VoteRow {
  id: string
  match_id: string
  winner: VoteChoice
  voter_hash: string
  voted_at: number
}

export interface MatchFailureRow {
  id: string
  match_id: string
  provider_id: string
  error_code: string | null
  error_message: string | null
  failed_at: number
}

export interface BenchmarkRunRow {
  id: string
  track: Track
  provider_id: string
  fixture_version: string
  score_precision: number | null
  score_recall: number | null
  score_f1: number | null
  latency_p50_ms: number | null
  latency_p95_ms: number | null
  cost_usd: number | null
  run_at: number
  results_r2_key: string | null
}

// --- Domain Types ---

export type Track = 'search' | 'extraction' | 'document'

export type VoteChoice = 'a' | 'b' | 'tie' | 'both_bad'

export interface NormalizedSearchResult {
  title: string
  snippet: string
  domain: string
}

// --- API Request/Response ---

export interface NewMatchRequest {
  track: Track
}

export interface NewMatchResponse {
  matchId: string
  track: Track
  queryId: string
  queryText: string
  resultA: NormalizedSearchResult[]
  resultB: NormalizedSearchResult[]
  createdAt: number
}

export interface VoteRequest {
  winner: VoteChoice
}

export interface VoteResponse {
  matchId: string
  winner: VoteChoice
  providerA: string
  providerB: string
  latencyA_ms: number | null
  latencyB_ms: number | null
  estimatedCostA_usd: number | null
  estimatedCostB_usd: number | null
  eloChange: { a: number; b: number } | null
}

export interface LeaderboardProvider {
  id: string
  displayName: string
  elo: number
  btElo: number | null
  ciLow: number | null
  ciHigh: number | null
  statisticallyTiedWith: string[]
  votes: number
  provisional: boolean
  scoreF1: number | null
  latencyP50_ms: number | null
  latencyP95_ms: number | null
  costPerCall_usd: number | null
  pricingModel: string | null
  sparkline7d: number[]
}

export interface LeaderboardResponse {
  track: Track
  fixtureVersion: string
  providers: LeaderboardProvider[]
  updatedAt: number
}

export interface ProviderInfo {
  id: string
  displayName: string
  tracks: Track[]
  eligible: boolean
  optedOut: boolean
  pricingModel: string | null
  estimatedCostPerCall_usd: number | null
}

// --- Fixture ---

export interface SearchFixture {
  id: string
  query: string
  stratum: 'factual' | 'current_events' | 'technical_docs' | 'multi_hop' | 'ambiguous'
  groundTruth: {
    answer: string
    sourceUrls: string[]
  }
  version: string
  createdAt: string
  verifiedAt: string
}
