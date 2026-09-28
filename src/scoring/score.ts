import type { GestureSignal, HeistStats } from '../types/game'

export const createStats = (): HeistStats => ({
  successfulActions: 0,
  mistakes: 0,
  corrections: 0,
  totalAccuracy: 0,
  correctionMs: 0,
  combo: 0,
})

export const scoreSuccess = (currentScore: number, stats: HeistStats, signal: GestureSignal, phaseElapsedMs: number) => {
  const nextCombo = Math.min(5, stats.combo + 1)
  const reactionBonus = Math.max(0, Math.round((8000 - Math.min(8000, phaseElapsedMs)) / 40))
  const precisionBonus = Math.round(signal.confidence * 180 + signal.progress * 120)
  const earned = 850 + reactionBonus + precisionBonus + nextCombo * 100
  return {
    score: currentScore + earned,
    earned,
    stats: {
      ...stats,
      successfulActions: stats.successfulActions + 1,
      combo: nextCombo,
      totalAccuracy: stats.totalAccuracy + Math.round(signal.confidence * 100),
    },
  }
}

export const scoreMistake = (currentScore: number, stats: HeistStats) => ({
  score: Math.max(0, currentScore - 120),
  stats: { ...stats, mistakes: stats.mistakes + 1, combo: 0 },
})

export const styleFor = (accuracy: number, mistakes: number) => {
  if (accuracy >= 94 && mistakes <= 1) return 'GHOST PROTOCOL'
  if (accuracy >= 82) return 'PRECISION'
  if (mistakes <= 3) return 'ADAPTIVE'
  return 'RELENTLESS'
}
