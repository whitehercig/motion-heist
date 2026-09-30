import type { LeaderboardEntry } from '../types/game'

/** Same key as the previous storage module, so existing records survive the upgrade. */
const STORAGE_KEY = 'motion-heist-leaderboard-v1'
export const LEADERBOARD_SIZE = 10
export const CALLSIGN_LENGTH = 3

const isEntry = (value: unknown): value is LeaderboardEntry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.nickname === 'string'
    && typeof entry.score === 'number' && Number.isFinite(entry.score)
    && typeof entry.accuracy === 'number' && Number.isFinite(entry.accuracy)
    && typeof entry.time === 'number'
    && typeof entry.date === 'string'
    && typeof entry.style === 'string'
    && (entry.mode === undefined || entry.mode === 'story' || entry.mode === 'arcade')
}

export type BoardMode = 'story' | 'arcade'

const modeOf = (entry: LeaderboardEntry): BoardMode => entry.mode ?? 'story'

const rank = (entries: LeaderboardEntry[]) => [...entries].sort((a, b) => b.score - a.score).slice(0, LEADERBOARD_SIZE)

/** Each mode keeps its own top ten inside the one stored list. */
const trim = (entries: LeaderboardEntry[]) => [
  ...rank(entries.filter((entry) => modeOf(entry) === 'story')),
  ...rank(entries.filter((entry) => modeOf(entry) === 'arcade')),
]

/**
 * Never throws: storage can be disabled (private mode, blocked cookies),
 * missing, or hand-edited into garbage. Invalid rows are dropped, not trusted.
 */
const readAll = (): LeaderboardEntry[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    return []
  }
}

export const getLeaderboard = (mode: BoardMode = 'story'): LeaderboardEntry[] =>
  rank(readAll().filter((entry) => modeOf(entry) === mode))

export interface SaveResult {
  entries: LeaderboardEntry[]
  /** 1-based position, or null if the score did not make the top ten. */
  position: number | null
  /** False when the browser refused to persist (the table still updates for this session). */
  persisted: boolean
}

export const saveScore = (entry: LeaderboardEntry): SaveResult => {
  const all = trim([...readAll(), entry])
  const entries = rank(all.filter((item) => modeOf(item) === modeOf(entry)))
  const index = entries.findIndex((item) => item.id === entry.id)
  let persisted = true
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    persisted = false
  }
  return { entries, position: index === -1 ? null : index + 1, persisted }
}

/** Arcade-style callsign: exactly three letters, e.g. "NEO". */
export const normalizeCallsign = (raw: string) => raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, CALLSIGN_LENGTH)

export const formatEntryDate = (date: string) => {
  const parsed = Date.parse(date)
  // Older records stored a pre-formatted locale string; show those as-is.
  return Number.isNaN(parsed) ? date : new Date(parsed).toLocaleDateString()
}
