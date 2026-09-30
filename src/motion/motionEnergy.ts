import { PoseIndex, type PoseFrame } from '../types/pose'

const JOINTS = [
  PoseIndex.NOSE,
  PoseIndex.LEFT_SHOULDER, PoseIndex.RIGHT_SHOULDER,
  PoseIndex.LEFT_ELBOW, PoseIndex.RIGHT_ELBOW,
  PoseIndex.LEFT_WRIST, PoseIndex.RIGHT_WRIST,
] as const

/** Displacement is measured across this window, long enough to average out landmark jitter. */
const WINDOW_MS = 300
/** EMA weight of the newest sample; tames the per-frame wobble of the lite model. */
const SMOOTHING = 0.5
const MIN_VISIBILITY = 0.5

interface Sample {
  time: number
  points: Array<{ x: number; y: number } | null>
}

/**
 * "How much is the player moving?" for FREEZE and the arcade searchlight.
 * Returns upper-body travel over the last 300 ms in shoulder widths: ~0.05
 * standing still, ~0.4 waving one arm. Blends the mean with the two most
 * active joints, so a single arm wave is caught but breathing is not.
 */
export class MotionEnergyMeter {
  private smoothed: Array<{ x: number; y: number } | null> = JOINTS.map(() => null)
  private history: Sample[] = []

  reset() {
    this.smoothed = JOINTS.map(() => null)
    this.history = []
  }

  update(frame: PoseFrame, shoulderWidth: number): number | undefined {
    const aspect = frame.aspect ?? 16 / 9
    const points = JOINTS.map((index, slot) => {
      const landmark = frame.landmarks[index]
      if (!landmark || (landmark.visibility ?? 1) < MIN_VISIBILITY) {
        this.smoothed[slot] = null
        return null
      }
      // Express y in x units so a vertical and a horizontal move of the same size weigh the same.
      const raw = { x: landmark.x, y: landmark.y / aspect }
      const previous = this.smoothed[slot]
      const next = previous ? { x: previous.x + (raw.x - previous.x) * SMOOTHING, y: previous.y + (raw.y - previous.y) * SMOOTHING } : raw
      this.smoothed[slot] = next
      return next
    })
    const now = frame.timestamp
    this.history.push({ time: now, points })
    while (this.history.length > 1 && now - this.history[1].time >= WINDOW_MS) this.history.shift()
    const oldest = this.history[0]
    if (now - oldest.time < WINDOW_MS * 0.8 || shoulderWidth <= 0) return undefined

    const travel: number[] = []
    points.forEach((point, slot) => {
      const before = oldest.points[slot]
      if (point && before) travel.push(Math.hypot(point.x - before.x, point.y - before.y) / shoulderWidth)
    })
    if (travel.length < 3) return undefined
    const mean = travel.reduce((sum, value) => sum + value, 0) / travel.length
    const [first, second] = [...travel].sort((a, b) => b - a)
    return 0.5 * mean + 0.5 * ((first + second) / 2)
  }
}
