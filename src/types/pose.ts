export interface Landmark {
  x: number
  y: number
  z: number
  visibility?: number
}

/** 'desk' = legs out of frame (seated at a laptop); only the upper body is judged. */
export type TrackingMode = 'full' | 'desk'

export interface PoseFrame {
  landmarks: Landmark[]
  worldLandmarks?: Landmark[]
  timestamp: number
  /** Stamped by the camera hook from the rolling lower-body visibility window. */
  trackingMode?: TrackingMode
  /** Video width / height; converts normalized X distances into Y units. */
  aspect?: number
}

export interface CalibrationBaseline {
  /** A baseline is only valid at the camera distance / mode it was captured in. */
  mode: TrackingMode
  hipY: number
  /** Shoulder-midpoint Y captured in the neutral stance (normalized image space). */
  shoulderY: number
  /** Mirrored shoulder-midpoint X; the desk-mode lean pivots below it. */
  shoulderX: number
  noseY: number
  torso: number
  shoulderWidth: number
  capturedAt: number
}

export const PoseIndex = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
} as const

/** Joints that must pass under the DUCK UNDER LASER beam. */
export const LASER_CRITICAL_JOINTS = [
  PoseIndex.NOSE,
  PoseIndex.LEFT_SHOULDER,
  PoseIndex.RIGHT_SHOULDER,
  PoseIndex.LEFT_HIP,
  PoseIndex.RIGHT_HIP,
] as const
