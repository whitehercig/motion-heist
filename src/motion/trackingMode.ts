import { TRACKING_CONFIG } from './gestureConfig'
import { PoseIndex, type Landmark, type TrackingMode } from '../types/pose'

/** Desk-mode collider height: 70% shoulder midpoint + 30% nose (normalized Y). */
export const deskLevel = (shoulderMidY: number, noseY: number) =>
  shoulderMidY * TRACKING_CONFIG.deskShoulderWeight + noseY * TRACKING_CONFIG.deskNoseWeight

export const isLowerBodyVisible = (landmarks: Landmark[]) => {
  const threshold = TRACKING_CONFIG.landmarkVisibility
  return (landmarks[PoseIndex.LEFT_ANKLE]?.visibility ?? 0) > threshold
    && (landmarks[PoseIndex.RIGHT_ANKLE]?.visibility ?? 0) > threshold
    && (landmarks[PoseIndex.LEFT_KNEE]?.visibility ?? 0) > threshold
}

/**
 * Decides full-body vs desk (upper-body) tracking from a 30-frame ring buffer
 * of lower-body visibility. Fully automatic; the player never toggles it.
 */
export class LowerBodyTracker {
  private readonly history: boolean[] = new Array<boolean>(TRACKING_CONFIG.windowSize).fill(false)
  private cursor = 0
  private size = 0
  private visibleCount = 0
  private currentMode: TrackingMode = 'full'

  get mode() {
    return this.currentMode
  }

  get visibleRatio() {
    return this.size ? this.visibleCount / this.size : 1
  }

  push(landmarks: Landmark[]): TrackingMode {
    const visible = isLowerBodyVisible(landmarks)
    if (this.size === this.history.length) {
      if (this.history[this.cursor]) this.visibleCount -= 1
    } else {
      this.size += 1
    }
    this.history[this.cursor] = visible
    if (visible) this.visibleCount += 1
    this.cursor = (this.cursor + 1) % this.history.length

    const ratio = this.visibleRatio
    if (this.currentMode === 'full' && ratio < TRACKING_CONFIG.deskBelowRatio) this.currentMode = 'desk'
    else if (this.currentMode === 'desk' && ratio >= TRACKING_CONFIG.fullAtRatio) this.currentMode = 'full'
    return this.currentMode
  }

  reset() {
    this.history.fill(false)
    this.cursor = 0
    this.size = 0
    this.visibleCount = 0
    this.currentMode = 'full'
  }
}
