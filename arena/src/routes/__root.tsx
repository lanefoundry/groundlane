import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Scripts,
} from '@tanstack/react-router'
import { Button } from '#/components/ui/button'
import { Separator } from '#/components/ui/separator'
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
      <body className="flex min-h-screen flex-col bg-[var(--bg)] font-sans text-[var(--foreground)] antialiased">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
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
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--card)]/90 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="flex items-center gap-2.5 font-[var(--font-display)] text-lg font-bold text-[var(--text-heading)] transition-opacity hover:opacity-80"
        >
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] font-mono text-sm font-bold text-white">
            A
          </span>
          Arena
        </Link>

        <div className="flex items-center gap-1">
          <Link to="/leaderboard">
            <Button variant="ghost" size="sm">
              Leaderboard
            </Button>
          </Link>
          <Link to="/benchmark">
            <Button variant="ghost" size="sm">
              Benchmark
            </Button>
          </Link>
          <Link to="/about">
            <Button variant="ghost" size="sm">
              About
            </Button>
          </Link>
          <Separator orientation="vertical" className="mx-2 h-5" />
          <Link to="/match">
            <Button size="sm">Vote Now</Button>
          </Link>
        </div>
      </nav>
    </header>
  )
}

function Footer() {
  return (
    <footer className="border-t border-[var(--border)] bg-[var(--card)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 text-sm text-[var(--text-muted)] sm:px-6 lg:px-8">
        <span>Groundlane Arena — neutral, open-source provider evaluation</span>
        <a
          href="https://github.com/lanefoundry/groundlane"
          className="font-medium text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)]"
        >
          GitHub
        </a>
      </div>
    </footer>
  )
}
