import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { cn } from '#/lib/utils'
import type {
  NewMatchResponse,
  NormalizedSearchResult,
  VoteChoice,
  VoteResponse,
} from '#/lib/types'
import { createMatch, submitVote } from '#/server/api'
import { Button } from '#/components/ui/button'
import { Badge } from '#/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'

export const Route = createFileRoute('/match')({
  component: MatchPage,
})

function MatchPage() {
  const [match, setMatch] = useState<NewMatchResponse | null>(null)
  const [voteResult, setVoteResult] = useState<VoteResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [voting, setVoting] = useState(false)

  async function startMatch() {
    setLoading(true)
    setVoteResult(null)
    try {
      const result = await createMatch({ data: { track: 'search' } })
      setMatch(result)
    } finally {
      setLoading(false)
    }
  }

  async function handleVote(winner: VoteChoice) {
    if (!match || voting) return
    setVoting(true)
    try {
      const result = await submitVote({
        data: { matchId: match.matchId, winner, ip: '' },
      })
      setVoteResult(result)
    } finally {
      setVoting(false)
    }
  }

  if (!match) {
    return (
      <div className="flex flex-col items-center gap-6 py-20">
        <div className="text-center">
          <h1 className="mb-3 font-[var(--font-display)] text-3xl font-bold text-[var(--text-heading)]">
            Ready to vote?
          </h1>
          <p className="max-w-md text-[var(--text-muted)]">
            We&apos;ll show you the same query answered by two different search
            providers. Pick the one with better results.
          </p>
        </div>
        <Button size="lg" onClick={startMatch} disabled={loading} className="px-8">
          {loading ? 'Loading…' : 'Start Match'}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <Badge variant="accent" className="mb-3">
          Search Query
        </Badge>
        <h2 className="font-[var(--font-display)] text-xl font-bold text-[var(--text-heading)]">
          &ldquo;{match.queryText}&rdquo;
        </h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ResultColumn
          label="Result A"
          results={match.resultA}
          accentVar="--win-a"
          softVar="--win-a-soft"
          revealed={voteResult ? voteResult.providerA : null}
          isWinner={voteResult?.winner === 'a'}
        />
        <ResultColumn
          label="Result B"
          results={match.resultB}
          accentVar="--win-b"
          softVar="--win-b-soft"
          revealed={voteResult ? voteResult.providerB : null}
          isWinner={voteResult?.winner === 'b'}
        />
      </div>

      {!voteResult ? (
        <VoteButtons onVote={handleVote} disabled={voting} />
      ) : (
        <PostVoteReveal
          result={voteResult}
          onNext={startMatch}
          loading={loading}
        />
      )}
    </div>
  )
}

function ResultColumn({
  label,
  results,
  accentVar,
  softVar,
  revealed,
  isWinner,
}: {
  label: string
  results: NormalizedSearchResult[]
  accentVar: string
  softVar: string
  revealed: string | null
  isWinner: boolean
}) {
  return (
    <Card
      className={cn(
        'overflow-hidden transition-shadow',
        isWinner && 'ring-2 shadow-lg',
      )}
      style={isWinner ? { '--tw-ring-color': `var(${accentVar})` } as React.CSSProperties : undefined}
    >
      <div
        className="flex items-center justify-between px-5 py-3"
        style={{ backgroundColor: `var(${softVar})` }}
      >
        <span
          className="text-sm font-bold"
          style={{ color: `var(${accentVar})` }}
        >
          {label}
        </span>
        {revealed && (
          <Badge variant="default">{revealed}</Badge>
        )}
      </div>
      <CardContent className="flex flex-col gap-4 pt-4">
        {results.map((r, i) => (
          <SearchResultCard key={i} result={r} />
        ))}
        {results.length === 0 && (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">
            No results returned
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function SearchResultCard({ result }: { result: NormalizedSearchResult }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-sm font-medium text-[var(--text-heading)]">
        {result.title}
      </div>
      <div className="font-mono text-xs text-[var(--accent)]">
        {result.domain}
      </div>
      <div className="mt-0.5 text-sm leading-relaxed text-[var(--text-muted)]">
        {result.snippet}
      </div>
    </div>
  )
}

function VoteButtons({
  onVote,
  disabled,
}: {
  onVote: (w: VoteChoice) => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <Button
        variant="vote-a"
        size="lg"
        onClick={() => onVote('a')}
        disabled={disabled}
      >
        A is better
      </Button>
      <Button
        variant="outline"
        size="lg"
        onClick={() => onVote('tie')}
        disabled={disabled}
      >
        Tie
      </Button>
      <Button
        variant="vote-b"
        size="lg"
        onClick={() => onVote('b')}
        disabled={disabled}
      >
        B is better
      </Button>
      <Button
        variant="ghost"
        size="lg"
        onClick={() => onVote('both_bad')}
        disabled={disabled}
        className="text-[var(--text-muted)]"
      >
        Both bad
      </Button>
    </div>
  )
}

function PostVoteReveal({
  result,
  onNext,
  loading,
}: {
  result: VoteResponse
  onNext: () => void
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader className="items-center pb-2">
        <CardTitle className="text-base">Results revealed</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5">
        <div className="flex gap-12 text-center">
          <RevealSide
            label="Result A"
            name={result.providerA}
            latency={result.latencyA_ms}
            accentVar="--win-a"
          />
          <RevealSide
            label="Result B"
            name={result.providerB}
            latency={result.latencyB_ms}
            accentVar="--win-b"
          />
        </div>
        {result.eloChange && (
          <p className="font-mono text-xs text-[var(--text-muted)]">
            Elo: A{' '}
            <span className={result.eloChange.a >= 0 ? 'text-[var(--positive)]' : 'text-[var(--destructive)]'}>
              {result.eloChange.a >= 0 ? '+' : ''}
              {result.eloChange.a}
            </span>
            {' / B '}
            <span className={result.eloChange.b >= 0 ? 'text-[var(--positive)]' : 'text-[var(--destructive)]'}>
              {result.eloChange.b >= 0 ? '+' : ''}
              {result.eloChange.b}
            </span>
          </p>
        )}
        <Button onClick={onNext} disabled={loading}>
          {loading ? 'Loading…' : 'Next Match'}
        </Button>
      </CardContent>
    </Card>
  )
}

function RevealSide({
  label,
  name,
  latency,
  accentVar,
}: {
  label: string
  name: string
  latency: number | null
  accentVar: string
}) {
  return (
    <div>
      <div className="text-xs font-medium text-[var(--text-muted)]">{label}</div>
      <div
        className="mt-1 text-base font-bold"
        style={{ color: `var(${accentVar})` }}
      >
        {name}
      </div>
      {latency != null && (
        <div className="mt-0.5 font-mono text-xs text-[var(--text-muted)]">
          {latency}ms
        </div>
      )}
    </div>
  )
}
