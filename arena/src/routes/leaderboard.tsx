import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Card } from '#/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { Sparkline } from '#/components/Sparkline'
import type { LeaderboardProvider, Track } from '#/lib/types'
import { getLeaderboard } from '#/server/api'

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
  const hasBT = data?.providers.some((p) => p.btElo != null) ?? false

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-[var(--font-display)] text-3xl font-bold text-[var(--text-heading)]">
          Leaderboard
        </h1>
        <Tabs
          value={track}
          onValueChange={(v) => setTrack(v as Track)}
        >
          <TabsList>
            <TabsTrigger value="search">Search</TabsTrigger>
            <TabsTrigger value="extraction">Extraction</TabsTrigger>
            <TabsTrigger value="document">Document</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isLoading ? (
        <div className="py-20 text-center text-[var(--text-muted)]">
          Loading…
        </div>
      ) : (
        <>
          {established.length > 0 && (
            <section>
              <h2 className="mb-3 font-[var(--font-display)] text-lg font-semibold text-[var(--text-heading)]">
                Ranked
              </h2>
              <LeaderboardTable
                providers={established}
                hasBT={hasBT}
                allProviders={data?.providers ?? []}
              />
            </section>
          )}

          {evaluating.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="font-[var(--font-display)] text-lg font-semibold text-[var(--text-heading)]">
                  Evaluating
                </h2>
                <Badge variant="warning">Provisional</Badge>
              </div>
              <LeaderboardTable
                providers={evaluating}
                provisional
                hasBT={hasBT}
                allProviders={data?.providers ?? []}
              />
            </section>
          )}

          {established.length === 0 && evaluating.length === 0 && (
            <div className="py-20 text-center text-[var(--text-muted)]">
              No providers registered yet.
            </div>
          )}
        </>
      )}

      {data && (
        <p className="text-right text-xs text-[var(--text-muted)]">
          Fixture version: {data.fixtureVersion} · Updated:{' '}
          {new Date(data.updatedAt).toLocaleString()}
        </p>
      )}
    </div>
  )
}

function LeaderboardTable({
  providers,
  provisional = false,
  hasBT,
  allProviders,
}: {
  providers: LeaderboardProvider[]
  provisional?: boolean
  hasBT: boolean
  allProviders: LeaderboardProvider[]
}) {
  const eloRange = hasBT ? computeEloRange(allProviders) : null

  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">{provisional ? '' : '#'}</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead className="text-right font-mono">Elo</TableHead>
            {hasBT && <TableHead className="w-40">CI</TableHead>}
            <TableHead className="text-right font-mono">Votes</TableHead>
            <TableHead className="text-right font-mono">F1</TableHead>
            <TableHead className="w-24">Trend</TableHead>
            <TableHead className="text-right font-mono">p50</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((p, i) => {
            const nextP = providers[i + 1]
            const tiedWithNext =
              nextP != null && p.statisticallyTiedWith.includes(nextP.id)

            return (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-[var(--text-muted)]">
                  {provisional ? '–' : i + 1}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-heading)]">
                      {p.displayName}
                    </span>
                    {tiedWithNext && (
                      <Badge variant="accent" className="font-mono text-[10px]">
                        ≈
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono font-semibold tabular-nums text-[var(--text-heading)]">
                  {p.btElo ?? p.elo}
                </TableCell>
                {hasBT && (
                  <TableCell>
                    {p.ciLow != null && p.ciHigh != null && eloRange ? (
                      <CIBar
                        ciLow={p.ciLow}
                        ciHigh={p.ciHigh}
                        elo={p.btElo ?? p.elo}
                        min={eloRange.min}
                        max={eloRange.max}
                      />
                    ) : (
                      <span className="text-xs text-[var(--text-muted)]">
                        —
                      </span>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-right font-mono tabular-nums text-[var(--text-muted)]">
                  {p.votes}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-[var(--text-muted)]">
                  {p.scoreF1 != null ? p.scoreF1.toFixed(3) : '—'}
                </TableCell>
                <TableCell>
                  <Sparkline data={p.sparkline7d} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-[var(--text-muted)]">
                  {p.latencyP50_ms != null ? `${p.latencyP50_ms}ms` : '—'}
                </TableCell>
                <TableCell className="text-right text-[var(--text-muted)]">
                  {p.pricingModel === 'free'
                    ? 'Free'
                    : p.costPerCall_usd != null
                      ? `$${p.costPerCall_usd.toFixed(3)}`
                      : '—'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

function CIBar({
  ciLow,
  ciHigh,
  elo,
  min,
  max,
}: {
  ciLow: number
  ciHigh: number
  elo: number
  min: number
  max: number
}) {
  const range = max - min || 1
  const leftPct = ((ciLow - min) / range) * 100
  const widthPct = ((ciHigh - ciLow) / range) * 100
  const dotPct = ((elo - min) / range) * 100

  return (
    <div
      className="relative h-4 w-full rounded-full bg-[var(--secondary)]"
      title={`${ciLow} – ${ciHigh}`}
    >
      <div
        className="absolute top-1 h-2 rounded-full bg-[var(--accent)]"
        style={{
          left: `${Math.max(0, leftPct)}%`,
          width: `${Math.min(100, widthPct)}%`,
          opacity: 0.25,
        }}
      />
      <div
        className="absolute top-0.5 h-3 w-1.5 rounded-full bg-[var(--accent)]"
        style={{ left: `${Math.max(0, Math.min(98, dotPct))}%` }}
      />
    </div>
  )
}

function computeEloRange(providers: LeaderboardProvider[]): {
  min: number
  max: number
} {
  let min = 1500
  let max = 1500
  for (const p of providers) {
    if (p.ciLow != null) min = Math.min(min, p.ciLow)
    if (p.ciHigh != null) max = Math.max(max, p.ciHigh)
  }
  const padding = (max - min) * 0.1 || 50
  return { min: min - padding, max: max + padding }
}
