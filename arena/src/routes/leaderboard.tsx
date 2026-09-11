import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { cn } from '#/lib/utils'
import type { LeaderboardProvider, Track } from '#/lib/types'
import { getLeaderboard } from '#/server/api'
import { useState } from 'react'

export const Route = createFileRoute('/leaderboard')({
  component: LeaderboardPage,
})

function LeaderboardPage() {
  const [track, setTrack] = useState<Track>('search')

  const { data, isLoading } = useQuery({
    queryKey: ['leaderboard', track],
    queryFn: () => getLeaderboard({ data: { track } }),
  })

  const established = data?.providers.filter((p) => !p.provisional) ?? []
  const evaluating = data?.providers.filter((p) => p.provisional) ?? []

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Leaderboard</h1>
        <TrackSelector value={track} onChange={setTrack} />
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-[var(--text-muted)]">Loading…</div>
      ) : (
        <>
          {established.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-[var(--text-heading)]">Ranked</h2>
              <LeaderboardTable providers={established} />
            </section>
          )}

          {evaluating.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-[var(--text-heading)]">
                Evaluating
                <span className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]">
                  Provisional
                </span>
              </h2>
              <LeaderboardTable providers={evaluating} provisional />
            </section>
          )}

          {established.length === 0 && evaluating.length === 0 && (
            <div className="py-16 text-center text-[var(--text-muted)]">
              No providers registered yet.
            </div>
          )}
        </>
      )}

      {data && (
        <div className="text-right text-xs text-[var(--text-muted)]">
          Fixture version: {data.fixtureVersion} · Updated: {new Date(data.updatedAt).toLocaleString()}
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

function LeaderboardTable({
  providers,
  provisional = false,
}: {
  providers: LeaderboardProvider[]
  provisional?: boolean
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-[var(--shadow)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
            <th className="px-4 py-3">{provisional ? '' : '#'}</th>
            <th className="px-4 py-3">Provider</th>
            <th className="px-4 py-3 text-right font-[var(--font-mono)]">Elo</th>
            <th className="px-4 py-3 text-right font-[var(--font-mono)]">Votes</th>
            <th className="px-4 py-3 text-right font-[var(--font-mono)]">F1</th>
            <th className="px-4 py-3 text-right font-[var(--font-mono)]">p50</th>
            <th className="px-4 py-3 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p, i) => (
            <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3 font-[var(--font-mono)] text-[var(--text-muted)]">
                {provisional ? '–' : i + 1}
              </td>
              <td className="px-4 py-3 font-medium text-[var(--text-heading)]">{p.displayName}</td>
              <td className="px-4 py-3 text-right font-[var(--font-mono)] font-semibold tabular-nums text-[var(--text-heading)]">
                {p.elo}
              </td>
              <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums text-[var(--text-muted)]">
                {p.votes}
              </td>
              <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums text-[var(--text-muted)]">
                {p.scoreF1 != null ? p.scoreF1.toFixed(3) : '—'}
              </td>
              <td className="px-4 py-3 text-right font-[var(--font-mono)] tabular-nums text-[var(--text-muted)]">
                {p.latencyP50_ms != null ? `${p.latencyP50_ms}ms` : '—'}
              </td>
              <td className="px-4 py-3 text-right text-[var(--text-muted)]">
                {p.pricingModel === 'free'
                  ? 'Free'
                  : p.costPerCall_usd != null
                    ? `$${p.costPerCall_usd.toFixed(3)}`
                    : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
