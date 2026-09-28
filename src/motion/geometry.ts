import type { Landmark, PoseFrame } from '../types/pose'

export const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

export const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y)

export const midpoint = (a: Landmark, b: Landmark): Landmark => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
  visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
})

export const angleAt = (a: Landmark, b: Landmark, c: Landmark) => {
  const ab = { x: a.x - b.x, y: a.y - b.y }
  const cb = { x: c.x - b.x, y: c.y - b.y }
  const dot = ab.x * cb.x + ab.y * cb.y
  const length = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y)
  if (length === 0) return 180
  return Math.acos(Math.min(1, Math.max(-1, dot / length))) * (180 / Math.PI)
}

export const clamp = (value: number, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value))

/** The camera is mirrored consistently in both the preview and gesture space. */
export const mirroredPoint = (frame: PoseFrame, index: number, world = false): Landmark => {
  const point = (world ? frame.worldLandmarks : frame.landmarks)?.[index] ?? frame.landmarks[index]
  return { ...point, x: 1 - point.x }
}

export const visible = (...points: Landmark[]) => average(points.map((point) => point.visibility ?? 1))
