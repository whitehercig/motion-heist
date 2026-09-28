export interface Landmark {
  x: number
  y: number
  z: number
  visibility?: number
}

export interface PoseFrame {
  landmarks: Landmark[]
  worldLandmarks?: Landmark[]
  timestamp: number
}

export interface CalibrationBaseline {
  hipY: number
  torso: number
  shoulderWidth: number
  capturedAt: number
}

export const PoseIndex = {
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
