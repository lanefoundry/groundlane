import { createServerFn } from '@tanstack/react-start'
import { calculateEloChange } from '#/lib/elo'
import type {
  LeaderboardResponse,
  MatchRow,
  NewMatchResponse,
  ProviderInfo,
  ProviderRow,
  Track,
  VoteChoice,
  VoteResponse,
} from '#/lib/types'
import { generateId, voterHash } from './crypto'
import { normalizeSearchResults } from './normalize'
import { selectPair } from './pairing'

interface D1Env {
  DB: {
    prepare: (sql: string) => {
      bind: (...values: unknown[]) => {
        all: <T>() => Promise<{ results: T[] }>
        first: <T>() => Promise<T | null>
        run: () => Promise<unknown>
      }
      all: <T>() => Promise<{ results: T[] }>
      first: <T>() => Promise<T | null>
      run: () => Promise<unknown>
    }
    batch: (stmts: unknown[]) => Promise<unknown>
  }
}

async function getDb(): Promise<D1Env['DB']> {
  // @ts-expect-error cloudflare:workers module available at runtime
  const mod: Record<string, unknown> = await import('cloudflare:workers')
  const env = mod.env as D1Env | undefined
  if (!env?.DB) throw new Error('D1 database not configured')
  return env.DB
}

// --- POST /api/match/new ---

export const createMatch = createServerFn()
  .validator((data: { track: string }) => {
    if (!['search', 'extraction', 'document'].includes(data.track)) throw new Error('Invalid track')
    return { track: data.track as Track }
  })
  .handler(async ({ data }): Promise<NewMatchResponse> => {
    const db = await getDb()
    const { track } = data

    const { results: providers } = await db
      .prepare('SELECT * FROM providers WHERE opted_out = 0')
      .all<ProviderRow>()

    const pair = selectPair(providers, track)
    if (!pair) throw new Error('Not enough eligible providers')

    const matchId = generateId()
    const queryId = 'fixture-placeholder'
    const queryText = 'What is the Cloudflare Workers size limit?'
    const fixtureVersion = 'v2026Q3'

    const mockResultsA = [
      { title: 'Workers Limits', snippet: 'Worker size limit is 10 MB for bundled scripts.', url: 'https://developers.cloudflare.com/workers/platform/limits/' },
    ]
    const mockResultsB = [
      { title: 'Cloudflare Workers', snippet: 'Maximum worker size: 10MB compressed.', url: 'https://docs.cloudflare.com/workers/limits' },
    ]

    const resultA = normalizeSearchResults(mockResultsA)
    const resultB = normalizeSearchResults(mockResultsB)

    const displayA = pair.positionSwap ? resultB : resultA
    const displayB = pair.positionSwap ? resultA : resultB
    const dbProviderA = pair.positionSwap ? pair.providerB.id : pair.providerA.id
    const dbProviderB = pair.positionSwap ? pair.providerA.id : pair.providerB.id

    await db
      .prepare(
        `INSERT INTO matches (id, track, query_id, fixture_version, provider_a, provider_b, position_swap, result_a, result_b, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(
        matchId,
        track,
        queryId,
        fixtureVersion,
        dbProviderA,
        dbProviderB,
        pair.positionSwap ? 1 : 0,
        JSON.stringify(displayA),
        JSON.stringify(displayB),
        Date.now(),
      )
      .run()

    return {
      matchId,
      track,
      queryId,
      queryText,
      resultA: displayA,
      resultB: displayB,
      createdAt: Date.now(),
    }
  })

// --- POST /api/match/:id/vote ---

export const submitVote = createServerFn()
  .validator((data: { matchId: string; winner: string; ip: string }) => {
    if (!data.matchId || !['a', 'b', 'tie', 'both_bad'].includes(data.winner)) throw new Error('Invalid vote')
    return { matchId: data.matchId, winner: data.winner as VoteChoice, ip: data.ip ?? '0.0.0.0' }
  })
  .handler(async ({ data }): Promise<VoteResponse> => {
    const db = await getDb()
    const { matchId, winner, ip } = data

    const match = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId).first<MatchRow>()
    if (!match) throw new Error('Match not found')
    if (match.status === 'voted') throw new Error('Already voted')
    if (match.status === 'invalid') throw new Error('Invalid match')

    const hash = await voterHash(ip)

    const existing = await db
      .prepare('SELECT id FROM votes WHERE match_id = ? AND voter_hash = ?')
      .bind(matchId, hash)
      .first<{ id: string }>()
    if (existing) throw new Error('Already voted on this match')

    const providerA = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(match.provider_a).first<ProviderRow>()
    const providerB = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(match.provider_b).first<ProviderRow>()
    if (!providerA || !providerB) throw new Error('Provider not found')

    const track = match.track
    const eloA = eloForTrack(providerA, track)
    const eloB = eloForTrack(providerB, track)
    const votesA = votesForTrack(providerA, track)
    const votesB = votesForTrack(providerB, track)

    const eloChange = calculateEloChange(eloA, eloB, winner, votesA, votesB)

    const voteId = generateId()
    const now = Date.now()

    const stmts = [
      db.prepare('INSERT INTO votes (id, match_id, winner, voter_hash, voted_at) VALUES (?, ?, ?, ?, ?)').bind(voteId, matchId, winner, hash, now),
      db.prepare("UPDATE matches SET status = 'voted' WHERE id = ?").bind(matchId),
    ]

    if (eloChange) {
      stmts.push(
        db.prepare(`UPDATE providers SET elo_${track} = elo_${track} + ?, votes_${track} = votes_${track} + 1 WHERE id = ?`).bind(eloChange.deltaA, match.provider_a),
        db.prepare(`UPDATE providers SET elo_${track} = elo_${track} + ?, votes_${track} = votes_${track} + 1 WHERE id = ?`).bind(eloChange.deltaB, match.provider_b),
      )
    }

    await db.batch(stmts)

    return {
      matchId,
      winner,
      providerA: providerA.display_name,
      providerB: providerB.display_name,
      latencyA_ms: match.latency_a_ms,
      latencyB_ms: match.latency_b_ms,
      estimatedCostA_usd: providerA.estimated_cost_per_call_usd,
      estimatedCostB_usd: providerB.estimated_cost_per_call_usd,
      eloChange: eloChange ? { a: eloChange.deltaA, b: eloChange.deltaB } : null,
    }
  })

// --- GET /api/leaderboard ---

export const getLeaderboard = createServerFn()
  .validator((data: { track?: string }) => {
    const track = data.track ?? 'search'
    if (!['search', 'extraction', 'document'].includes(track)) throw new Error('Invalid track')
    return { track: track as Track }
  })
  .handler(async ({ data }): Promise<LeaderboardResponse> => {
    const db = await getDb()
    const { track } = data

    const { results: providers } = await db
      .prepare('SELECT * FROM providers WHERE opted_out = 0')
      .all<ProviderRow>()

    const sorted = [...providers].sort((a, b) => eloForTrack(b, track) - eloForTrack(a, track))

    return {
      track,
      fixtureVersion: 'v2026Q3',
      providers: sorted.map((p) => ({
        id: p.id,
        displayName: p.display_name,
        elo: eloForTrack(p, track),
        votes: votesForTrack(p, track),
        provisional: votesForTrack(p, track) < 300,
        scoreF1: null,
        latencyP50_ms: null,
        latencyP95_ms: null,
        costPerCall_usd: p.estimated_cost_per_call_usd,
        pricingModel: p.pricing_model,
        sparkline7d: [],
      })),
      updatedAt: Date.now(),
    }
  })

// --- GET /api/providers ---

export const getProviders = createServerFn().handler(async (): Promise<{ providers: ProviderInfo[] }> => {
  const db = await getDb()
  const { results: providers } = await db.prepare('SELECT * FROM providers').all<ProviderRow>()

  return {
    providers: providers.map((p): ProviderInfo => ({
      id: p.id,
      displayName: p.display_name,
      tracks: ['search'] as Track[],
      eligible: !p.opted_out,
      optedOut: p.opted_out === 1,
      pricingModel: p.pricing_model,
      estimatedCostPerCall_usd: p.estimated_cost_per_call_usd,
    })),
  }
})

// --- Helpers ---

function eloForTrack(p: ProviderRow, track: Track): number {
  return p[`elo_${track}` as keyof ProviderRow] as number
}

function votesForTrack(p: ProviderRow, track: Track): number {
  return p[`votes_${track}` as keyof ProviderRow] as number
}
