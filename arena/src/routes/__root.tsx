import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import appCss from '../styles.css?url'

interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Groundlane Arena — Search Provider Evaluation' },
      {
        name: 'description',
        content:
          'Side-by-side blind evaluation of search, extraction, and document parsing providers.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-[var(--bg)] font-[var(--font-body)] text-[var(--text-body)] antialiased">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          {children}
        </main>
        <Footer />
        <Scripts />
      </body>
    </html>
  )
}

function Header() {
  return (
    <header className="border-b border-[var(--border)] bg-[var(--bg-surface)]">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <a href="/" className="flex items-center gap-2 font-[var(--font-display)] text-lg font-bold text-[var(--text-heading)]">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-white">
            A
          </span>
          Groundlane Arena
        </a>
        <div className="flex items-center gap-6 text-sm font-medium">
          <a href="/leaderboard" className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-heading)]">
            Leaderboard
          </a>
          <a href="/about" className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-heading)]">
            About
          </a>
          <a
            href="/match"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]"
          >
            Vote Now
          </a>
        </div>
      </nav>
    </header>
  )
}

function Footer() {
  return (
    <footer className="border-t border-[var(--border)] bg-[var(--bg-surface)] py-6 text-center text-sm text-[var(--text-muted)]">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        Groundlane Arena — neutral, open-source provider evaluation.{' '}
        <a href="https://github.com/lanefoundry/groundlane" className="underline hover:text-[var(--text-heading)]">
          GitHub
        </a>
      </div>
    </footer>
  )
}
