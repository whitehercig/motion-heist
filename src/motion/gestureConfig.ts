import type { GestureId } from '../types/game'

export interface GestureThresholds {
  holdMs: number
  handLift?: number
  leanDegrees?: number
  hipDrop?: number
  kneeAngle?: number
  handsForward?: number
  handsSymmetry?: number
  handsSpread?: [number, number]
}

export const GESTURE_CONFIG: Record<GestureId, GestureThresholds> = {
  RIGHT_HAND_UP: { holdMs: 620, handLift: 0.42 },
  LEAN_LEFT: { holdMs: 560, leanDegrees: 15 },
  LEAN_RIGHT: { holdMs: 560, leanDegrees: 15 },
  SQUAT: { holdMs: 720, hipDrop: 0.17, kneeAngle: 154 },
  BOTH_HANDS_FORWARD: {
    holdMs: 800,
    handsForward: 0.095,
    handsSymmetry: 0.55,
    handsSpread: [0.55, 2.35],
  },
}

export const GESTURE_LABELS: Record<GestureId, string> = {
  RIGHT_HAND_UP: 'SCAN ACCESS',
  LEAN_LEFT: 'DODGE LEFT',
  LEAN_RIGHT: 'DODGE RIGHT',
  SQUAT: 'DUCK UNDER LASER',
  BOTH_HANDS_FORWARD: 'OPEN VAULT',
}
