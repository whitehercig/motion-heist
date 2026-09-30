import { GESTURE_CONFIG } from '../motion/gestureConfig'
import { midpoint, mirroredPoint } from '../motion/geometry'
import { deskLevel } from '../motion/trackingMode'
import { LASER_CRITICAL_JOINTS, PoseIndex, type CalibrationBaseline, type Landmark, type PoseFrame } from '../types/pose'
import type { LaserJointHit, LaserReading } from '../types/game'

export const LASER_CONFIG = {
  /** Y_laser = calibratedShoulderY + torsoHeight * beamTorsoRatio */
  beamTorsoRatio: 0.25,
  /** Approximate real shoulder-to-hip length used to turn ratios into centimetres. */
  torsoCm: 50,
  minVisibility: 0.35,
} as const

const calibratedY = (index: number, baseline: CalibrationBaseline) => {
  if (index === PoseIndex.NOSE) return baseline.noseY
  if (index === PoseIndex.LEFT_SHOULDER || index === PoseIndex.RIGHT_SHOULDER) return baseline.shoulderY
  return baseline.hipY
}

const tracked = (point: Landmark) => (point.visibility ?? 1) >= LASER_CONFIG.minVisibility

export const laserBeamY = (baseline: CalibrationBaseline) =>
  baseline.shoulderY + (baseline.hipY - baseline.shoulderY) * LASER_CONFIG.beamTorsoRatio

/** Beam height for the baseline's tracking mode: chest level standing, the desk-drop target seated. */
export const beamYFor = (baseline: CalibrationBaseline) => baseline.mode === 'desk'
  ? deskLevel(baseline.shoulderY, baseline.noseY) + (baseline.hipY - baseline.shoulderY) * (GESTURE_CONFIG.SQUAT.deskDrop ?? 0)
  : laserBeamY(baseline)

const toCm =(delta: number, torsoHeight: number) => Math.round((delta / torsoHeight) * LASER_CONFIG.torsoCm)

/** Full body: every visible critical joint must pass under the beam. */
const evaluateFullBody = (frame: PoseFrame, baseline: CalibrationBaseline, torsoHeight: number): LaserReading | null => {
  const beamY = laserBeamY(baseline)
  const joints: LaserJointHit[] = []
  let worst: (LaserJointHit & { index: number }) | null = null
  for (const index of LASER_CRITICAL_JOINTS) {
    if (!frame.landmarks[index]) continue
    const point = mirroredPoint(frame, index)
    if (!tracked(point)) continue
    const joint = { index, x: point.x, y: point.y, breaching: point.y < beamY }
    joints.push(joint)
    if (!worst || joint.y < worst.y) worst = joint
  }
  const shouldersTracked = joints.some((joint) => joint.index === PoseIndex.LEFT_SHOULDER)
    && joints.some((joint) => joint.index === PoseIndex.RIGHT_SHOULDER)
  if (!shouldersTracked || !worst) return null

  const delta = beamY - worst.y
  const origin = calibratedY(worst.index, baseline)
  return {
    mode: 'full',
    beamY,
    torsoHeight,
    joints,
    breached: delta > 0,
    worst,
    delta,
    deltaCm: toCm(delta, torsoHeight),
    currentDrop: Math.max(0, (worst.y - origin) / torsoHeight),
    targetDrop: Math.max(0, (beamY - origin) / torsoHeight),
  }
}

/**
 * Desk mode: a seated player cannot get whole joints under a chest-height
 * beam, so a virtual head-and-chest collider (70% shoulders + 30% nose) must
 * sink below a beam placed exactly at the desk drop target.
 */
const evaluateDesk = (frame: PoseFrame, baseline: CalibrationBaseline, torsoHeight: number): LaserReading | null => {
  const leftShoulder = mirroredPoint(frame, PoseIndex.LEFT_SHOULDER)
  const rightShoulder = mirroredPoint(frame, PoseIndex.RIGHT_SHOULDER)
  if (!tracked(leftShoulder) || !tracked(rightShoulder) || !frame.landmarks[PoseIndex.NOSE]) return null
  const shoulders = midpoint(leftShoulder, rightShoulder)
  const nose = mirroredPoint(frame, PoseIndex.NOSE)

  const targetDrop = GESTURE_CONFIG.SQUAT.deskDrop ?? 0
  const calibratedLevel = deskLevel(baseline.shoulderY, baseline.noseY)
  const beamY = calibratedLevel + torsoHeight * targetDrop
  const level = deskLevel(shoulders.y, nose.y)
  // Same 70/30 blend horizontally, so the collider sits between chin and sternum.
  const collider: LaserJointHit = { index: null, x: deskLevel(shoulders.x, nose.x), y: level, breaching: level < beamY }
  const delta = beamY - level
  return {
    mode: 'desk',
    beamY,
    torsoHeight,
    joints: [collider],
    breached: collider.breaching,
    worst: collider,
    delta,
    deltaCm: toCm(delta, torsoHeight),
    currentDrop: Math.max(0, (level - calibratedLevel) / torsoHeight),
    targetDrop,
  }
}

/**
 * Beam-vs-skeleton collision (y < beamY breaches, canvas convention). Returns
 * null when the upper body is not tracked well enough to judge.
 */
export const evaluateLaser = (frame: PoseFrame, baseline: CalibrationBaseline): LaserReading | null => {
  const torsoHeight = baseline.hipY - baseline.shoulderY
  if (torsoHeight <= 0.01) return null
  return (frame.trackingMode ?? baseline.mode) === 'desk'
    ? evaluateDesk(frame, baseline, torsoHeight)
    : evaluateFullBody(frame, baseline, torsoHeight)
}
