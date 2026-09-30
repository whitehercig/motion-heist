import { analyzeMovementError, analyzeVaultError } from '../errors/errorAnalyzer'
import { evaluateLaser } from '../laser/laserCollision'
import { GESTURE_CONFIG, TRACKING_CONFIG } from './gestureConfig'
import { angleAt, clamp, distance, midpoint, mirroredPoint, visible } from './geometry'
import { MotionEnergyMeter } from './motionEnergy'
import { deskLevel } from './trackingMode'
import { VaultBreach } from './vaultBreach'
import { PoseIndex, type CalibrationBaseline, type Landmark, type PoseFrame } from '../types/pose'
import type { GestureId, GestureMetrics, GestureSignal } from '../types/game'

const requiredPoints = (frame: PoseFrame) => {
  const i = PoseIndex
  return {
    leftShoulder: mirroredPoint(frame, i.LEFT_SHOULDER),
    rightShoulder: mirroredPoint(frame, i.RIGHT_SHOULDER),
    leftWrist: mirroredPoint(frame, i.LEFT_WRIST),
    rightWrist: mirroredPoint(frame, i.RIGHT_WRIST),
    leftHip: mirroredPoint(frame, i.LEFT_HIP),
    rightHip: mirroredPoint(frame, i.RIGHT_HIP),
    leftKnee: mirroredPoint(frame, i.LEFT_KNEE),
    rightKnee: mirroredPoint(frame, i.RIGHT_KNEE),
    leftAnkle: mirroredPoint(frame, i.LEFT_ANKLE),
    rightAnkle: mirroredPoint(frame, i.RIGHT_ANKLE),
  }
}

const poseSize = (leftShoulder: Landmark, rightShoulder: Landmark, leftHip: Landmark, rightHip: Landmark) => {
  const shoulders = midpoint(leftShoulder, rightShoulder)
  const hips = midpoint(leftHip, rightHip)
  return { shoulders, hips, shoulderWidth: distance(leftShoulder, rightShoulder), torso: distance(shoulders, hips) }
}

/**
 * Seated at a laptop the hips are off-screen and MediaPipe extrapolates them.
 * Trust that guess only when it agrees with the shoulder-width body scale.
 */
const deskTorsoHeight = (frame: PoseFrame, shouldersY: number, hipsY: number, shoulderWidth: number) => {
  const estimate = shoulderWidth * (frame.aspect ?? 16 / 9) * TRACKING_CONFIG.torsoPerShoulderWidth
  const measured = hipsY - shouldersY
  return measured > estimate * 0.6 && measured < estimate * 1.6 ? measured : estimate
}

/** Desk mode judges only what a laptop camera can see: shoulders and head. */
const upperBodyConfidence = (frame: PoseFrame, leftShoulder: Landmark, rightShoulder: Landmark) =>
  visible(leftShoulder, rightShoulder, frame.landmarks[PoseIndex.NOSE] ?? { x: 0, y: 0, z: 0, visibility: 0 })

export const canCalibrate = (frame: PoseFrame) => {
  if (frame.landmarks.length < 29) return false
  const p = requiredPoints(frame)
  const { shoulderWidth, torso } = poseSize(p.leftShoulder, p.rightShoulder, p.leftHip, p.rightHip)
  if (frame.trackingMode === 'desk') return upperBodyConfidence(frame, p.leftShoulder, p.rightShoulder) >= 0.6 && shoulderWidth > 0.11
  const confidence = visible(...Object.values(p))
  return confidence >= 0.55 && shoulderWidth > 0.11 && torso > 0.15
}

export const calibrationFrom = (frame: PoseFrame): CalibrationBaseline | null => {
  if (!canCalibrate(frame)) return null
  const p = requiredPoints(frame)
  const { shoulders, hips, shoulderWidth, torso } = poseSize(p.leftShoulder, p.rightShoulder, p.leftHip, p.rightHip)
  const noseY = frame.landmarks[PoseIndex.NOSE]?.y ?? shoulders.y - torso * 0.4
  if (frame.trackingMode === 'desk') {
    const torsoHeight = deskTorsoHeight(frame, shoulders.y, hips.y, shoulderWidth)
    return { mode: 'desk', hipY: shoulders.y + torsoHeight, shoulderY: shoulders.y, shoulderX: shoulders.x, noseY, shoulderWidth, torso: torsoHeight, capturedAt: frame.timestamp }
  }
  return { mode: 'full', hipY: hips.y, shoulderY: shoulders.y, shoulderX: shoulders.x, noseY, shoulderWidth, torso, capturedAt: frame.timestamp }
}

export const extractMetrics = (frame: PoseFrame, baseline: CalibrationBaseline, withLaser = false): GestureMetrics | null => {
  if (frame.landmarks.length < 29) return null
  const trackingMode = frame.trackingMode ?? 'full'
  const desk = trackingMode === 'desk'
  const p = requiredPoints(frame)
  const size = poseSize(p.leftShoulder, p.rightShoulder, p.leftHip, p.rightHip)
  const { shoulders, hips, shoulderWidth } = size
  const torso = desk ? deskTorsoHeight(frame, shoulders.y, hips.y, shoulderWidth) : size.torso
  if (shoulderWidth < 0.06 || torso < 0.09) return null

  const rightHandLift = (p.rightShoulder.y - p.rightWrist.y) / torso
  // Normalized x and y have different scales (x / width, y / height); convert to true pixel
  // geometry so 15 degrees means 15 degrees on any aspect ratio, matching the pose templates.
  // At a desk the hips are off-screen and MediaPipe's guess drifts with the shoulders, which
  // would hide the lean. Pivot instead on a virtual hip fixed under the calibrated shoulders.
  const pivot = desk ? { x: baseline.shoulderX, y: baseline.hipY } : hips
  const leanDegrees = Math.atan2((shoulders.x - pivot.x) * (frame.aspect ?? 16 / 9), pivot.y - shoulders.y) * (180 / Math.PI)
  const hipDrop = (hips.y - baseline.hipY) / Math.max(baseline.torso, torso)
  const nose = frame.landmarks[PoseIndex.NOSE]
  const deskDrop = nose
    ? (deskLevel(shoulders.y, nose.y) - deskLevel(baseline.shoulderY, baseline.noseY)) / (baseline.hipY - baseline.shoulderY)
    : 0
  const leftKneeAngle = angleAt(p.leftHip, p.leftKnee, p.leftAnkle)
  const rightKneeAngle = angleAt(p.rightHip, p.rightKnee, p.rightAnkle)

  // Knees and ankles are guaranteed to be missing at a desk; they must not veto every action.
  const confidence = desk ? upperBodyConfidence(frame, p.leftShoulder, p.rightShoulder) : visible(...Object.values(p))

  return {
    trackingMode,
    confidence,
    torso,
    shoulderWidth,
    handLift: rightHandLift,
    leanDegrees,
    hipDrop,
    deskDrop,
    leftKneeAngle,
    rightKneeAngle,
    laser: withLaser ? evaluateLaser(frame, baseline) ?? undefined : undefined,
    frame,
  }
}

const movementEffort = (gesture: GestureId, metrics: GestureMetrics) => {
  const config = GESTURE_CONFIG[gesture]
  switch (gesture) {
    case 'RIGHT_HAND_UP':
      return clamp(metrics.handLift / (config.handLift ?? 1))
    case 'FREEZE':
      return metrics.motionEnergy === undefined ? 0 : clamp(1 - metrics.motionEnergy / (config.motionEnergy ?? 1))
    case 'LEAN_LEFT':
      return clamp((-metrics.leanDegrees) / (config.leanDegrees ?? 1))
    case 'LEAN_RIGHT':
      return clamp(metrics.leanDegrees / (config.leanDegrees ?? 1))
    case 'SQUAT':
      if (metrics.laser) return metrics.laser.targetDrop > 0 ? clamp(metrics.laser.currentDrop / metrics.laser.targetDrop) : 1
      if (metrics.trackingMode === 'desk') return clamp(metrics.deskDrop / (config.deskDrop ?? 1))
      return clamp(metrics.hipDrop / (config.hipDrop ?? 1))
    case 'VAULT_BREACH':
      return 0 // driven by VaultBreach
  }
}

const isValid = (gesture: GestureId, metrics: GestureMetrics) => {
  const config = GESTURE_CONFIG[gesture]
  if (metrics.confidence < 0.55) return false
  switch (gesture) {
    case 'RIGHT_HAND_UP':
      return metrics.handLift >= (config.handLift ?? Infinity)
    case 'FREEZE':
      return metrics.motionEnergy !== undefined && metrics.motionEnergy <= (config.motionEnergy ?? 0)
    case 'LEAN_LEFT':
      return metrics.leanDegrees <= -(config.leanDegrees ?? Infinity)
    case 'LEAN_RIGHT':
      return metrics.leanDegrees >= (config.leanDegrees ?? Infinity)
    case 'SQUAT':
      // The physical beam replaces the abstract squat check whenever it can be evaluated.
      if (metrics.laser) return !metrics.laser.breached
      if (metrics.trackingMode === 'desk') return metrics.deskDrop >= (config.deskDrop ?? Infinity)
      return metrics.hipDrop >= (config.hipDrop ?? Infinity)
        && (metrics.leftKneeAngle <= (config.kneeAngle ?? 0) || metrics.rightKneeAngle <= (config.kneeAngle ?? 0))
    case 'VAULT_BREACH':
      return false // driven by VaultBreach
  }
}

/** An attempt must last this long before it can be diagnosed... */
const DIAGNOSE_AFTER_MS = 480
/** ...and must have stopped improving: less than this much progress over the stall window. */
const STALL_WINDOW_MS = 400
const STALL_PROGRESS = 0.04
/** A lean this far the wrong way is an attempt too (mirror confusion), so it can be diagnosed. */
const WRONG_WAY_LEAN_DEGREES = 6
/**
 * FREEZE has no "effort" to stall on: moving at all is the mistake. The player
 * gets this long to settle after the previous move before the guard calls it.
 */
const FREEZE_DIAGNOSE_MS = 1100
const FREEZE_SETTLED_MS = 500

/**
 * A per-target temporal state machine. MediaPipe provides points only; this
 * engine owns normalization, thresholds, hold validation and cooldown.
 */
export class GestureEngine {
  private activeSince: number | null = null
  private attemptSince: number | null = null
  private effortHistory: Array<{ time: number; effort: number }> = []
  private cooldownUntil = 0
  private target: GestureId | null = null
  private readonly vault = new VaultBreach()
  private readonly motion = new MotionEnergyMeter()
  private vaultReported = false

  setTarget(target: GestureId | null) {
    if (target !== this.target) this.reset(target)
  }

  reset(target: GestureId | null = null) {
    this.target = target
    this.activeSince = null
    this.attemptSince = null
    this.effortHistory = []
    this.cooldownUntil = 0
    this.vault.reset()
    this.motion.reset()
    this.vaultReported = false
  }

  update(target: GestureId, frame: PoseFrame | null, baseline: CalibrationBaseline): GestureSignal {
    this.setTarget(target)
    if (!frame) {
      return { gesture: target, progress: 0, confidence: 0, valid: false, success: false, attempting: false }
    }
    const metrics = extractMetrics(frame, baseline, target === 'SQUAT')
    if (!metrics || metrics.confidence < 0.45) {
      this.activeSince = null
      return { gesture: target, progress: 0, confidence: metrics?.confidence ?? 0, valid: false, success: false, attempting: false, metrics: metrics ?? undefined }
    }

    const now = frame.timestamp
    if (target === 'VAULT_BREACH') return this.updateVault(metrics, now)
    if (target === 'FREEZE') metrics.motionEnergy = this.motion.update(frame, metrics.shoulderWidth)
    const valid = isValid(target, metrics)
    const effort = movementEffort(target, metrics)
    const config = GESTURE_CONFIG[target]

    if (valid) {
      if (this.activeSince === null) this.activeSince = now
      // The still instant at the turn of a wave is not settling down: FREEZE keeps its diagnosis clock until the hold is real.
      if (target !== 'FREEZE' || now - this.activeSince > FREEZE_SETTLED_MS) this.attemptSince = null
      const progress = clamp((now - this.activeSince) / config.holdMs)
      const success = progress >= 1 && now >= this.cooldownUntil
      if (success) {
        this.cooldownUntil = now + 850
        this.activeSince = null
      }
      return { gesture: target, progress, confidence: metrics.confidence, valid: true, success, attempting: true, metrics }
    }

    this.activeSince = null
    if (target === 'FREEZE') return this.updateFreezeMiss(metrics, now)
    const wrongWay = (target === 'LEAN_LEFT' && metrics.leanDegrees >= WRONG_WAY_LEAN_DEGREES)
      || (target === 'LEAN_RIGHT' && metrics.leanDegrees <= -WRONG_WAY_LEAN_DEGREES)
    const attempting = effort >= 0.14 || wrongWay
    if (attempting) {
      if (this.attemptSince === null) this.attemptSince = now
    } else {
      this.attemptSince = null
    }
    // Diagnose a stall, not a transition: a player still sinking into a squat is moving
    // correctly and must not be penalized just because 480 ms have passed.
    const stalled = this.recordEffort(now, attempting ? effort : null)
    const error = attempting && stalled && this.attemptSince !== null && now - this.attemptSince > DIAGNOSE_AFTER_MS
      ? analyzeMovementError(target, metrics)
      : undefined
    return { gesture: target, progress: effort * 0.55, confidence: metrics.confidence, valid: false, success: false, attempting, error, metrics }
  }

  /** Moving under the searchlight resets the hold; still moving after the grace period is diagnosed. */
  private updateFreezeMiss(metrics: GestureMetrics, now: number): GestureSignal {
    const measured = metrics.motionEnergy !== undefined
    if (measured) this.attemptSince ??= now
    const error = measured && this.attemptSince !== null && now - this.attemptSince > FREEZE_DIAGNOSE_MS
      ? analyzeMovementError('FREEZE', metrics)
      : undefined
    return { gesture: 'FREEZE', progress: 0, confidence: metrics.confidence, valid: false, success: false, attempting: measured, error, metrics }
  }

  /** True when effort rose by less than STALL_PROGRESS over the last STALL_WINDOW_MS. */
  private recordEffort(now: number, effort: number | null) {
    if (effort === null) {
      this.effortHistory = []
      return false
    }
    this.effortHistory.push({ time: now, effort })
    while (this.effortHistory.length > 1 && now - this.effortHistory[1].time >= STALL_WINDOW_MS) this.effortHistory.shift()
    const oldest = this.effortHistory[0]
    if (now - oldest.time < STALL_WINDOW_MS) return false
    return effort - oldest.effort < STALL_PROGRESS
  }

  /** The finale is a two-phase physical action, not a hold: PALM LOCK, then KINETIC BREACH. */
  private updateVault(metrics: GestureMetrics, now: number): GestureSignal {
    const vault = this.vault.update(metrics.frame, metrics, now)
    const success = vault.phase === 'breached' && !this.vaultReported
    if (success) this.vaultReported = true
    const locked = vault.phase === 'breaching' || vault.phase === 'breached'
    return {
      gesture: 'VAULT_BREACH',
      // Lock is the first 30% of the meter, the breach the remaining 70%.
      progress: locked ? 0.3 + 0.7 * vault.breachProgress : 0.3 * vault.lockProgress,
      confidence: metrics.confidence,
      valid: vault.phase !== 'align',
      success,
      attempting: vault.phase !== 'align' || vault.onePalmSince !== null,
      error: analyzeVaultError(vault, now),
      metrics,
      vault,
    }
  }
}
