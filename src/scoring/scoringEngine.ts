import { clamp } from '../motion/geometry'
import type { GameAction, GestureSignal, HeistStats } from '../types/game'
import type { DossierReport, MissionOutcome, MissionTelemetry, OperativeRank, PhaseTelemetry, RecoveryEntry } from '../types/scoring'

export const createStats = (): HeistStats => ({
  successfulActions: 0,
  mistakes: 0,
  corrections: 0,
  totalAccuracy: 0,
  correctionMs: 0,
  combo: 0,
})

export const scoreSuccess = (currentScore: number, stats: HeistStats, signal: GestureSignal, phaseElapsedMs: number) => {
  const nextCombo = Math.min(5, stats.combo + 1)
  const reactionBonus = Math.max(0, Math.round((8000 - Math.min(8000, phaseElapsedMs)) / 40))
  const precisionBonus = Math.round(signal.confidence * 180 + signal.progress * 120)
  const earned = 850 + reactionBonus + precisionBonus + nextCombo * 100
  return {
    score: currentScore + earned,
    earned,
    stats: {
      ...stats,
      successfulActions: stats.successfulActions + 1,
      combo: nextCombo,
      totalAccuracy: stats.totalAccuracy + Math.round(signal.confidence * 100),
    },
  }
}

export const MISTAKE_PENALTY = 120

export const scoreMistake = (currentScore: number, stats: HeistStats) => ({
  score: Math.max(0, currentScore - MISTAKE_PENALTY),
  stats: { ...stats, mistakes: stats.mistakes + 1, combo: 0 },
})

export const RECOVERY_BONUS_MAX = 150
const RECOVERY_FAST_MS = 1500
const RECOVERY_SLOW_MS = 6000
const RECOVERY_BONUS_MIN = 30

/**
 * Reward for fixing a diagnosed error: full 150 within 1.5 s, sliding to 30
 * by 6 s, paid once per corrected phase. From phase 2 on, the 120-pt penalty
 * plus the lost combo outweigh it; only a very fast fix in phase 1 (combo
 * still 0) nets a small +30.
 */
export const recoveryBonus = (recoveryMs: number) => {
  const t = clamp((recoveryMs - RECOVERY_FAST_MS) / (RECOVERY_SLOW_MS - RECOVERY_FAST_MS))
  return Math.round(RECOVERY_BONUS_MAX - t * (RECOVERY_BONUS_MAX - RECOVERY_BONUS_MIN))
}

export const rankFor = (outcome: MissionOutcome, anomalies: number, unrecovered: number): OperativeRank => {
  if (outcome === 'breached' && anomalies === 0) return 'GHOST INFILTRATOR'
  if (outcome === 'breached' && unrecovered === 0) return 'CYBER OPERATIVE'
  return 'ROOKIE THIEF'
}

export const incidentIdFor = (startedAtEpoch: number) => `#${1000 + (Math.floor(startedAtEpoch / 1000) % 9000)}-MH`

/** "42.318s" */
export const formatMissionTime = (ms: number) => `${Math.floor(ms / 1000)}.${String(Math.round(ms % 1000)).padStart(3, '0')}s`

export const formatSeconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`)

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)

/** Unreached phases still appear in the report so the jury sees the full movement plan. */
const withUnreached = (phases: PhaseTelemetry[], mission: GameAction[]): PhaseTelemetry[] =>
  mission.map((action, index) => phases[index] ?? {
    index,
    gesture: action.gesture,
    objective: action.objective,
    startedAtMs: 0,
    reactionMs: null,
    durationMs: null,
    completed: false,
    motionMatch: null,
    peakMatch: 0,
    avgConfidence: null,
    framesAnalyzed: 0,
    anomalies: [],
    recoveryMs: null,
    recoveryBonus: 0,
    pointsEarned: 0,
  })

export const buildDossier = (telemetry: MissionTelemetry, mission: GameAction[]): DossierReport => {
  const phases = withUnreached(telemetry.phases, mission)
  const completed = phases.filter((phase) => phase.completed)
  const recoveries: RecoveryEntry[] = phases
    .filter((phase) => phase.anomalies.length > 0)
    .map((phase) => ({
      gesture: phase.gesture,
      objective: phase.objective,
      anomaly: phase.anomalies[0],
      followUps: phase.anomalies.slice(1),
      recovered: phase.completed,
      recoveryMs: phase.recoveryMs,
      bonus: phase.recoveryBonus,
    }))
  const anomalies = phases.reduce((sum, phase) => sum + phase.anomalies.length, 0)
  const unrecovered = recoveries.filter((entry) => !entry.recovered).length
  return {
    telemetry: { ...telemetry, phases },
    score: telemetry.finalScore,
    motionAccuracy: Math.round(mean(completed.flatMap((phase) => (phase.motionMatch === null ? [] : [phase.motionMatch])))),
    avgConfidence: Math.round(telemetry.avgConfidence * 100),
    missionMs: telemetry.missionMs,
    rank: rankFor(telemetry.outcome, anomalies, unrecovered),
    movementsRecognized: completed.length,
    movementsTotal: mission.length,
    anomalies,
    recovered: recoveries.length - unrecovered,
    recoveries,
  }
}

/** Structured, self-describing telemetry the jury can paste anywhere and verify line by line. */
export const buildAuditReport = (report: DossierReport, leaderboardEntries: number) => {
  const { telemetry } = report
  return {
    report: 'MOTION: HEIST — JURY AUDIT REPORT',
    incident: telemetry.incidentId,
    generatedAt: new Date().toISOString(),
    operative: telemetry.operative,
    outcome: telemetry.outcome === 'breached' ? 'VAULT COMPROMISED' : 'SESSION ABANDONED',
    criteria: {
      distinctMovements: {
        recognized: report.movementsRecognized,
        total: report.movementsTotal,
        minimumRequired: 3,
        passed: report.movementsRecognized >= 3,
        movements: telemetry.phases.map((phase) => ({ gesture: phase.gesture, objective: phase.objective, confirmed: phase.completed })),
      },
      errorMode: {
        anomaliesDetected: report.anomalies,
        phasesRecovered: report.recovered,
        log: report.recoveries.map((entry) => ({
          phase: entry.objective,
          anomaly: entry.anomaly.title,
          measured: entry.anomaly.current,
          target: entry.anomaly.target,
          instruction: entry.anomaly.correction,
          followUpDiagnoses: entry.followUps.map((followUp) => followUp.title),
          recovered: entry.recovered,
          recoveryMs: entry.recoveryMs === null ? null : Math.round(entry.recoveryMs),
          bonusPoints: entry.bonus,
        })),
      },
      leaderboard: { storage: 'localStorage', entries: leaderboardEntries, capacity: 10 },
    },
    metrics: {
      finalScore: report.score,
      motionAccuracyPct: report.motionAccuracy,
      avgCvConfidencePct: report.avgConfidence,
      missionTimeMs: Math.round(report.missionMs),
      overtimeMs: Math.round(telemetry.overtimeMs),
      rank: report.rank,
      mistakes: telemetry.mistakes,
      framesAnalyzed: telemetry.framesAnalyzed,
      trackingModes: telemetry.trackingModes,
    },
    phases: telemetry.phases.map((phase) => ({
      index: phase.index + 1,
      gesture: phase.gesture,
      confirmed: phase.completed,
      reactionMs: phase.reactionMs === null ? null : Math.round(phase.reactionMs),
      durationMs: phase.durationMs === null ? null : Math.round(phase.durationMs),
      motionMatchPct: phase.motionMatch,
      peakMatchPct: phase.peakMatch,
      avgConfidencePct: phase.avgConfidence === null ? null : Math.round(phase.avgConfidence * 100),
      framesAnalyzed: phase.framesAnalyzed,
      anomalies: phase.anomalies.length,
      pointsEarned: phase.pointsEarned,
      recoveryBonus: phase.recoveryBonus,
    })),
    method: {
      pose: 'MediaPipe Pose Landmarker (lite), 33 landmarks, in-browser',
      motionAccuracy: 'cosine similarity of 5 bone vectors (spine, upper arms, forearms) vs per-phase templates, rescaled over per-bone tolerance cones; mean over each validated hold',
      confidence: 'mean MediaPipe landmark visibility over the joints each tracking mode judges',
      recoveryBonus: `${RECOVERY_BONUS_MAX} pts within ${RECOVERY_FAST_MS / 1000}s of the first diagnosis, down to ${RECOVERY_BONUS_MIN} pts at ${RECOVERY_SLOW_MS / 1000}s`,
    },
  }
}
