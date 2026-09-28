import type { CalibrationBaseline, PoseFrame } from './pose'

export type GestureId = 'RIGHT_HAND_UP' | 'LEAN_LEFT' | 'LEAN_RIGHT' | 'SQUAT' | 'BOTH_HANDS_FORWARD'
export type Screen = 'landing' | 'calibrating' | 'briefing' | 'playing' | 'results' | 'leaderboard'

export interface GestureMetrics {
  confidence: number
  torso: number
  shoulderWidth: number
  handLift: number
  leanDegrees: number
  hipDrop: number
  leftKneeAngle: number
  rightKneeAngle: number
  leftForward: number
  rightForward: number
  handsSymmetry: number
  handsSpread: number
  frame: PoseFrame
}

export interface MovementError {
  title: string
  detail: string
  correction: string
  arrow: '↑' | '↓' | '←' | '→' | '↗' | '↖'
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
  error?: MovementError
  metrics?: GestureMetrics
}

export interface GameAction {
  gesture: GestureId
  objective: string
  hint: string
  scene: string
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
}
