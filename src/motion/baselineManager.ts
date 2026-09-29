import { TRACKING_CONFIG } from './gestureConfig'
import { calibrationFrom } from './gestureEngine'
import type { CalibrationBaseline, PoseFrame, TrackingMode } from '../types/pose'

const mean = (samples: CalibrationBaseline[], pick: (item: CalibrationBaseline) => number) =>
  samples.reduce((sum, item) => sum + pick(item), 0) / samples.length

export const averageBaselines = (samples: CalibrationBaseline[]): CalibrationBaseline => ({
  mode: samples[samples.length - 1].mode,
  hipY: mean(samples, (item) => item.hipY),
  shoulderY: mean(samples, (item) => item.shoulderY),
  shoulderX: mean(samples, (item) => item.shoulderX),
  noseY: mean(samples, (item) => item.noseY),
  torso: mean(samples, (item) => item.torso),
  shoulderWidth: mean(samples, (item) => item.shoulderWidth),
  capturedAt: Date.now(),
})

/**
 * Holds one baseline per tracking mode. A desk baseline (large torso, hips
 * off-screen) is meaningless three metres back and vice versa, so a mode
 * switch silently captures a fresh baseline from a short run of stable frames.
 */
export class BaselineManager {
  private baselines: Partial<Record<TrackingMode, CalibrationBaseline>> = {}
  private activeMode: TrackingMode | null = null
  private samples: CalibrationBaseline[] = []

  seed(baseline: CalibrationBaseline) {
    this.baselines = { [baseline.mode]: baseline }
    this.activeMode = baseline.mode
    this.samples = []
  }

  get hasBaseline() {
    return this.activeMode !== null
  }

  /** The baseline matching this frame's mode, or null while it is being re-captured. */
  resolve(frame: PoseFrame): CalibrationBaseline | null {
    const mode = frame.trackingMode ?? 'full'
    if (mode !== this.activeMode) {
      // The player moved: whatever we had for this mode was captured at a different distance.
      this.activeMode = mode
      delete this.baselines[mode]
      this.samples = []
    }
    const ready = this.baselines[mode]
    if (ready) return ready

    const sample = calibrationFrom(frame)
    if (!sample) return null
    const first = this.samples[0]
    if (first && Math.abs(sample.shoulderY - first.shoulderY) > TRACKING_CONFIG.rebaseTolerance) this.samples = []
    this.samples.push(sample)
    if (this.samples.length < TRACKING_CONFIG.rebaseSamples) return null
    const baseline = averageBaselines(this.samples)
    this.baselines[mode] = baseline
    this.samples = []
    return baseline
  }

  reset() {
    this.baselines = {}
    this.activeMode = null
    this.samples = []
  }
}
