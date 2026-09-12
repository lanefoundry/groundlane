import type {
  BenchmarkRunRow,
  NormalizedSearchResult,
  ProviderRow,
  SearchFixture,
  Track,
} from '#/lib/types'
import { generateId } from './crypto'
import { dispatchSearch } from './dispatch'
import { extractDomain } from './normalize'

import stableFixturesJson from '../../fixtures/search/stable/v2026Q3/fixtures.json'
import temporalFixturesJson from '../../fixtures/search/temporal/v2026-09/fixtures.json'

const STABLE_FIXTURES: SearchFixture[] = stableFixturesJson as SearchFixture[]
const TEMPORAL_FIXTURES: SearchFixture[] = temporalFixturesJson as SearchFixture[]

interface D1Like {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => {
      all: <T>() => Promise<{ results: T[] }>
      first: <T>() => Promise<T | null>
      run: () => Promise<unknown>
    }
    all: <T>() => Promise<{ results: T[] }>
  }
}

interface ProviderEnv {
  TAVILY_API_KEY?: string
  EXA_API_KEY?: string
  BRAVE_API_KEY?: string
  SERPER_API_KEY?: string
  SERPAPI_API_KEY?: string
  LINKUP_API_KEY?: string
  YOU_API_KEY?: string
  FIRECRAWL_API_KEY?: string
  TINYFISH_API_KEY?: string
  PARALLEL_API_KEY?: string
  SEARCHAPI_API_KEY?: string
  BROWSERBASE_API_KEY?: string
  KEENABLE_API_KEY?: string
}

export interface BenchmarkProviderResult {
  providerId: string
  displayName: string
  runId: string
  precision: number
  recall: number
  f1: number
  latencyP50Ms: number
  latencyP95Ms: number
  costUsd: number | null
  flagged: boolean
  flagReason: string | null
}

export interface BenchmarkResult {
  track: Track
  fixtureVersion: string
  providerCount: number
  fixtureCount: number
  results: BenchmarkProviderResult[]
  staleFixtures: string[]
  runAt: number
}

export async function runBenchmark(
  track: Track,
  providerFilter: string[] | undefined,
  db: D1Like,
  env: ProviderEnv,
): Promise<BenchmarkResult> {
  const { results: allProviders } = await db
    .prepare('SELECT * FROM providers WHERE opted_out = 0')
    .all<ProviderRow>()

  let providers = allProviders.filter((p) => {
    const tracks = (p.tracks ?? 'search').split(',')
    return tracks.includes(track)
  })

  if (providerFilter && providerFilter.length > 0) {
    providers = providers.filter((p) => providerFilter.includes(p.id))
  }

  const staleFixtures = await checkFixtureStaleness()
  const staleIds = new Set(staleFixtures)

  const allFixtures = [...STABLE_FIXTURES, ...TEMPORAL_FIXTURES]
  const fixtures = allFixtures.filter((f) => !staleIds.has(f.id))

  const fixtureVersion = 'v2026Q3'
  const runAt = Date.now()
  const results: BenchmarkProviderResult[] = []

  for (const provider of providers) {
    const perFixture: { precision: number; recall: number; f1: number; latencyMs: number }[] = []

    for (const fixture of fixtures) {
      const outcome = await dispatchSearch(provider.id, fixture.query, env)
      if (!outcome.ok) continue

      const scores = scoreResults(outcome.data.results, fixture.groundTruth.sourceUrls)
      perFixture.push({
        ...scores,
        latencyMs: outcome.data.latencyMs,
      })
    }

    if (perFixture.length === 0) continue

    const avgPrecision = avg(perFixture.map((r) => r.precision))
    const avgRecall = avg(perFixture.map((r) => r.recall))
    const avgF1 = avg(perFixture.map((r) => r.f1))
    const latencies = perFixture.map((r) => r.latencyMs).sort((a, b) => a - b)
    const p50 = percentile(latencies, 0.5)
    const p95 = percentile(latencies, 0.95)
    const costUsd = provider.estimated_cost_per_call_usd != null
      ? provider.estimated_cost_per_call_usd * fixtures.length
      : null

    const runId = generateId()
    await db
      .prepare(
        `INSERT INTO benchmark_runs (id, track, provider_id, fixture_version, score_precision, score_recall, score_f1, latency_p50_ms, latency_p95_ms, cost_usd, run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(runId, track, provider.id, fixtureVersion, avgPrecision, avgRecall, avgF1, p50, p95, costUsd, runAt)
      .run()

    const regression = await detectRegression(db, track, provider.id, avgF1)

    results.push({
      providerId: provider.id,
      displayName: provider.display_name,
      runId,
      precision: avgPrecision,
      recall: avgRecall,
      f1: avgF1,
      latencyP50Ms: p50,
      latencyP95Ms: p95,
      costUsd,
      flagged: regression.flagged,
      flagReason: regression.reason,
    })
  }

  return {
    track,
    fixtureVersion,
    providerCount: providers.length,
    fixtureCount: fixtures.length,
    results,
    staleFixtures,
    runAt,
  }
}

function scoreResults(
  results: NormalizedSearchResult[],
  expectedUrls: string[],
): { precision: number; recall: number; f1: number } {
  if (expectedUrls.length === 0) {
    return { precision: 1, recall: 1, f1: 1 }
  }

  const expectedDomains = new Set(expectedUrls.map((u) => extractDomain(u)))
  const returnedDomains = results.map((r) => r.domain)

  const matched = returnedDomains.filter((d) => expectedDomains.has(d)).length

  const precision = returnedDomains.length > 0 ? matched / returnedDomains.length : 0
  const recall = expectedDomains.size > 0 ? matched / expectedDomains.size : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

  return { precision, recall, f1 }
}

async function detectRegression(
  db: D1Like,
  track: Track,
  providerId: string,
  currentF1: number,
): Promise<{ flagged: boolean; reason: string | null }> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const { results: recentRuns } = await db
    .prepare(
      `SELECT score_f1 FROM benchmark_runs
       WHERE track = ? AND provider_id = ? AND run_at > ? AND score_f1 IS NOT NULL
       ORDER BY run_at DESC LIMIT 30`,
    )
    .bind(track, providerId, sevenDaysAgo)
    .all<{ score_f1: number }>()

  if (recentRuns.length < 2) {
    return { flagged: false, reason: null }
  }

  const rollingAvg = avg(recentRuns.map((r) => r.score_f1))
  if (rollingAvg === 0) {
    return { flagged: false, reason: null }
  }

  const dropPct = ((rollingAvg - currentF1) / rollingAvg) * 100

  if (dropPct > 10) {
    return {
      flagged: true,
      reason: `F1 dropped ${dropPct.toFixed(1)}% from 7-day avg (${rollingAvg.toFixed(3)} → ${currentF1.toFixed(3)})`,
    }
  }

  return { flagged: false, reason: null }
}

export async function checkFixtureStaleness(): Promise<string[]> {
  const staleIds: string[] = []

  for (const fixture of TEMPORAL_FIXTURES) {
    for (const url of fixture.groundTruth.sourceUrls) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3000)
        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
        })
        clearTimeout(timeout)
        if (response.status === 404) {
          staleIds.push(fixture.id)
          break
        }
      } catch {
        staleIds.push(fixture.id)
        break
      }
    }
  }

  return staleIds
}

export async function getBenchmarkHistory(
  db: D1Like,
  track: Track,
  limit: number = 50,
): Promise<BenchmarkRunRow[]> {
  const { results } = await db
    .prepare(
      `SELECT br.*, p.display_name
       FROM benchmark_runs br
       JOIN providers p ON p.id = br.provider_id
       WHERE br.track = ?
       ORDER BY br.run_at DESC
       LIMIT ?`,
    )
    .bind(track, limit)
    .all<BenchmarkRunRow & { display_name: string }>()

  return results
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}
