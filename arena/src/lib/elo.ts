import type { VoteChoice } from './types'

const PROVISIONAL_THRESHOLD = 300
const K_PROVISIONAL = 32
const K_ESTABLISHED = 16

export function calculateEloChange(
  eloA: number,
  eloB: number,
  winner: VoteChoice,
  votesA: number,
  votesB: number,
): { deltaA: number; deltaB: number } | null {
  if (winner === 'both_bad') return null

  const kA = votesA < PROVISIONAL_THRESHOLD ? K_PROVISIONAL : K_ESTABLISHED
  const kB = votesB < PROVISIONAL_THRESHOLD ? K_PROVISIONAL : K_ESTABLISHED

  const expectedA = 1 / (1 + 10 ** ((eloB - eloA) / 400))
  const expectedB = 1 - expectedA

  let scoreA: number
  let scoreB: number

  switch (winner) {
    case 'a':
      scoreA = 1
      scoreB = 0
      break
    case 'b':
      scoreA = 0
      scoreB = 1
      break
    case 'tie':
      scoreA = 0.5
      scoreB = 0.5
      break
  }

  return {
    deltaA: Math.round(kA * (scoreA - expectedA)),
    deltaB: Math.round(kB * (scoreB - expectedB)),
  }
}

export function isProvisional(votes: number): boolean {
  return votes < PROVISIONAL_THRESHOLD
}
