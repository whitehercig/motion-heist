import type { CalibrationBaseline, PoseFrame, TrackingMode } from './pose'

export type GestureId = 'RIGHT_HAND_UP' | 'FREEZE' | 'LEAN_LEFT' | 'LEAN_RIGHT' | 'SQUAT' | 'VAULT_BREACH'
export type Screen = 'landing' | 'calibrating' | 'briefing' | 'playing' | 'arcade' | 'duelSwap' | 'duelResult' | 'arcadeResults' | 'results' | 'leaderboard'
/** story = the 3-act heist; training = the same moves without timer or penalties; duel = two arcade runs on one seed. */
export type GameMode = 'story' | 'training' | 'arcade' | 'duel'

export interface GestureMetrics {
  trackingMode: TrackingMode
  confidence: number
  torso: number
  shoulderWidth: number
  handLift: number
  leanDegrees: number
  hipDrop: number
  /** Desk mode: downward travel of the 70/30 shoulder/nose level, in calibrated torso heights. */
  deskDrop: number
  leftKneeAngle: number
  rightKneeAngle: number
  /** FREEZE only: upper-body travel over the last 300 ms, in shoulder widths; undefined until the window fills. */
  motionEnergy?: number
  /** Present only while the DUCK UNDER LASER target is active. */
  laser?: LaserReading
  frame: PoseFrame
}

export interface LaserJointHit {
  /** null = the virtual head-and-chest collider used in desk mode. */
  index: number | null
  /** Mirrored normalized X, matching the mirrored preview. */
  x: number
  y: number
  breaching: boolean
}

/**
 * One frame of beam-vs-skeleton collision. All vertical values are normalized
 * image coordinates (0 = top), so the ratios are resolution independent.
 */
export interface LaserReading {
  mode: TrackingMode
  beamY: number
  /** Calibrated vertical shoulder-to-hip distance. */
  torsoHeight: number
  joints: LaserJointHit[]
  breached: boolean
  /** Highest visible critical joint: the one that must travel furthest. */
  worst: LaserJointHit
  /** beamY - worst.y; positive means the body is still above the beam. */
  delta: number
  deltaCm: number
  /** How far the worst joint has descended from its calibrated height, in torso fractions. */
  currentDrop: number
  /** How far it must descend to pass under the beam, in torso fractions. */
  targetDrop: number
}

export interface MovementError {
  title: string
  detail: string
  correction: string
  arrow: '↑' | '↓' | '←' | '→' | '↗' | '↖' | '↔'
  current: string
  target: string
  focus: number[]
}

export interface GestureSignal {
  gesture: GestureId
  progress: number
  confidence: number
  valid: boolean
  success: boolean
  attempting: boolean
  /** True while a new baseline is captured after a desk/full switch. */
  recalibrating?: boolean
  /** Two-phase vault state; present only while VAULT_BREACH is the target. */
  vault?: VaultReading
  error?: MovementError
  metrics?: GestureMetrics
}

/** Player-facing text (name, hint, scene) lives in the i18n table under `move.<gesture>.*`. */
export interface GameAction {
  gesture: GestureId
  /** Stable English label for telemetry and the jury audit JSON. */
  objective: string
  act: 1 | 2 | 3
}

export interface HeistStats {
  successfulActions: number
  mistakes: number
  corrections: number
  totalAccuracy: number
  correctionMs: number
  combo: number
}

export interface GameSession {
  playerName: string
  startedAt: number
  phaseStartedAt: number
  durationMs: number
  score: number
  phase: number
  stats: HeistStats
  baseline: CalibrationBaseline
}

export interface LeaderboardEntry {
  id: string
  nickname: string
  score: number
  accuracy: number
  time: number
  date: string
  style: string
  /** Missing on records saved before arcade mode existed: those are story runs. */
  mode?: 'story' | 'arcade'
}

export type PoseTemplateId = 'SCAN_ACCESS' | 'GUARD_FREEZE' | 'DODGE_LEFT' | 'DODGE_RIGHT' | 'DUCK_LASER' | 'OPEN_VAULT'

export type TemplateJoint =
  | 'nose'
  | 'leftShoulder' | 'rightShoulder'
  | 'leftElbow' | 'rightElbow'
  | 'leftWrist' | 'rightWrist'
  | 'leftHip' | 'rightHip'

/**
 * Template space: [-1, 1], origin at the chest centre, +x = the player's
 * right (= screen right in the mirrored preview), +y = down, -z = toward the camera.
 */
export interface TemplatePoint {
  x: number
  y: number
  z: number
}

export type BoneId = 'torso' | 'rightUpperArm' | 'rightForearm' | 'leftUpperArm' | 'leftForearm'

export interface BoneRule {
  weight: number
  /** Angular error at which this bone's similarity reaches 0. */
  toleranceDeg: number
}

export interface PoseTemplate {
  id: PoseTemplateId
  gesture: GestureId
  label: string
  joints: Record<TemplateJoint, TemplatePoint>
  bones: Record<BoneId, BoneRule>
  /** Whole-body downward shift from the calibrated stance, in torso heights. */
  anchorDrop: number
  /** Weight of the vertical-level term; direction vectors alone cannot see a translation like ducking. */
  levelWeight: number
  /** Which side of the ghost's head the SYNC gauge sits on (-1 left, 1 right), away from the moving limb. */
  gaugeSide: -1 | 1
}

export interface PoseMatch {
  /** 0..100 */
  score: number
  /** Per-bone similarity 0..1, null when the bone was not visible. */
  bones: Record<BoneId, number | null>
}

/**
 * align     -> hands moving onto the two chest-level palm scanners
 * locking   -> both palms on target, 400 ms charge running
 * breaching -> locked; wrist spread drives the doors open
 * breached  -> terminal success
 */
export type VaultPhase = 'align' | 'locking' | 'breaching' | 'breached'

export interface VaultTarget {
  /** Mirrored normalized centre. */
  x: number
  y: number
  engaged: boolean
  /** Wrist distance from the centre in radii (1 = on the edge); null if the wrist is not tracked. */
  offset: number | null
}

export interface VaultCursor {
  x: number
  y: number
  tracked: boolean
}

/**
 * Timestamps persist in the state (not one-frame events) so display-rate
 * consumers can never miss a transition between two pose frames.
 */
export interface VaultReading {
  phase: VaultPhase
  /** [screen-left scanner for the left palm, screen-right scanner for the right palm] */
  targets: [VaultTarget, VaultTarget]
  wrists: [VaultCursor, VaultCursor]
  /** Scanner radius as a fraction of frame width. */
  radius: number
  lockProgress: number
  breachProgress: number
  /** Wrist gap (normalized x) captured at lock. */
  initialDistance: number | null
  lockStartedAt: number | null
  lockedAt: number | null
  releasedAt: number | null
  /** breachProgress at the moment the player let go. */
  releasedProgress: number
  breachedAt: number | null
  /** Since when exactly one palm has been on its scanner (for the "palm off scanner" diagnosis). */
  onePalmSince: number | null
  timestamp: number
}
