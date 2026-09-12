import { createFileRoute, Link } from '@tanstack/react-router'
import { Button } from '#/components/ui/button'
import { Card, CardContent } from '#/components/ui/card'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <div className="flex flex-col items-center gap-16 py-12">
      <section className="max-w-2xl text-center">
        <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-[var(--accent)]">
          Blind provider evaluation
        </p>
        <h1 className="mb-5 font-[var(--font-display)] text-4xl font-bold tracking-tight text-[var(--text-heading)] sm:text-5xl">
          Which search result
          <br />
          is actually better?
        </h1>
        <p className="mx-auto max-w-lg text-lg leading-relaxed text-[var(--text-muted)]">
          Compare search providers side-by-side in anonymous evaluations.
          Your votes build a community-driven leaderboard powered by
          Bradley-Terry statistics.
        </p>
        <div className="mt-8">
          <Link to="/match">
            <Button size="lg" className="px-8 text-base">
              Start Voting
            </Button>
          </Link>
        </div>
      </section>

      <section className="grid w-full max-w-3xl gap-4 sm:grid-cols-3">
        <StatCard value="13" label="Providers" />
        <StatCard value="0" label="Votes Cast" />
        <StatCard value="20" label="Search Fixtures" />
      </section>

      <section className="w-full max-w-3xl">
        <h2 className="mb-6 text-center font-[var(--font-display)] text-xl font-semibold text-[var(--text-heading)]">
          How it works
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <StepCard
            step={1}
            title="Same query, two providers"
            description="We send the same search query to two randomly selected providers from 13 candidates."
          />
          <StepCard
            step={2}
            title="You pick the winner"
            description="Results appear anonymously as A and B. Vote for the better one, tie, or mark both as bad."
          />
          <StepCard
            step={3}
            title="Ratings converge"
            description="Votes feed an Elo + Bradley-Terry system. The leaderboard reflects real human preferences."
          />
        </div>
      </section>
    </div>
  )
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <Card className="text-center">
      <CardContent className="py-6">
        <div className="font-[var(--font-display)] text-3xl font-bold tabular-nums text-[var(--text-heading)]">
          {value}
        </div>
        <div className="mt-1 text-sm text-[var(--text-muted)]">{label}</div>
      </CardContent>
    </Card>
  )
}

function StepCard({
  step,
  title,
  description,
}: {
  step: number
  title: string
  description: string
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-soft)] font-mono text-sm font-bold text-[var(--accent)]">
          {step}
        </span>
        <h3 className="font-[var(--font-display)] font-semibold text-[var(--text-heading)]">
          {title}
        </h3>
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">
          {description}
        </p>
      </CardContent>
    </Card>
  )
}
