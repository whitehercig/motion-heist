import type { GameAction } from '../types/game'

export const MISSION: GameAction[] = [
  { gesture: 'RIGHT_HAND_UP', objective: 'SCAN ACCESS', hint: 'Raise your right hand above your shoulder.', scene: 'SECURITY NODE / 01' },
  { gesture: 'LEAN_LEFT', objective: 'DODGE LEFT', hint: 'Lean left before the laser reaches you.', scene: 'LASER GRID / 02' },
  { gesture: 'LEAN_RIGHT', objective: 'DODGE RIGHT', hint: 'Shift your torso to the right.', scene: 'LASER GRID / 03' },
  { gesture: 'SQUAT', objective: 'DUCK UNDER LASER', hint: 'Duck until your head and shoulders pass under the beam.', deskHint: 'Lean your head and chest down toward the desk, under the beam.', scene: 'LOW BEAM / 04' },
  { gesture: 'VAULT_BREACH', objective: 'OPEN VAULT', hint: 'Palms on both scanners, then pull the doors apart.', scene: 'VAULT CORE / 05' },
]

export const MISSION_DURATION_MS = 90_000

/**
 * The time limit never ends the run: the mission rolls into OVERTIME, where
 * movements score half, so a first-time player can always reach the vault.
 * Only an abandoned session (nobody finishing for 3 more minutes) is closed.
 */
export const OVERTIME_SCORE_FACTOR = 0.5
export const OVERTIME_LIMIT_MS = 180_000
