import type { GestureId } from '../types/game'

export interface GestureThresholds {
  holdMs: number
  handLift?: number
  leanDegrees?: number
  hipDrop?: number
  /** Desk-mode replacement for hipDrop + knee angle. */
  deskDrop?: number
  kneeAngle?: number
  /** Vault: palm-scanner radius as a fraction of frame width. */
  palmRadius?: number
  /** Vault: wrist spread needed for a full breach, in shoulder widths. */
  breachSpan?: number
  breachComplete?: number
}

export const GESTURE_CONFIG: Record<GestureId, GestureThresholds> = {
  RIGHT_HAND_UP: { holdMs: 620, handLift: 0.42 },
  LEAN_LEFT: { holdMs: 560, leanDegrees: 15 },
  LEAN_RIGHT: { holdMs: 560, leanDegrees: 15 },
  SQUAT: { holdMs: 720, hipDrop: 0.17, deskDrop: 0.22, kneeAngle: 154 },
  // holdMs is the PALM LOCK charge; the breach itself is driven by arm spread, not by holding.
  VAULT_BREACH: { holdMs: 400, palmRadius: 0.12, breachSpan: 1.2, breachComplete: 0.95 },
}

export const TRACKING_CONFIG = {
  /** Rolling window of lower-body visibility samples (~1 s at 30 FPS). */
  windowSize: 30,
  landmarkVisibility: 0.5,
  /** Enter desk mode when legs were visible in fewer than 20% of the window... */
  deskBelowRatio: 0.2,
  /** ...and leave it once they are back in 30%. The gap stops boundary flicker. */
  fullAtRatio: 0.3,
  /** Desk collider: weighted shoulder-midpoint / nose level. */
  deskShoulderWeight: 0.7,
  deskNoseWeight: 0.3,
  /** Vertical shoulder-to-hip span ≈ this × shoulder width when hips are off-screen. */
  torsoPerShoulderWidth: 1.3,
  /** Stable frames needed to capture a fresh baseline after a mode switch. */
  rebaseSamples: 12,
  rebaseTolerance: 0.04,
} as const

export const GESTURE_LABELS: Record<GestureId, string> = {
  RIGHT_HAND_UP: 'SCAN ACCESS',
  LEAN_LEFT: 'DODGE LEFT',
  LEAN_RIGHT: 'DODGE RIGHT',
  SQUAT: 'DUCK UNDER LASER',
  VAULT_BREACH: 'OPEN VAULT',
}
