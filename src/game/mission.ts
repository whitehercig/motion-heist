import type { GameAction } from '../types/game'

/**
 * Three acts: get past the guard, cross the laser corridor, crack the vault.
 * Names, hints and scenes are looked up in the i18n table by gesture.
 */
export const MISSION: GameAction[] = [
  { gesture: 'RIGHT_HAND_UP', objective: 'SCAN ACCESS', act: 1 },
  { gesture: 'FREEZE', objective: 'GUARD PATROL', act: 1 },
  { gesture: 'LEAN_LEFT', objective: 'DODGE LEFT', act: 2 },
  { gesture: 'LEAN_RIGHT', objective: 'DODGE RIGHT', act: 2 },
  { gesture: 'SQUAT', objective: 'DUCK UNDER LASER', act: 2 },
  { gesture: 'VAULT_BREACH', objective: 'OPEN VAULT', act: 3 },
]

export const MISSION_DURATION_MS = 90_000
export const DEMO_DURATION_MS = 60_000

/**
 * The time limit never ends the run: the mission rolls into OVERTIME, where
 * movements score half, so a first-time player can always reach the vault.
 * Only an abandoned session (nobody finishing for 3 more minutes) is closed.
 */
export const OVERTIME_SCORE_FACTOR = 0.5
export const OVERTIME_LIMIT_MS = 180_000
