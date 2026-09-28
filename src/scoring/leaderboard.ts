import type { LeaderboardEntry } from '../types/game'

const STORAGE_KEY = 'motion-heist-leaderboard-v1'

export const getLeaderboard = (): LeaderboardEntry[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as LeaderboardEntry[]
    return Array.isArray(parsed) ? parsed.sort((a, b) => b.score - a.score).slice(0, 10) : []
  } catch {
    return []
  }
}

export const saveScore = (entry: LeaderboardEntry) => {
  const entries = [...getLeaderboard(), entry].sort((a, b) => b.score - a.score).slice(0, 10)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)) } catch { /* private mode: results still render */ }
  return entries
}
