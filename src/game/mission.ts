import type { GameAction } from '../types/game'

export const MISSION: GameAction[] = [
  { gesture: 'RIGHT_HAND_UP', objective: 'SCAN ACCESS', hint: 'Raise your right hand above your shoulder.', scene: 'SECURITY NODE / 01' },
  { gesture: 'LEAN_LEFT', objective: 'DODGE LEFT', hint: 'Lean left before the laser reaches you.', scene: 'LASER GRID / 02' },
  { gesture: 'LEAN_RIGHT', objective: 'DODGE RIGHT', hint: 'Shift your torso to the right.', scene: 'LASER GRID / 03' },
  { gesture: 'SQUAT', objective: 'DUCK UNDER LASER', hint: 'Drop your hips and bend both knees.', scene: 'LOW BEAM / 04' },
  { gesture: 'BOTH_HANDS_FORWARD', objective: 'OPEN VAULT', hint: 'Hold both hands forward toward the camera.', scene: 'VAULT CORE / 05' },
]

export const MISSION_DURATION_MS = 90_000
