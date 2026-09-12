import type { ProviderRow, Track } from '#/lib/types'

interface PairResult {
  providerA: ProviderRow
  providerB: ProviderRow
  positionSwap: boolean
}

export function selectPair(providers: ProviderRow[], track: Track): PairResult | null {
  const eligible = providers.filter((p) => !p.opted_out)
  if (eligible.length < 2) return null

  const weighted = eligible.flatMap((p) => {
    const votes = eloField(p, track, 'votes')
    const weight = votes < 300 ? 3 : isTopFive(p, eligible, track) ? 2 : 1
    return Array.from({ length: weight }, () => p)
  })

  let attempts = 0
  while (attempts < 50) {
    const a = weighted[Math.floor(Math.random() * weighted.length)]!
    const b = weighted[Math.floor(Math.random() * weighted.length)]!
    if (a.id === b.id) {
      attempts++
      continue
    }

    const eloA = eloField(a, track, 'elo')
    const eloB = eloField(b, track, 'elo')
    const gap = Math.abs(eloA - eloB)

    if (gap < 200 || attempts > 30) {
      const positionSwap = Math.random() > 0.5
      return { providerA: a, providerB: b, positionSwap }
    }
    attempts++
  }

  const [a, b] = eligible.sort(() => Math.random() - 0.5).slice(0, 2) as [ProviderRow, ProviderRow]
  return { providerA: a, providerB: b, positionSwap: Math.random() > 0.5 }
}

function eloField(p: ProviderRow, track: Track, prefix: 'elo' | 'votes'): number {
  const key = `${prefix}_${track}` as keyof ProviderRow
  return p[key] as number
}

function isTopFive(p: ProviderRow, all: ProviderRow[], track: Track): boolean {
  const sorted = [...all].sort((a, b) => eloField(b, track, 'elo') - eloField(a, track, 'elo'))
  return sorted.indexOf(p) < 5
}
