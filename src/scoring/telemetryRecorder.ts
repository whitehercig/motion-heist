import { matchFrame } from '../motion/poseTemplates'
import { incidentIdFor } from './scoringEngine'
import type { TrackingMode } from '../types/pose'
import type { GameAction, GestureSignal, MovementError } from '../types/game'
import type { AnomalyRecord, MissionOutcome, MissionTelemetry, PhaseTelemetry } from '../types/scoring'

interface PhaseAccumulator {
  index: number
  action: GameAction
  startedAt: number
  firstAttemptAt: number | null
  completedAt: number | null
  holdMatchSum: number
  holdMatchCount: number
  peakMatch: number
  confidenceSum: number
  frames: number
  anomalies: AnomalyRecord[]
  firstAnomalyAt: number | null
  pointsEarned: number
  recoveryBonus: number
}

/**
 * Records what the dossier needs while the mission runs: per-phase reaction
 * time, pose similarity during the validated hold, model confidence, and each
 * diagnosis with its recovery. All times are performance.now() milliseconds.
 */
export class MissionRecorder {
  private startedAt = 0
  private limitMs = 0
  private startedEpoch = 0
  private operative = ''
  private phases: PhaseAccumulator[] = []
  private frames = 0
  private confidenceSum = 0
  private readonly modes = new Set<TrackingMode>()

  start(operative: string, now: number, limitMs: number) {
    this.startedAt = now
    this.limitMs = limitMs
    this.startedEpoch = Date.now()
    this.operative = operative
    this.phases = []
    this.frames = 0
    this.confidenceSum = 0
    this.modes.clear()
  }

  beginPhase(index: number, action: GameAction, now: number) {
    this.phases[index] = {
      index,
      action,
      startedAt: now,
      firstAttemptAt: null,
      completedAt: null,
      holdMatchSum: 0,
      holdMatchCount: 0,
      peakMatch: 0,
      confidenceSum: 0,
      frames: 0,
      anomalies: [],
      firstAnomalyAt: null,
      pointsEarned: 0,
      recoveryBonus: 0,
    }
  }

  private get current() {
    const phase = this.phases[this.phases.length - 1]
    return phase && phase.completedAt === null ? phase : null
  }

  recordFrame(signal: GestureSignal, now: number) {
    const phase = this.current
    const metrics = signal.metrics
    if (!phase || !metrics) return
    this.frames += 1
    this.confidenceSum += metrics.confidence
    this.modes.add(metrics.trackingMode)
    phase.frames += 1
    phase.confidenceSum += metrics.confidence
    if (signal.attempting && phase.firstAttemptAt === null) phase.firstAttemptAt = now

    const match = matchFrame(metrics.frame, phase.action.gesture, metrics.laser).score
    phase.peakMatch = Math.max(phase.peakMatch, match)
    // Accuracy is judged on the pose the player actually held for validation. The vault's
    // template is the palm-lock grip, so it is sampled during the lock charge, not the pull.
    const judged = signal.vault ? signal.vault.phase === 'locking' : signal.valid
    if (judged) {
      phase.holdMatchSum += match
      phase.holdMatchCount += 1
    }
  }

  recordAnomaly(error: MovementError, now: number) {
    const phase = this.current
    if (!phase) return
    phase.firstAnomalyAt ??= now
    phase.anomalies.push({
      title: error.title,
      detail: error.detail,
      correction: error.correction,
      current: error.current,
      target: error.target,
      detectedAtMs: now - this.startedAt,
    })
  }

  completePhase(now: number, pointsEarned: number, recoveryBonus: number) {
    const phase = this.current
    if (!phase) return
    phase.completedAt = now
    phase.pointsEarned = pointsEarned
    phase.recoveryBonus = recoveryBonus
  }

  finish(now: number, outcome: MissionOutcome, finalScore: number, mistakes: number): MissionTelemetry {
    const last = this.phases[this.phases.length - 1]
    // A breach ends the mission at the confirmed final movement, not after the outro animation.
    const endedAt = outcome === 'breached' && last?.completedAt != null ? last.completedAt : now
    return {
      incidentId: incidentIdFor(this.startedEpoch),
      operative: this.operative,
      startedAt: new Date(this.startedEpoch).toISOString(),
      outcome,
      missionMs: Math.max(0, endedAt - this.startedAt),
      overtimeMs: Math.max(0, endedAt - this.startedAt - this.limitMs),
      finalScore,
      mistakes,
      phases: this.phases.map((phase) => this.summarize(phase)),
      framesAnalyzed: this.frames,
      avgConfidence: this.frames ? this.confidenceSum / this.frames : 0,
      trackingModes: [...this.modes],
    }
  }

  private summarize(phase: PhaseAccumulator): PhaseTelemetry {
    const completed = phase.completedAt !== null
    return {
      index: phase.index,
      gesture: phase.action.gesture,
      objective: phase.action.objective,
      startedAtMs: phase.startedAt - this.startedAt,
      reactionMs: phase.firstAttemptAt === null ? null : phase.firstAttemptAt - phase.startedAt,
      durationMs: completed ? (phase.completedAt ?? phase.startedAt) - phase.startedAt : null,
      completed,
      motionMatch: phase.holdMatchCount
        ? Math.round(phase.holdMatchSum / phase.holdMatchCount)
        : phase.frames ? phase.peakMatch : null,
      peakMatch: phase.peakMatch,
      avgConfidence: phase.frames ? phase.confidenceSum / phase.frames : null,
      framesAnalyzed: phase.frames,
      anomalies: phase.anomalies,
      recoveryMs: completed && phase.firstAnomalyAt !== null ? (phase.completedAt ?? phase.firstAnomalyAt) - phase.firstAnomalyAt : null,
      recoveryBonus: phase.recoveryBonus,
      pointsEarned: phase.pointsEarned,
    }
  }
}
