export interface PairwiseMatch {
  providerA: string
  providerB: string
  winner: 'a' | 'b' | 'tie'
}

export interface ProviderCI {
  elo: number
  ciLow: number
  ciHigh: number
}

const MAX_ITERATIONS = 200
const CONVERGENCE_THRESHOLD = 1e-6

export function fitBradleyTerry(matches: PairwiseMatch[]): Map<string, number> {
  const players = new Set<string>()
  for (const m of matches) {
    players.add(m.providerA)
    players.add(m.providerB)
  }

  if (players.size < 2) {
    const result = new Map<string, number>()
    for (const p of players) result.set(p, 1500)
    return result
  }

  const ids = [...players]
  const n = ids.length
  const idx = new Map<string, number>()
  for (let i = 0; i < n; i++) idx.set(ids[i]!, i)

  const wins = new Float64Array(n)
  const pairCounts = new Map<string, number>()

  for (const m of matches) {
    const ai = idx.get(m.providerA)!
    const bi = idx.get(m.providerB)!
    const key = ai < bi ? `${ai}:${bi}` : `${bi}:${ai}`
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)

    if (m.winner === 'a') {
      wins[ai] += 1
    } else if (m.winner === 'b') {
      wins[bi] += 1
    } else {
      wins[ai] += 0.5
      wins[bi] += 0.5
    }
  }

  const strength = new Float64Array(n).fill(1)

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const prev = new Float64Array(strength)

    for (let i = 0; i < n; i++) {
      if (wins[i] === 0) continue

      let denomSum = 0
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const key = i < j ? `${i}:${j}` : `${j}:${i}`
        const nij = pairCounts.get(key) ?? 0
        if (nij === 0) continue
        denomSum += nij / (strength[i]! + strength[j]!)
      }

      if (denomSum > 0) {
        strength[i] = wins[i]! / denomSum
      }
    }

    let total = 0
    for (let i = 0; i < n; i++) total += strength[i]!
    for (let i = 0; i < n; i++) strength[i]! /= total / n

    let maxDelta = 0
    for (let i = 0; i < n; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(strength[i]! - prev[i]!))
    }
    if (maxDelta < CONVERGENCE_THRESHOLD) break
  }

  return strengthsToElo(ids, strength)
}

export function bootstrapCI(
  matches: PairwiseMatch[],
  iterations = 1000,
  alpha = 0.05,
): Map<string, ProviderCI> {
  if (matches.length === 0) return new Map()

  const mainElos = fitBradleyTerry(matches)
  const players = [...mainElos.keys()]
  const eloSamples = new Map<string, number[]>()
  for (const p of players) eloSamples.set(p, [])

  for (let b = 0; b < iterations; b++) {
    const sample: PairwiseMatch[] = []
    for (let i = 0; i < matches.length; i++) {
      sample.push(matches[Math.floor(Math.random() * matches.length)]!)
    }
    const elos = fitBradleyTerry(sample)
    for (const p of players) {
      eloSamples.get(p)!.push(elos.get(p) ?? 1500)
    }
  }

  const loIdx = Math.floor((alpha / 2) * iterations)
  const hiIdx = Math.floor((1 - alpha / 2) * iterations)

  const result = new Map<string, ProviderCI>()
  for (const p of players) {
    const samples = eloSamples.get(p)!.sort((a, b) => a - b)
    result.set(p, {
      elo: mainElos.get(p)!,
      ciLow: samples[loIdx]!,
      ciHigh: samples[hiIdx]!,
    })
  }

  return result
}

export function areStatisticallyTied(
  ciA: { ciLow: number; ciHigh: number },
  ciB: { ciLow: number; ciHigh: number },
): boolean {
  return ciA.ciLow <= ciB.ciHigh && ciB.ciLow <= ciA.ciHigh
}

function strengthsToElo(ids: string[], strength: Float64Array): Map<string, number> {
  const n = ids.length
  let logSum = 0
  for (let i = 0; i < n; i++) {
    logSum += Math.log10(Math.max(strength[i]!, 1e-10))
  }
  const geoMeanLog = logSum / n

  const result = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const elo = 1500 + 400 * (Math.log10(Math.max(strength[i]!, 1e-10)) - geoMeanLog)
    result.set(ids[i]!, Math.round(elo))
  }
  return result
}
