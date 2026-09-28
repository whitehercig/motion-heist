import { analyzeMovementError } from '../errors/errorAnalyzer'
import { GESTURE_CONFIG } from './gestureConfig'
import { angleAt, average, clamp, distance, midpoint, mirroredPoint, visible } from './geometry'
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

export const canCalibrate = (frame: PoseFrame) => {
  if (frame.landmarks.length < 29) return false
  const p = requiredPoints(frame)
  const { shoulderWidth, torso } = poseSize(p.leftShoulder, p.rightShoulder, p.leftHip, p.rightHip)
  const confidence = visible(...Object.values(p))
  return confidence >= 0.55 && shoulderWidth > 0.11 && torso > 0.15
}

export const calibrationFrom = (frame: PoseFrame): CalibrationBaseline | null => {
  if (!canCalibrate(frame)) return null
  const p = requiredPoints(frame)
  const { hips, shoulderWidth, torso } = poseSize(p.leftShoulder, p.rightShoulder, p.leftHip, p.rightHip)
  return { hipY: hips.y, shoulderWidth, torso, capturedAt: frame.timestamp }
}

export const extractMetrics = (frame: PoseFrame, baseline: CalibrationBaseline): GestureMetrics | null => {
  if (frame.landmarks.length < 29) return null
  const p = requiredPoints(frame)
  const { shoulders, hips, shoulderWidth, torso } = poseSize(p.leftShoulder, p.rightShoulder, p.leftHip, p.rightHip)
  if (shoulderWidth < 0.06 || torso < 0.09) return null

  const rightHandLift = (p.rightShoulder.y - p.rightWrist.y) / torso
  const leanDegrees = Math.atan2(shoulders.x - hips.x, hips.y - shoulders.y) * (180 / Math.PI)
  const hipDrop = (hips.y - baseline.hipY) / Math.max(baseline.torso, torso)
  const leftKneeAngle = angleAt(p.leftHip, p.leftKnee, p.leftAnkle)
  const rightKneeAngle = angleAt(p.rightHip, p.rightKnee, p.rightAnkle)

  // z is relative camera depth. We normalize it by shoulder width so users at
  // different distances can activate the vault with the same forward motion.
  const world = frame.worldLandmarks?.length ? frame.worldLandmarks : frame.landmarks
  const depth = (index: number) => world[index]?.z ?? frame.landmarks[index].z
  const shoulderZ = average([depth(PoseIndex.LEFT_SHOULDER), depth(PoseIndex.RIGHT_SHOULDER)])
  const leftForward = (shoulderZ - depth(PoseIndex.LEFT_WRIST)) / Math.max(shoulderWidth, 0.08)
  const rightForward = (shoulderZ - depth(PoseIndex.RIGHT_WRIST)) / Math.max(shoulderWidth, 0.08)
  const handsSymmetry = Math.abs(p.leftWrist.y - p.rightWrist.y) / torso
  const handsSpread = distance(p.leftWrist, p.rightWrist) / shoulderWidth
  const confidence = visible(...Object.values(p))

  return {
    confidence,
    torso,
    shoulderWidth,
    handLift: rightHandLift,
    leanDegrees,
    hipDrop,
    leftKneeAngle,
    rightKneeAngle,
    leftForward,
    rightForward,
    handsSymmetry,
    handsSpread,
    frame,
  }
}

const movementEffort = (gesture: GestureId, metrics: GestureMetrics) => {
  const config = GESTURE_CONFIG[gesture]
  switch (gesture) {
    case 'RIGHT_HAND_UP':
      return clamp(metrics.handLift / (config.handLift ?? 1))
    case 'LEAN_LEFT':
      return clamp((-metrics.leanDegrees) / (config.leanDegrees ?? 1))
    case 'LEAN_RIGHT':
      return clamp(metrics.leanDegrees / (config.leanDegrees ?? 1))
    case 'SQUAT':
      return clamp(metrics.hipDrop / (config.hipDrop ?? 1))
    case 'BOTH_HANDS_FORWARD':
      return clamp(Math.min(metrics.leftForward, metrics.rightForward) / (config.handsForward ?? 1))
  }
}

const isValid = (gesture: GestureId, metrics: GestureMetrics) => {
  const config = GESTURE_CONFIG[gesture]
  if (metrics.confidence < 0.55) return false
  switch (gesture) {
    case 'RIGHT_HAND_UP':
      return metrics.handLift >= (config.handLift ?? Infinity)
    case 'LEAN_LEFT':
      return metrics.leanDegrees <= -(config.leanDegrees ?? Infinity)
    case 'LEAN_RIGHT':
      return metrics.leanDegrees >= (config.leanDegrees ?? Infinity)
    case 'SQUAT':
      return metrics.hipDrop >= (config.hipDrop ?? Infinity)
        && metrics.leftKneeAngle <= (config.kneeAngle ?? 0)
        && metrics.rightKneeAngle <= (config.kneeAngle ?? 0)
    case 'BOTH_HANDS_FORWARD': {
      const [minSpread, maxSpread] = config.handsSpread ?? [0, Infinity]
      return Math.min(metrics.leftForward, metrics.rightForward) >= (config.handsForward ?? Infinity)
        && metrics.handsSymmetry <= (config.handsSymmetry ?? 0)
        && metrics.handsSpread >= minSpread
        && metrics.handsSpread <= maxSpread
    }
  }
}

/**
 * A per-target temporal state machine. MediaPipe provides points only; this
 * engine owns normalization, thresholds, hold validation and cooldown.
 */
export class GestureEngine {
  private activeSince: number | null = null
  private attemptSince: number | null = null
  private cooldownUntil = 0
  private target: GestureId | null = null

  setTarget(target: GestureId | null) {
    if (target !== this.target) this.reset(target)
  }

  reset(target: GestureId | null = null) {
    this.target = target
    this.activeSince = null
    this.attemptSince = null
    this.cooldownUntil = 0
  }

  update(target: GestureId, frame: PoseFrame | null, baseline: CalibrationBaseline): GestureSignal {
    this.setTarget(target)
    if (!frame) {
      return { gesture: target, progress: 0, confidence: 0, valid: false, success: false, attempting: false }
    }
    const metrics = extractMetrics(frame, baseline)
    if (!metrics || metrics.confidence < 0.45) {
      this.activeSince = null
      return { gesture: target, progress: 0, confidence: metrics?.confidence ?? 0, valid: false, success: false, attempting: false, metrics: metrics ?? undefined }
    }

    const now = frame.timestamp
    const valid = isValid(target, metrics)
    const effort = movementEffort(target, metrics)
    const config = GESTURE_CONFIG[target]

    if (valid) {
      this.attemptSince = null
      if (this.activeSince === null) this.activeSince = now
      const progress = clamp((now - this.activeSince) / config.holdMs)
      const success = progress >= 1 && now >= this.cooldownUntil
      if (success) {
        this.cooldownUntil = now + 850
        this.activeSince = null
      }
      return { gesture: target, progress, confidence: metrics.confidence, valid: true, success, attempting: true, metrics }
    }

    this.activeSince = null
    const attempting = effort >= 0.14 || (target === 'BOTH_HANDS_FORWARD' && Math.max(metrics.leftForward, metrics.rightForward) > 0.035)
    if (attempting) {
      if (this.attemptSince === null) this.attemptSince = now
    } else {
      this.attemptSince = null
    }
    const error = attempting && this.attemptSince !== null && now - this.attemptSince > 480
      ? analyzeMovementError(target, metrics)
      : undefined
    return { gesture: target, progress: effort * 0.55, confidence: metrics.confidence, valid: false, success: false, attempting, error, metrics }
  }
}
