import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: AboutPage,
})

function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="mb-6 text-3xl font-bold">About Groundlane Arena</h1>

      <div className="flex flex-col gap-8 text-[var(--text-body)]">
        <Section title="What is this?">
          <p>
            Groundlane Arena is a neutral, open-source evaluation platform for comparing
            search, extraction, and document parsing providers side-by-side. Each match
            sends the same query to two randomly selected providers and shows the results
            anonymously — you vote on which is better without knowing who produced it.
          </p>
        </Section>

        <Section title="How ratings work">
          <p>
            Providers start at 1500 Elo. Each vote adjusts ratings based on the expected
            outcome — an upset (lower-rated provider wins) moves ratings more than a
            confirmation. Ties split the delta equally. "Both bad" votes are recorded but
            don't affect Elo.
          </p>
          <p className="mt-3">
            Providers with fewer than 300 votes show a <Badge>Provisional</Badge> badge
            and appear in a separate section. Once they cross 300 votes, they join the
            main leaderboard.
          </p>
        </Section>

        <Section title="Fairness">
          <ul className="list-inside list-disc space-y-2">
            <li>Results are displayed as "Result A" and "Result B" — no provider branding.</li>
            <li>A/B position is randomized per match to prevent position bias.</li>
            <li>Search results use a uniform format: truncated titles, snippets, and domain-only URLs.</li>
            <li>Metadata like latency and cost is hidden until after the vote.</li>
          </ul>
        </Section>

        <Section title="Anti-gaming">
          <ul className="list-inside list-disc space-y-2">
            <li>One vote per match per IP (hashed with a daily-rotating salt — no raw IPs stored).</li>
            <li>Rate limit: 20 votes per IP per hour.</li>
            <li>Votes from the same /24 subnet within 5 seconds are flagged for review.</li>
          </ul>
        </Section>

        <Section title="Privacy">
          <p>
            We don't store raw IP addresses, set cookies, or track you across sessions.
            Voter identity is a SHA-256 hash of your IP and a daily-rotating salt —
            historical votes cannot be traced back to you. Match results are stored
            for 90 days, then only aggregate scores remain.
          </p>
        </Section>

        <Section title="Provider participation">
          <p>
            All providers are evaluated through their public APIs. Providers can request
            opt-out via{' '}
            <a href="https://github.com/lanefoundry/groundlane/issues" className="text-[var(--accent)] underline">
              GitHub issue
            </a>
            . We don't accept "arena-optimized" special endpoints — everyone gets the
            same fixtures, the same scoring, the same treatment.
          </p>
        </Section>

        <Section title="Open source">
          <p>
            Arena's code, fixtures, and scoring rubrics are all open source under Apache-2.0.
            See the{' '}
            <a href="https://github.com/lanefoundry/groundlane" className="text-[var(--accent)] underline">
              GitHub repository
            </a>{' '}
            for details.
          </p>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold text-[var(--text-heading)]">{title}</h2>
      {children}
    </section>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]">
      {children}
    </span>
  )
}
