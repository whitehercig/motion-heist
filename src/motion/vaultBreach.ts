import { GESTURE_CONFIG } from './gestureConfig'
import { clamp, midpoint, mirroredPoint } from './geometry'
import { CHEST_BELOW_SHOULDERS } from './poseTemplates'
import { PoseIndex, type Landmark, type PoseFrame } from '../types/pose'
import type { GestureMetrics, VaultCursor, VaultPhase, VaultReading, VaultTarget } from '../types/game'

const CONFIG = GESTURE_CONFIG.VAULT_BREACH
export const VAULT_LOCK_MS = CONFIG.holdMs
export const VAULT_PALM_RADIUS = CONFIG.palmRadius ?? 0.12
export const VAULT_BREACH_COMPLETE = CONFIG.breachComplete ?? 0.95
const BREACH_SPAN = CONFIG.breachSpan ?? 1.2
/** Scanner centres sit ±0.6 shoulder widths from the sternum: natural "palms on a panel" width. */
const SCANNER_SPREAD = 0.6
/** A wrist this far below the shoulders (in torso heights) means the arms were dropped. */
const RELEASE_BELOW = 0.85
const MIN_VISIBILITY = 0.35

interface Point {
  x: number
  y: number
}

const tracked = (point: Landmark) => (point.visibility ?? 1) >= MIN_VISIBILITY

/**
 * PALM LOCK -> KINETIC BREACH state machine. Pure: no timers or DOM, time
 * comes from pose-frame timestamps, so it is deterministic and testable.
 */
export class VaultBreach {
  private phase: VaultPhase = 'align'
  private frozenTargets: [Point, Point] | null = null
  private lockStartedAt: number | null = null
  private lockedAt: number | null = null
  private releasedAt: number | null = null
  private releasedProgress = 0
  private breachedAt: number | null = null
  private initialDistance: number | null = null
  private span = 1
  private breachProgress = 0
  private onePalmSince: number | null = null

  reset() {
    this.phase = 'align'
    this.frozenTargets = null
    this.lockStartedAt = null
    this.lockedAt = null
    this.releasedAt = null
    this.releasedProgress = 0
    this.breachedAt = null
    this.initialDistance = null
    this.span = 1
    this.breachProgress = 0
    this.onePalmSince = null
  }

  update(frame: PoseFrame, metrics: GestureMetrics, now: number): VaultReading {
    const aspect = frame.aspect ?? 16 / 9
    const shoulders = midpoint(mirroredPoint(frame, PoseIndex.LEFT_SHOULDER), mirroredPoint(frame, PoseIndex.RIGHT_SHOULDER))
    const leftWrist = mirroredPoint(frame, PoseIndex.LEFT_WRIST)
    const rightWrist = mirroredPoint(frame, PoseIndex.RIGHT_WRIST)
    const chestY = shoulders.y + CHEST_BELOW_SHOULDERS * metrics.torso
    const live: [Point, Point] = [
      { x: shoulders.x - SCANNER_SPREAD * metrics.shoulderWidth, y: chestY },
      { x: shoulders.x + SCANNER_SPREAD * metrics.shoulderWidth, y: chestY },
    ]
    // Scanners follow the body while aligning, then freeze so they don't swim under the palms.
    const centres = this.phase === 'align' || !this.frozenTargets ? live : this.frozenTargets
    // Distances in frame-width units so the 12% radius is round on screen.
    const offsetOf = (wrist: Landmark, centre: Point) =>
      tracked(wrist) ? Math.hypot(wrist.x - centre.x, (wrist.y - centre.y) / aspect) / VAULT_PALM_RADIUS : null
    const offsets = [offsetOf(leftWrist, centres[0]), offsetOf(rightWrist, centres[1])] as const
    const engaged = [offsets[0] !== null && offsets[0] <= 1, offsets[1] !== null && offsets[1] <= 1] as const
    const bothEngaged = engaged[0] && engaged[1]
    const wristGap = Math.abs(leftWrist.x - rightWrist.x)

    switch (this.phase) {
      case 'align':
        if (bothEngaged) {
          this.phase = 'locking'
          this.lockStartedAt = now
          this.frozenTargets = live
        }
        break
      case 'locking':
        if (!bothEngaged) {
          this.phase = 'align'
          this.lockStartedAt = null
          this.frozenTargets = null
        } else if (now - (this.lockStartedAt ?? now) >= VAULT_LOCK_MS) {
          this.phase = 'breaching'
          this.lockedAt = now
          this.initialDistance = wristGap
          this.span = Math.max(0.02, metrics.shoulderWidth * BREACH_SPAN)
          this.breachProgress = 0
        }
        break
      case 'breaching': {
        // Only dropping the arms releases the grip. Wrists leaving the frame while spread
        // wide keep their extrapolated positions, so a desk player isn't punished for reach.
        const releaseLine = shoulders.y + RELEASE_BELOW * metrics.torso
        if (leftWrist.y > releaseLine || rightWrist.y > releaseLine) {
          this.releasedAt = now
          this.releasedProgress = this.breachProgress
          this.phase = 'align'
          this.lockStartedAt = null
          this.frozenTargets = null
          this.initialDistance = null
          this.breachProgress = 0
          break
        }
        this.breachProgress = clamp((wristGap - (this.initialDistance ?? wristGap)) / this.span)
        if (this.breachProgress >= VAULT_BREACH_COMPLETE) {
          this.phase = 'breached'
          this.breachedAt = now
          this.breachProgress = 1
        }
        break
      }
      case 'breached':
        break
    }

    this.onePalmSince = this.phase === 'align' && engaged[0] !== engaged[1] ? this.onePalmSince ?? now : null

    const target = (index: 0 | 1): VaultTarget => ({ x: centres[index].x, y: centres[index].y, engaged: engaged[index], offset: offsets[index] })
    const cursor = (wrist: Landmark): VaultCursor => ({ x: wrist.x, y: wrist.y, tracked: tracked(wrist) })
    return {
      phase: this.phase,
      targets: [target(0), target(1)],
      wrists: [cursor(leftWrist), cursor(rightWrist)],
      radius: VAULT_PALM_RADIUS,
      lockProgress: this.phase === 'locking'
        ? clamp((now - (this.lockStartedAt ?? now)) / VAULT_LOCK_MS)
        : this.phase === 'align' ? 0 : 1,
      breachProgress: this.breachProgress,
      initialDistance: this.initialDistance,
      lockStartedAt: this.lockStartedAt,
      lockedAt: this.lockedAt,
      releasedAt: this.releasedAt,
      releasedProgress: this.releasedProgress,
      breachedAt: this.breachedAt,
      onePalmSince: this.onePalmSince,
      timestamp: now,
    }
  }
}
