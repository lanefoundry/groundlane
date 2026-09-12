import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import type { BenchmarkRunRow, Track } from '#/lib/types'
import { getBenchmarkHistoryFn, triggerBenchmark } from '#/server/api'

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
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-[var(--font-display)] text-3xl font-bold text-[var(--text-heading)]">
          Benchmark
        </h1>
        <div className="flex items-center gap-3">
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
          <Button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
          >
            {runMutation.isPending ? 'Running…' : 'Run Benchmark'}
          </Button>
        </div>
      </div>

      {runMutation.isSuccess && runMutation.data && (
        <RunSummary data={runMutation.data} />
      )}

      {runMutation.isError && (
        <Card className="border-[var(--destructive)]/30 bg-[var(--destructive-soft)]">
          <CardContent className="py-4 text-sm text-[var(--destructive)]">
            Benchmark failed:{' '}
            {runMutation.error instanceof Error
              ? runMutation.error.message
              : 'Unknown error'}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="py-20 text-center text-[var(--text-muted)]">
          Loading…
        </div>
      ) : history && history.length > 0 ? (
        <HistoryTable
          runs={history as (BenchmarkRunRow & { display_name?: string })[]}
        />
      ) : (
        <div className="py-20 text-center text-[var(--text-muted)]">
          No benchmark runs yet. Click &ldquo;Run Benchmark&rdquo; to start.
        </div>
      )}
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Latest Run</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4 text-sm text-[var(--text-muted)]">
          <span>{data.providerCount} providers</span>
          <span>Fixture {data.fixtureVersion}</span>
          {flaggedCount > 0 && (
            <Badge variant="destructive">
              {flaggedCount} regression(s)
            </Badge>
          )}
          {data.staleFixtures.length > 0 && (
            <Badge variant="warning">
              {data.staleFixtures.length} stale fixture(s)
            </Badge>
          )}
        </div>
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right font-mono">F1</TableHead>
                <TableHead className="text-right font-mono">p50</TableHead>
                <TableHead className="text-right font-mono">p95</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.results.map((r) => (
                <TableRow key={r.providerId}>
                  <TableCell className="font-medium text-[var(--text-heading)]">
                    {r.displayName}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.f1.toFixed(3)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.latencyP50Ms}ms
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.latencyP95Ms}ms
                  </TableCell>
                  <TableCell>
                    {r.flagged ? (
                      <Badge variant="destructive" title={r.flagReason ?? ''}>
                        Regression
                      </Badge>
                    ) : (
                      <Badge variant="success">OK</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </CardContent>
    </Card>
  )
}

function HistoryTable({
  runs,
}: {
  runs: (BenchmarkRunRow & { display_name?: string })[]
}) {
  return (
    <section>
      <h2 className="mb-3 font-[var(--font-display)] text-lg font-semibold text-[var(--text-heading)]">
        History
      </h2>
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right font-mono">F1</TableHead>
              <TableHead className="text-right font-mono">Precision</TableHead>
              <TableHead className="text-right font-mono">Recall</TableHead>
              <TableHead className="text-right font-mono">p50</TableHead>
              <TableHead className="text-right font-mono">p95</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-[var(--text-muted)]">
                  {new Date(r.run_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="font-medium text-[var(--text-heading)]">
                  {r.display_name ?? r.provider_id}
                </TableCell>
                <TableCell className="text-right font-mono font-semibold tabular-nums text-[var(--text-heading)]">
                  {r.score_f1 != null ? r.score_f1.toFixed(3) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-[var(--text-muted)]">
                  {r.score_precision != null
                    ? r.score_precision.toFixed(3)
                    : '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-[var(--text-muted)]">
                  {r.score_recall != null ? r.score_recall.toFixed(3) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-[var(--text-muted)]">
                  {r.latency_p50_ms != null ? `${r.latency_p50_ms}ms` : '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-[var(--text-muted)]">
                  {r.latency_p95_ms != null ? `${r.latency_p95_ms}ms` : '—'}
                </TableCell>
                <TableCell className="text-right text-[var(--text-muted)]">
                  {r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </section>
  )
}
