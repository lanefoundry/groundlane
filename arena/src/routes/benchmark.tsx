import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from '#/lib/utils'
import type { BenchmarkRunRow, Track } from '#/lib/types'
import { triggerBenchmark, getBenchmarkHistoryFn } from '#/server/api'
import { useState } from 'react'

export const Route = createFileRoute('/benchmark')({
  component: BenchmarkPage,
})

function BenchmarkPage() {
  const [track, setTrack] = useState<Track>('search')
  const queryClient = useQueryClient()

  const { data: history, isLoading } = useQuery({
    queryKey: ['benchmark-history', track],
    queryFn: () => getBenchmarkHistoryFn({ data: { track } }),
  })

  const runMutation = useMutation({
    mutationFn: () => triggerBenchmark({ data: { track } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['benchmark-history', track] })
    },
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Benchmark</h1>
        <div className="flex items-center gap-3">
          <TrackSelector value={track} onChange={setTrack} />
          <button
            type="button"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {runMutation.isPending ? 'Running…' : 'Run Benchmark'}
          </button>
        </div>
      </div>

      {runMutation.isSuccess && runMutation.data && (
        <RunSummary data={runMutation.data} />
      )}

      {runMutation.isError && (
        <div className="rounded-lg border border-[var(--both-bad)] bg-[color-mix(in_srgb,var(--both-bad)_8%,transparent)] p-4 text-sm text-[var(--both-bad)]">
          Benchmark failed: {runMutation.error instanceof Error ? runMutation.error.message : 'Unknown error'}
        </div>
      )}

      {isLoading ? (
        <div className="py-16 text-center text-[var(--text-muted)]">Loading…</div>
      ) : history && history.length > 0 ? (
        <HistoryTable runs={history as (BenchmarkRunRow & { display_name?: string })[]} />
      ) : (
        <div className="py-16 text-center text-[var(--text-muted)]">
          No benchmark runs yet. Click "Run Benchmark" to start.
        </div>
      )}
    </div>
  )
}

function TrackSelector({ value, onChange }: { value: Track; onChange: (t: Track) => void }) {
  const tracks: { id: Track; label: string }[] = [
    { id: 'search', label: 'Search' },
    { id: 'extraction', label: 'Extraction' },
    { id: 'document', label: 'Document' },
  ]

  return (
    <div className="flex rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]">
      {tracks.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors',
            value === t.id
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-muted)] hover:text-[var(--text-heading)]',
            t.id === 'search' && 'rounded-l-lg',
            t.id === 'document' && 'rounded-r-lg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

interface RunSummaryData {
  track: Track
  fixtureVersion: string
  providerCount: number
  results: {
    providerId: string
    displayName: string
    f1: number
    latencyP50Ms: number
    latencyP95Ms: number
    flagged: boolean
    flagReason: string | null
  }[]
  staleFixtures: string[]
}

function RunSummary({ data }: { data: RunSummaryData }) {
  const flaggedCount = data.results.filter((r) => r.flagged).length

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow)]">
      <h3 className="mb-3 font-semibold text-[var(--text-heading)]">Latest Run</h3>
      <div className="mb-4 flex gap-6 text-sm text-[var(--text-muted)]">
        <span>{data.providerCount} providers</span>
        <span>Fixture {data.fixtureVersion}</span>
        {flaggedCount > 0 && (
          <span className="font-medium text-[var(--both-bad)]">{flaggedCount} regression(s) flagged</span>
        )}
        {data.staleFixtures.length > 0 && (
          <span className="font-medium text-[var(--warning)]">{data.staleFixtures.length} stale fixture(s) skipped</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2 text-right font-[var(--font-mono)]">F1</th>
              <th className="px-3 py-2 text-right font-[var(--font-mono)]">p50</th>
              <th className="px-3 py-2 text-right font-[var(--font-mono)]">p95</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((r) => (
              <tr key={r.providerId} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2 font-medium text-[var(--text-heading)]">{r.displayName}</td>
                <td className="px-3 py-2 text-right font-[var(--font-mono)] tabular-nums">{r.f1.toFixed(3)}</td>
                <td className="px-3 py-2 text-right font-[var(--font-mono)] tabular-nums">{r.latencyP50Ms}ms</td>
                <td className="px-3 py-2 text-right font-[var(--font-mono)] tabular-nums">{r.latencyP95Ms}ms</td>
                <td className="px-3 py-2">
                  {r.flagged ? (
                    <span className="rounded-full bg-[color-mix(in_srgb,var(--both-bad)_10%,transparent)] px-2 py-0.5 text-xs font-medium text-[var(--both-bad)]" title={r.flagReason ?? ''}>
                      Regression
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">OK</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HistoryTable({ runs }: { runs: (BenchmarkRunRow & { display_name?: string })[] }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-[var(--text-heading)]">History</h2>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-[var(--shadow)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3 text-right font-[var(--font-mono)]">F1</th>
              <th className="px-4 py-3 text-right font-[var(--font-mono)]">Precision</th>
              <th className="px-4 py-3 text-right font-[var(--font-mono)]">Recall</th>
              <th className="px-4 py-3 text-right font-[var(--font-mono)]">p50</th>
              <th className="px-4 py-3 text-right font-[var(--font-mono)]">p95</th>
              <th className="px-4 py-3 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3 text-[var(--text-muted)]">
                  {new Date(r.run_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 font-medium text-[var(--text-heading)]">
                  {r.display_name ?? r.provider_id}
                </td>
                <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums font-semibold text-[var(--text-heading)]">
                  {r.score_f1 != null ? r.score_f1.toFixed(3) : '—'}
                </td>
                <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums text-[var(--text-muted)]">
                  {r.score_precision != null ? r.score_precision.toFixed(3) : '—'}
                </td>
                <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums text-[var(--text-muted)]">
                  {r.score_recall != null ? r.score_recall.toFixed(3) : '—'}
                </td>
                <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums text-[var(--text-muted)]">
                  {r.latency_p50_ms != null ? `${r.latency_p50_ms}ms` : '—'}
                </td>
                <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums text-[var(--text-muted)]">
                  {r.latency_p95_ms != null ? `${r.latency_p95_ms}ms` : '—'}
                </td>
                <td className="px-4 py-3 text-right text-[var(--text-muted)]">
                  {r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
