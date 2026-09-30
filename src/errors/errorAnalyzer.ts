import { t } from '../i18n/i18n'
import { GESTURE_CONFIG } from '../motion/gestureConfig'
import { PoseIndex } from '../types/pose'
import type { GestureId, GestureMetrics, LaserReading, MovementError, VaultCursor, VaultReading, VaultTarget } from '../types/game'

const degree = (value: number) => `${Math.abs(Math.round(value))}°`

const percent = (fraction: number) => Math.round(fraction * 100)

const DESK_FOCUS = [PoseIndex.NOSE, PoseIndex.LEFT_SHOULDER, PoseIndex.RIGHT_SHOULDER]
const UPPER_BODY_FOCUS = [
  PoseIndex.NOSE,
  PoseIndex.LEFT_SHOULDER, PoseIndex.RIGHT_SHOULDER,
  PoseIndex.LEFT_ELBOW, PoseIndex.RIGHT_ELBOW,
  PoseIndex.LEFT_WRIST, PoseIndex.RIGHT_WRIST,
]

type LaserPart = 'HEAD' | 'SHOULDERS' | 'HIPS'

const laserBodyPart = (index: number): LaserPart => {
  if (index === PoseIndex.NOSE) return 'HEAD'
  if (index === PoseIndex.LEFT_SHOULDER || index === PoseIndex.RIGHT_SHOULDER) return 'SHOULDERS'
  return 'HIPS'
}

const dropValue = (fraction: number) => t('u.drop', { n: percent(fraction) })

/** Correction distance shown next to the on-canvas arrow; never reads "0 CM" while still breaching. */
export const laserCorrectionCm = (reading: LaserReading) => Math.max(1, reading.deltaCm)

/** "LOWER BY {cm} CM" + "(CURRENT: {n}%, TARGET: {n}%)", split so the canvas can stack them. */
export const laserCorrectionParts = (reading: LaserReading): [string, string] => [
  t('laser.lower', { cm: laserCorrectionCm(reading) }),
  t('laser.measures', { cur: percent(reading.currentDrop), tgt: percent(reading.targetDrop) }),
]

export const analyzeLaserBreach = (reading: LaserReading): MovementError => {
  const cm = laserCorrectionCm(reading)
  const current = t('m.current', { v: dropValue(reading.currentDrop) })
  const target = t('m.target', { v: dropValue(reading.targetDrop) })
  if (reading.mode === 'desk' || reading.worst.index === null) {
    return {
      title: t('err.desk.title'),
      detail: t('err.deskLaser.detail', { cm }),
      correction: t('err.deskLaser.fix', { cm }),
      arrow: '↓',
      current,
      target,
      focus: DESK_FOCUS,
    }
  }
  const part = laserBodyPart(reading.worst.index)
  return {
    title: t('err.laser.title', { part: t(`laser.part.${part}`) }),
    detail: t('err.laser.detail', { subject: t(`laser.subject.${part}`), cm }),
    correction: t('err.laser.fix', { cm }),
    arrow: '↓',
    current,
    target,
    focus: reading.joints.flatMap((joint) => (joint.breaching && joint.index !== null ? [joint.index] : [])),
  }
}

export const analyzeMovementError = (gesture: GestureId, metrics: GestureMetrics): MovementError => {
  const config = GESTURE_CONFIG[gesture]

  if (gesture === 'RIGHT_HAND_UP') {
    return {
      title: t('err.hand.title'),
      detail: t('err.hand.detail', { n: percent(metrics.handLift) }),
      correction: t('err.hand.fix'),
      arrow: '↑',
      current: t('u.lift', { n: percent(metrics.handLift) }),
      target: t('u.lift', { n: percent(config.handLift ?? 0) }),
      focus: [PoseIndex.RIGHT_WRIST, PoseIndex.RIGHT_SHOULDER],
    }
  }

  if (gesture === 'FREEZE') {
    const energy = percent(metrics.motionEnergy ?? 0)
    return {
      title: t('err.freeze.title'),
      detail: t('err.freeze.detail', { n: energy }),
      correction: t('err.freeze.fix'),
      arrow: '↔',
      current: t('err.freeze.current', { n: energy }),
      target: t('err.freeze.target', { n: percent(config.motionEnergy ?? 0) }),
      focus: UPPER_BODY_FOCUS,
    }
  }

  if (gesture === 'LEAN_LEFT' || gesture === 'LEAN_RIGHT') {
    const intended = gesture === 'LEAN_LEFT' ? -1 : 1
    const current = metrics.leanDegrees * intended
    const arrow = gesture === 'LEAN_LEFT' ? '←' : '→'
    const side = gesture === 'LEAN_LEFT' ? 'left' : 'right'
    const wrongSide = side === 'left' ? 'right' : 'left'
    const wrongWay = current < 0
    return {
      title: wrongWay ? t('err.wrongWay.title') : t('err.tilt.title'),
      detail: wrongWay
        ? t('err.wrongWay.detail', { deg: degree(current), wrong: t(`side.${wrongSide}`) })
        : t('err.tilt.detail', { deg: degree(metrics.leanDegrees) }),
      correction: wrongWay
        ? t('err.wrongWay.fix', { side: t(`side.${side}`), arrow })
        : t('err.tilt.fix', { n: Math.max(1, Math.ceil((config.leanDegrees ?? 0) - current)), side: t(`side.${side}`) }),
      arrow,
      current: t('m.current', { v: wrongWay ? `${degree(current)} ${t(`SIDE.${wrongSide}`)}` : degree(current) }),
      target: t('m.target', { v: `${config.leanDegrees}° ${t(`SIDE.${side}`)}` }),
      focus: [PoseIndex.LEFT_SHOULDER, PoseIndex.RIGHT_SHOULDER, PoseIndex.LEFT_HIP, PoseIndex.RIGHT_HIP],
    }
  }

  if (gesture === 'SQUAT' && metrics.laser?.breached) return analyzeLaserBreach(metrics.laser)

  if (gesture === 'SQUAT' && metrics.trackingMode === 'desk') {
    return {
      title: t('err.desk.title'),
      detail: t('err.deskSquat.detail', { n: percent(metrics.deskDrop) }),
      correction: t('err.deskSquat.fix'),
      arrow: '↓',
      current: t('m.current', { v: dropValue(Math.max(0, metrics.deskDrop)) }),
      target: t('m.target', { v: dropValue(config.deskDrop ?? 0) }),
      focus: DESK_FOCUS,
    }
  }

  if (gesture === 'SQUAT') {
    const knee = Math.min(metrics.leftKneeAngle, metrics.rightKneeAngle)
    if (metrics.hipDrop < (config.hipDrop ?? 0)) {
      return {
        title: t('err.hips.title'),
        detail: t('err.hips.detail', { n: percent(metrics.hipDrop) }),
        correction: t('err.hips.fix'),
        arrow: '↓',
        current: dropValue(metrics.hipDrop),
        target: dropValue(config.hipDrop ?? 0),
        focus: [PoseIndex.LEFT_HIP, PoseIndex.RIGHT_HIP, PoseIndex.LEFT_KNEE, PoseIndex.RIGHT_KNEE],
      }
    }
    return {
      title: t('err.knees.title'),
      detail: t('err.knees.detail', { deg: Math.round(knee) }),
      correction: t('err.knees.fix'),
      arrow: '↗',
      current: t('m.current', { v: `${Math.round(knee)}°` }),
      target: t('err.knees.target', { deg: config.kneeAngle ?? 0 }),
      focus: [PoseIndex.LEFT_KNEE, PoseIndex.RIGHT_KNEE],
    }
  }

  // VAULT_BREACH is diagnosed from its own state machine (analyzeVaultError); this is only a fallback.
  return {
    title: t('err.palms.title'),
    detail: t('err.palms.detail'),
    correction: t('err.palms.fix'),
    arrow: '↑',
    current: t('err.palms.current'),
    target: t('err.palms.target'),
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
      title: t('err.release.title'),
      detail: t('err.release.detail', { n: percent(vault.releasedProgress) }),
      correction: t('err.release.fix'),
      arrow: '↔',
      current: t('err.release.current', { n: percent(vault.releasedProgress) }),
      target: t('m.target', { v: `${complete}%` }),
      focus: [PoseIndex.LEFT_WRIST, PoseIndex.RIGHT_WRIST],
    }
  }
  if (vault.phase === 'align' && vault.onePalmSince !== null && now - vault.onePalmSince > PALM_ERROR_MS) {
    const index = vault.targets[0].engaged ? 1 : 0
    const side = index === 0 ? 'left' : 'right'
    const target = vault.targets[index]
    const radius = percent(vault.radius)
    const away = target.offset === null ? null : percent(target.offset * vault.radius)
    return {
      title: t(`err.palmOff.title.${side}`),
      detail: away === null ? t(`err.palmOff.hidden.${side}`) : t(`err.palmOff.detail.${side}`, { n: away }),
      correction: t(`err.palmOff.fix.${side}`),
      arrow: arrowToward(vault.wrists[index], target),
      current: away === null ? t('err.palmOff.untracked') : t('err.palmOff.current', { n: away }),
      target: t('err.palmOff.target', { n: radius }),
      focus: [index === 0 ? PoseIndex.LEFT_WRIST : PoseIndex.RIGHT_WRIST],
    }
  }
  return undefined
}
