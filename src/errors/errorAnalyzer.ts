import { GESTURE_CONFIG } from '../motion/gestureConfig'
import { PoseIndex } from '../types/pose'
import type { GestureId, GestureMetrics, LaserReading, MovementError, VaultCursor, VaultReading, VaultTarget } from '../types/game'

const degree = (value: number) => `${Math.abs(Math.round(value))}°`

const percent = (fraction: number) => Math.round(fraction * 100)

const DESK_FOCUS = [PoseIndex.NOSE, PoseIndex.LEFT_SHOULDER, PoseIndex.RIGHT_SHOULDER]

const laserBodyPart = (index: number | null) => {
  if (index === null) return 'HEAD & CHEST'
  if (index === PoseIndex.NOSE) return 'HEAD'
  if (index === PoseIndex.LEFT_SHOULDER || index === PoseIndex.RIGHT_SHOULDER) return 'SHOULDERS'
  return 'HIPS'
}

/** Correction distance shown next to the on-canvas arrow; never reads "0 CM" while still breaching. */
export const laserCorrectionCm = (reading: LaserReading) => Math.max(1, reading.deltaCm)

/** "LOWER BY {cm} CM" + "(CURRENT: {n}%, TARGET: {n}%)", split so the canvas can stack them. */
export const laserCorrectionParts = (reading: LaserReading): [string, string] => [
  `LOWER BY ${laserCorrectionCm(reading)} CM`,
  `(CURRENT: ${percent(reading.currentDrop)}%, TARGET: ${percent(reading.targetDrop)}%)`,
]

export const analyzeLaserBreach = (reading: LaserReading): MovementError => {
  const part = laserBodyPart(reading.worst.index)
  const cm = laserCorrectionCm(reading)
  if (reading.mode === 'desk') {
    return {
      title: 'LOWER HEAD & CHEST',
      detail: `Desk mode: your head and chest are ${cm} cm above the beam.`,
      correction: `Lean down toward the desk by ${cm} cm — tuck your chin and fold your chest.`,
      arrow: '↓',
      current: `CURRENT ${percent(reading.currentDrop)}% DROP`,
      target: `TARGET ${percent(reading.targetDrop)}% DROP`,
      focus: DESK_FOCUS,
    }
  }
  return {
    title: `LASER CONTACT — ${part}`,
    detail: `Your ${part.toLowerCase()} ${part === 'HEAD' ? 'is' : 'are'} ${cm} cm above the beam.`,
    correction: `Lower by ${cm} cm — bend your knees and tuck your head under the beam.`,
    arrow: '↓',
    current: `CURRENT ${percent(reading.currentDrop)}% DROP`,
    target: `TARGET ${percent(reading.targetDrop)}% DROP`,
    focus: reading.joints.flatMap((joint) => (joint.breaching && joint.index !== null ? [joint.index] : [])),
  }
}

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
    const side = gesture === 'LEAN_LEFT' ? 'LEFT' : 'RIGHT'
    const wrongSide = side === 'LEFT' ? 'RIGHT' : 'LEFT'
    const wrongWay = current < 0
    return {
      title: wrongWay ? 'WRONG DODGE DIRECTION' : 'TORSO TILT TOO SMALL',
      detail: wrongWay
        ? `You leaned ${degree(current)} to your ${wrongSide.toLowerCase()} — into the incoming laser. The screen is a mirror.`
        : `Your body tilt is only ${degree(metrics.leanDegrees)}.`,
      correction: wrongWay
        ? `Straighten up, then lean to your ${side.toLowerCase()} — toward the ${arrow} side of the screen.`
        : `Lean ${Math.max(1, Math.ceil((config.leanDegrees ?? 0) - current))}° further to the ${side.toLowerCase()}.`,
      arrow,
      current: wrongWay ? `CURRENT ${degree(current)} ${wrongSide}` : `CURRENT ${degree(current)}`,
      target: `TARGET ${config.leanDegrees}° ${side}`,
      focus: [PoseIndex.LEFT_SHOULDER, PoseIndex.RIGHT_SHOULDER, PoseIndex.LEFT_HIP, PoseIndex.RIGHT_HIP],
    }
  }

  if (gesture === 'SQUAT' && metrics.laser?.breached) return analyzeLaserBreach(metrics.laser)

  if (gesture === 'SQUAT' && metrics.trackingMode === 'desk') {
    return {
      title: 'LOWER HEAD & CHEST',
      detail: `Your head and chest dropped ${percent(metrics.deskDrop)}% of torso height.`,
      correction: 'Lean down toward the desk — tuck your chin and fold your chest.',
      arrow: '↓',
      current: `CURRENT ${percent(Math.max(0, metrics.deskDrop))}% DROP`,
      target: `TARGET ${percent(config.deskDrop ?? 0)}% DROP`,
      focus: DESK_FOCUS,
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

  // VAULT_BREACH is diagnosed from its own state machine (analyzeVaultError); this is only a fallback.
  return {
    title: 'PALMS NOT ON SCANNERS',
    detail: 'Both palms must rest on the chest-level scanners before the breach.',
    correction: 'Bring both hands to the glowing scanners in front of your chest.',
    arrow: '↑',
    current: 'NO LOCK',
    target: 'PALM LOCK',
    focus: [PoseIndex.LEFT_WRIST, PoseIndex.RIGHT_WRIST],
  }
}

const RELEASE_ERROR_MS = 2600
const PALM_ERROR_MS = 900

const arrowToward = (from: VaultCursor, to: VaultTarget): MovementError['arrow'] => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? '←' : '→'
  return dy < 0 ? '↑' : '↓'
}

/** Vault finale diagnosis: a dropped grip, or one palm that never found its scanner. */
export const analyzeVaultError = (vault: VaultReading, now: number): MovementError | undefined => {
  const config = GESTURE_CONFIG.VAULT_BREACH
  const complete = percent(config.breachComplete ?? 0.95)
  if (vault.releasedAt !== null && vault.phase !== 'breaching' && vault.phase !== 'breached' && now - vault.releasedAt < RELEASE_ERROR_MS) {
    return {
      title: "DON'T RELEASE — PULL WIDER",
      detail: `The doors sprang shut at ${percent(vault.releasedProgress)}% — your arms dropped mid-breach.`,
      correction: 'Re-grip both scanners, then pull your hands straight apart at chest height.',
      arrow: '↔',
      current: `LAST PULL ${percent(vault.releasedProgress)}%`,
      target: `TARGET ${complete}%`,
      focus: [PoseIndex.LEFT_WRIST, PoseIndex.RIGHT_WRIST],
    }
  }
  if (vault.phase === 'align' && vault.onePalmSince !== null && now - vault.onePalmSince > PALM_ERROR_MS) {
    const index = vault.targets[0].engaged ? 1 : 0
    const side = index === 0 ? 'LEFT' : 'RIGHT'
    const target = vault.targets[index]
    const radius = percent(vault.radius)
    const away = target.offset === null ? null : percent(target.offset * vault.radius)
    return {
      title: `${side} PALM OFF SCANNER`,
      detail: away === null
        ? `Your ${side.toLowerCase()} hand is out of view.`
        : `Your ${side.toLowerCase()} palm is ${away}% of the screen from its scanner.`,
      correction: `Move your ${side.toLowerCase()} hand onto the ${side.toLowerCase()} scanner and hold both still.`,
      arrow: arrowToward(vault.wrists[index], target),
      current: away === null ? 'NOT TRACKED' : `CURRENT ${away}% AWAY`,
      target: `WITHIN ${radius}%`,
      focus: [index === 0 ? PoseIndex.LEFT_WRIST : PoseIndex.RIGHT_WRIST],
    }
  }
  return undefined
}
