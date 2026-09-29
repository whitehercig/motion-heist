import type { GestureId } from './game'
import type { TrackingMode } from './pose'

export type MissionOutcome = 'breached' | 'timeout'

/** GHOST: clean run. CYBER: every anomaly was corrected. ROOKIE: something stayed unresolved. */
export type OperativeRank = 'GHOST INFILTRATOR' | 'CYBER OPERATIVE' | 'ROOKIE THIEF'

/** One diagnosis the error analyzer issued (each one cost a penalty). */
export interface AnomalyRecord {
  title: string
  detail: string
  correction: string
  current: string
  target: string
  /** Milliseconds since mission start. */
  detectedAtMs: number
}

export interface PhaseTelemetry {
  index: number
  gesture: GestureId
  objective: string
  /** Milliseconds since mission start. */
  startedAtMs: number
  /** Phase start -> first frame the engine registered an attempt. */
  reactionMs: number | null
  /** Phase start -> confirmed success. */
  durationMs: number | null
  completed: boolean
  /** Mean pose-template similarity (0..100) over the validated hold; peak similarity if no hold frames. */
  motionMatch: number | null
  peakMatch: number
  /** Mean landmark visibility (0..1) over the phase. */
  avgConfidence: number | null
  framesAnalyzed: number
  anomalies: AnomalyRecord[]
  /** First anomaly -> success. */
  recoveryMs: number | null
  recoveryBonus: number
  pointsEarned: number
}

export interface MissionTelemetry {
  incidentId: string
  operative: string
  /** ISO timestamp of mission start. */
  startedAt: string
  outcome: MissionOutcome
  missionMs: number
  /** Time spent past the mission limit (moves scored ×0.5), 0 if finished in time. */
  overtimeMs: number
  finalScore: number
  mistakes: number
  phases: PhaseTelemetry[]
  framesAnalyzed: number
  /** Mean landmark visibility (0..1) over every analyzed frame. */
  avgConfidence: number
  trackingModes: TrackingMode[]
}

export interface RecoveryEntry {
  objective: string
  /** The first diagnosis in the phase: what the player was told to fix. */
  anomaly: AnomalyRecord
  /** Further diagnoses in the same phase after the first. */
  followUps: AnomalyRecord[]
  recovered: boolean
  recoveryMs: number | null
  bonus: number
}

export interface DossierReport {
  telemetry: MissionTelemetry
  score: number
  /** 0..100, mean cosine-based pose similarity across completed movements. */
  motionAccuracy: number
  /** 0..100 */
  avgConfidence: number
  missionMs: number
  rank: OperativeRank
  movementsRecognized: number
  movementsTotal: number
  anomalies: number
  recovered: number
  recoveries: RecoveryEntry[]
}
