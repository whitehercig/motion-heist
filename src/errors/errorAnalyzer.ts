import { GESTURE_CONFIG } from '../motion/gestureConfig'
import { PoseIndex } from '../types/pose'
import type { GestureId, GestureMetrics, MovementError } from '../types/game'

const degree = (value: number) => `${Math.abs(Math.round(value))}°`

export const analyzeMovementError = (gesture: GestureId, metrics: GestureMetrics): MovementError => {
  const config = GESTURE_CONFIG[gesture]

  if (gesture === 'RIGHT_HAND_UP') {
    return {
      title: 'RIGHT HAND TOO LOW',
      detail: `Your hand is ${Math.round(metrics.handLift * 100)}% of the required lift.`,
      correction: 'Raise your right hand above your shoulder.',
      arrow: '↑',
      current: `${Math.round(metrics.handLift * 100)}% LIFT`,
      target: `${Math.round((config.handLift ?? 0) * 100)}% LIFT`,
      focus: [PoseIndex.RIGHT_WRIST, PoseIndex.RIGHT_SHOULDER],
    }
  }

  if (gesture === 'LEAN_LEFT' || gesture === 'LEAN_RIGHT') {
    const intended = gesture === 'LEAN_LEFT' ? -1 : 1
    const current = metrics.leanDegrees * intended
    const arrow = gesture === 'LEAN_LEFT' ? '←' : '→'
    return {
      title: current < 0 ? 'WRONG DODGE DIRECTION' : 'TORSO TILT TOO SMALL',
      detail: current < 0 ? 'You moved toward the incoming laser.' : `Your body tilt is only ${degree(metrics.leanDegrees)}.`,
      correction: `Lean further to the ${gesture === 'LEAN_LEFT' ? 'left' : 'right'}.`,
      arrow,
      current: `CURRENT ${degree(current)}`,
      target: `TARGET ${config.leanDegrees}°`,
      focus: [PoseIndex.LEFT_SHOULDER, PoseIndex.RIGHT_SHOULDER, PoseIndex.LEFT_HIP, PoseIndex.RIGHT_HIP],
    }
  }

  if (gesture === 'SQUAT') {
    const knee = Math.min(metrics.leftKneeAngle, metrics.rightKneeAngle)
    if (metrics.hipDrop < (config.hipDrop ?? 0)) {
      return {
        title: 'HIPS TOO HIGH',
        detail: `Your hips dropped ${Math.round(metrics.hipDrop * 100)}% of torso height.`,
        correction: 'Squat deeper and move your hips slightly backward.',
        arrow: '↓',
        current: `${Math.round(metrics.hipDrop * 100)}% DROP`,
        target: `${Math.round((config.hipDrop ?? 0) * 100)}% DROP`,
        focus: [PoseIndex.LEFT_HIP, PoseIndex.RIGHT_HIP, PoseIndex.LEFT_KNEE, PoseIndex.RIGHT_KNEE],
      }
    }
    return {
      title: 'BEND YOUR KNEES',
      detail: `Your knee angle is ${Math.round(knee)}° - your stance is still too straight.`,
      correction: 'Keep your hips low and bend both knees a little more.',
      arrow: '↗',
      current: `CURRENT ${Math.round(knee)}°`,
      target: `TARGET ≤ ${config.kneeAngle}°`,
      focus: [PoseIndex.LEFT_KNEE, PoseIndex.RIGHT_KNEE],
    }
  }

  const leftBehind = metrics.leftForward < metrics.rightForward
  const forward = Math.min(metrics.leftForward, metrics.rightForward)
  if (forward < (config.handsForward ?? 0)) {
    return {
      title: `${leftBehind ? 'LEFT' : 'RIGHT'} HAND TOO FAR BACK`,
      detail: 'One hand has not crossed the forward activation plane.',
      correction: 'Move both hands forward together, toward the camera.',
      arrow: '↑',
      current: `${Math.round(forward * 100)}% FORWARD`,
      target: `${Math.round((config.handsForward ?? 0) * 100)}% FORWARD`,
      focus: leftBehind ? [PoseIndex.LEFT_WRIST] : [PoseIndex.RIGHT_WRIST],
    }
  }
  return {
    title: 'HANDS OUT OF SYNC',
    detail: 'Your hands are not entering the vault field together.',
    correction: 'Bring both hands level and shoulder-width apart.',
    arrow: '↖',
    current: `OFFSET ${Math.round(metrics.handsSymmetry * 100)}%`,
    target: `MAX ${Math.round((config.handsSymmetry ?? 0) * 100)}%`,
    focus: [PoseIndex.LEFT_WRIST, PoseIndex.RIGHT_WRIST],
  }
}
