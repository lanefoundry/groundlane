import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { cn } from '#/lib/utils'
import type { NewMatchResponse, NormalizedSearchResult, VoteChoice, VoteResponse } from '#/lib/types'
import { createMatch, submitVote } from '#/server/api'

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
      <div className="flex flex-col items-center gap-8 py-16">
        <h1 className="text-3xl font-bold">Ready to vote?</h1>
        <p className="text-[var(--text-muted)]">
          We'll show you the same query answered by two different search providers.
          Pick the one with better results.
        </p>
        <button
          type="button"
          onClick={startMatch}
          disabled={loading}
          className="rounded-xl bg-[var(--accent)] px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Start Match'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <div className="mb-2 text-sm font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Search Query
        </div>
        <h2 className="font-[var(--font-display)] text-xl font-bold text-[var(--text-heading)]">
          "{match.queryText}"
        </h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ResultColumn
          label="Result A"
          results={match.resultA}
          color="var(--win-a)"
          revealed={voteResult ? voteResult.providerA : null}
          isWinner={voteResult?.winner === 'a'}
        />
        <ResultColumn
          label="Result B"
          results={match.resultB}
          color="var(--win-b)"
          revealed={voteResult ? voteResult.providerB : null}
          isWinner={voteResult?.winner === 'b'}
        />
      </div>

      {!voteResult ? (
        <VoteButtons onVote={handleVote} disabled={voting} />
      ) : (
        <PostVoteReveal result={voteResult} onNext={startMatch} loading={loading} />
      )}
    </div>
  )
}

function ResultColumn({
  label,
  results,
  color,
  revealed,
  isWinner,
}: {
  label: string
  results: NormalizedSearchResult[]
  color: string
  revealed: string | null
  isWinner: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-[var(--bg-surface)] shadow-[var(--shadow)]',
        isWinner ? 'border-2' : 'border-[var(--border)]',
      )}
      style={isWinner ? { borderColor: color } : undefined}
    >
      <div
        className="flex items-center justify-between rounded-t-xl px-4 py-3"
        style={{ backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)` }}
      >
        <span className="text-sm font-semibold" style={{ color }}>{label}</span>
        {revealed && (
          <span className="rounded-full bg-[var(--bg-elevated)] px-3 py-1 text-xs font-medium text-[var(--text-heading)]">
            {revealed}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-3 p-4">
        {results.map((r, i) => (
          <SearchResultCard key={i} result={r} />
        ))}
        {results.length === 0 && (
          <p className="py-4 text-center text-sm text-[var(--text-muted)]">No results returned</p>
        )}
      </div>
    </div>
  )
}

function SearchResultCard({ result }: { result: NormalizedSearchResult }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm font-medium text-[var(--text-heading)]">{result.title}</div>
      <div className="text-xs text-[var(--text-muted)]">{result.domain}</div>
      <div className="text-sm text-[var(--text-body)]">{result.snippet}</div>
    </div>
  )
}

function VoteButtons({ onVote, disabled }: { onVote: (w: VoteChoice) => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => onVote('a')}
        disabled={disabled}
        className="rounded-lg px-6 py-3 font-semibold text-white transition-colors disabled:opacity-50"
        style={{ backgroundColor: 'var(--win-a)' }}
      >
        A is better
      </button>
      <button
        type="button"
        onClick={() => onVote('tie')}
        disabled={disabled}
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-6 py-3 font-semibold text-[var(--text-heading)] transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-50"
      >
        Tie
      </button>
      <button
        type="button"
        onClick={() => onVote('b')}
        disabled={disabled}
        className="rounded-lg px-6 py-3 font-semibold text-white transition-colors disabled:opacity-50"
        style={{ backgroundColor: 'var(--win-b)' }}
      >
        B is better
      </button>
      <button
        type="button"
        onClick={() => onVote('both_bad')}
        disabled={disabled}
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-6 py-3 text-sm font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-50"
      >
        Both bad
      </button>
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
    <div className="flex flex-col items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow)]">
      <div className="text-sm font-medium text-[var(--text-muted)]">Results revealed</div>
      <div className="flex gap-8 text-center">
        <div>
          <div className="text-sm text-[var(--text-muted)]">Result A</div>
          <div className="font-semibold text-[var(--text-heading)]">{result.providerA}</div>
          {result.latencyA_ms != null && (
            <div className="text-xs text-[var(--text-muted)]">{result.latencyA_ms}ms</div>
          )}
        </div>
        <div>
          <div className="text-sm text-[var(--text-muted)]">Result B</div>
          <div className="font-semibold text-[var(--text-heading)]">{result.providerB}</div>
          {result.latencyB_ms != null && (
            <div className="text-xs text-[var(--text-muted)]">{result.latencyB_ms}ms</div>
          )}
        </div>
      </div>
      {result.eloChange && (
        <div className="text-xs text-[var(--text-muted)]">
          Elo: A {result.eloChange.a >= 0 ? '+' : ''}{result.eloChange.a}, B {result.eloChange.b >= 0 ? '+' : ''}{result.eloChange.b}
        </div>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={loading}
        className="rounded-lg bg-[var(--accent)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Next Match'}
      </button>
    </div>
  )
}
