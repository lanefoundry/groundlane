import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '#/components/ui/badge'
import { Card, CardContent } from '#/components/ui/card'
import { Separator } from '#/components/ui/separator'

export const Route = createFileRoute('/about')({
  component: AboutPage,
})

function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="mb-8 font-[var(--font-display)] text-3xl font-bold text-[var(--text-heading)]">
        About Groundlane Arena
      </h1>

      <div className="flex flex-col gap-6">
        <AboutSection title="What is this?">
          <p>
            Groundlane Arena is a neutral, open-source evaluation platform for
            comparing search, extraction, and document parsing providers
            side-by-side. Each match sends the same query to two randomly
            selected providers and shows the results anonymously — you vote on
            which is better without knowing who produced it.
          </p>
        </AboutSection>

        <Separator />

        <AboutSection title="How ratings work">
          <p>
            Providers start at 1500 Elo. Each vote adjusts ratings based on the
            expected outcome — an upset moves ratings more than a confirmation.
            Ties split the delta equally. &ldquo;Both bad&rdquo; votes are recorded but
            don&apos;t affect Elo.
          </p>
          <p className="mt-3">
            Providers with fewer than 300 votes show a{' '}
            <Badge variant="warning">Provisional</Badge> badge and appear in a
            separate section. Once they cross 300 votes, they join the main
            leaderboard.
          </p>
          <Card className="mt-4 bg-[var(--secondary)]">
            <CardContent className="py-4 text-sm">
              <strong className="text-[var(--text-heading)]">
                Phase 2 upgrade:
              </strong>{' '}
              When enough votes accumulate, rankings switch from incremental Elo
              to Bradley-Terry MLE with bootstrap 95% confidence intervals.
              Providers whose CIs overlap are marked as statistically tied.
            </CardContent>
          </Card>
        </AboutSection>

        <Separator />

        <AboutSection title="Fairness">
          <ul className="flex flex-col gap-2">
            <AboutItem>
              Results are displayed as &ldquo;Result A&rdquo; and &ldquo;Result B&rdquo; — no
              provider branding.
            </AboutItem>
            <AboutItem>
              A/B position is randomized per match to prevent position bias.
            </AboutItem>
            <AboutItem>
              Search results use a uniform format: truncated titles, snippets,
              and domain-only URLs.
            </AboutItem>
            <AboutItem>
              Metadata like latency and cost is hidden until after the vote.
            </AboutItem>
          </ul>
        </AboutSection>

        <Separator />

        <AboutSection title="Anti-gaming">
          <ul className="flex flex-col gap-2">
            <AboutItem>
              One vote per match per IP (hashed with a daily-rotating salt — no
              raw IPs stored).
            </AboutItem>
            <AboutItem>Rate limit: 20 votes per IP per hour.</AboutItem>
            <AboutItem>
              Votes from the same /24 subnet within 5 seconds are flagged for
              review.
            </AboutItem>
          </ul>
        </AboutSection>

        <Separator />

        <AboutSection title="Privacy">
          <p>
            We don&apos;t store raw IP addresses, set cookies, or track you across
            sessions. Voter identity is a SHA-256 hash of your IP and a
            daily-rotating salt — historical votes cannot be traced back to you.
            Match results are stored for 90 days, then only aggregate scores
            remain.
          </p>
        </AboutSection>

        <Separator />

        <AboutSection title="Provider participation">
          <p>
            All providers are evaluated through their public APIs. Providers can
            request opt-out via{' '}
            <a
              href="https://github.com/lanefoundry/groundlane/issues"
              className="font-medium text-[var(--accent)] underline transition-colors hover:text-[var(--accent-hover)]"
            >
              GitHub issue
            </a>
            . We don&apos;t accept &ldquo;arena-optimized&rdquo; special endpoints — everyone
            gets the same fixtures, the same scoring, the same treatment.
          </p>
        </AboutSection>

        <Separator />

        <AboutSection title="Open source">
          <p>
            Arena&apos;s code, fixtures, and scoring rubrics are all open source
            under Apache-2.0. See the{' '}
            <a
              href="https://github.com/lanefoundry/groundlane"
              className="font-medium text-[var(--accent)] underline transition-colors hover:text-[var(--accent-hover)]"
            >
              GitHub repository
            </a>{' '}
            for details.
          </p>
        </AboutSection>
      </div>
    </div>
  )
}

function AboutSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="mb-3 font-[var(--font-display)] text-xl font-semibold text-[var(--text-heading)]">
        {title}
      </h2>
      <div className="leading-relaxed text-[var(--text-body)]">{children}</div>
    </section>
  )
}

function AboutItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
      <span>{children}</span>
    </li>
  )
}
