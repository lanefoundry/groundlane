-- Groundlane Arena — initial schema

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  elo_search INTEGER DEFAULT 1500,
  elo_extraction INTEGER DEFAULT 1500,
  elo_document INTEGER DEFAULT 1500,
  votes_search INTEGER DEFAULT 0,
  votes_extraction INTEGER DEFAULT 0,
  votes_document INTEGER DEFAULT 0,
  estimated_cost_per_call_usd REAL,
  pricing_model TEXT,
  pricing_note TEXT,
  pricing_verified_at INTEGER,
  opted_out INTEGER DEFAULT 0,
  opted_out_at INTEGER
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL,
  query_id TEXT NOT NULL,
  fixture_version TEXT NOT NULL,
  provider_a TEXT NOT NULL REFERENCES providers(id),
  provider_b TEXT NOT NULL REFERENCES providers(id),
  position_swap INTEGER DEFAULT 0,
  result_a TEXT,
  result_b TEXT,
  status TEXT DEFAULT 'pending',
  latency_a_ms INTEGER,
  latency_b_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  winner TEXT NOT NULL,
  voter_hash TEXT NOT NULL,
  voted_at INTEGER NOT NULL
);

CREATE TABLE match_failures (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  error_code TEXT,
  error_message TEXT,
  failed_at INTEGER NOT NULL
);

CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  fixture_version TEXT NOT NULL,
  score_precision REAL,
  score_recall REAL,
  score_f1 REAL,
  latency_p50_ms INTEGER,
  latency_p95_ms INTEGER,
  cost_usd REAL,
  run_at INTEGER NOT NULL,
  results_r2_key TEXT
);

-- Indexes for common queries
CREATE INDEX idx_matches_track_status ON matches(track, status);
CREATE INDEX idx_matches_created_at ON matches(created_at);
CREATE INDEX idx_votes_match_id ON votes(match_id);
CREATE INDEX idx_votes_voter_hash ON votes(voter_hash, voted_at);
CREATE INDEX idx_match_failures_match_id ON match_failures(match_id);
CREATE INDEX idx_benchmark_runs_track_provider ON benchmark_runs(track, provider_id, run_at);
