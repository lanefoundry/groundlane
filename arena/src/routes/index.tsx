import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <div className="flex flex-col items-center gap-12 py-12">
      <section className="max-w-2xl text-center">
        <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
          Which search result
          <br />
          is actually better?
        </h1>
        <p className="text-lg text-[var(--text-muted)]">
          Compare search providers side-by-side in blind evaluations.
          Your votes build a community-driven leaderboard.
        </p>
      </section>

      <a
        href="/match"
        className="rounded-xl bg-[var(--accent)] px-8 py-4 text-lg font-semibold text-white shadow-md transition-all hover:bg-[var(--accent-hover)] hover:shadow-lg"
      >
        Start Voting
      </a>

      <section className="grid w-full max-w-4xl gap-6 sm:grid-cols-3">
        <StatCard label="Providers" value="13" />
        <StatCard label="Votes Cast" value="0" />
        <StatCard label="Search Fixtures" value="20" />
      </section>

      <section className="w-full max-w-3xl">
        <h2 className="mb-4 text-center text-xl font-semibold">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Step number={1} title="Same query, two providers" description="We send the same search query to two randomly selected providers." />
          <Step number={2} title="You pick the winner" description="Results are shown anonymously as A and B. Vote for the better one, or call it a tie." />
          <Step number={3} title="Elo ratings update" description="Votes feed an Elo rating system. The leaderboard reflects real human preferences." />
        </div>
      </section>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-6 text-center shadow-[var(--shadow)]">
      <div className="font-[var(--font-display)] text-3xl font-bold text-[var(--text-heading)]">{value}</div>
      <div className="mt-1 text-sm text-[var(--text-muted)]">{label}</div>
    </div>
  )
}

function Step({ number, title, description }: { number: number; title: string; description: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow)]">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-soft)] font-[var(--font-mono)] text-sm font-bold text-[var(--accent)]">
        {number}
      </div>
      <h3 className="font-semibold text-[var(--text-heading)]">{title}</h3>
      <p className="text-sm text-[var(--text-muted)]">{description}</p>
    </div>
  )
}
