import { clamp } from './geometry'
import { PoseIndex, type Landmark, type PoseFrame } from '../types/pose'
import type {
  BoneId,
  BoneRule,
  GestureId,
  LaserReading,
  PoseMatch,
  PoseTemplate,
  TemplateJoint,
  TemplatePoint,
} from '../types/game'

/**
 * Template space ([-1, 1], origin = chest centre, +x = player's right as seen
 * in the mirrored preview, +y = down, -z = toward the camera). One shoulder-to-
 * hip torso measures TEMPLATE_TORSO units, so the whole upper body fits the box.
 */
export const TEMPLATE_TORSO = 0.5
/** Chest centre sits this fraction of a torso below the shoulder midpoint. */
export const CHEST_BELOW_SHOULDERS = 0.3

const SHOULDER_Y = -CHEST_BELOW_SHOULDERS * TEMPLATE_TORSO
const HIP_Y = SHOULDER_Y + TEMPLATE_TORSO

const point = (x: number, y: number, z = 0): TemplatePoint => ({ x, y, z })
const add = (a: TemplatePoint, b: TemplatePoint) => point(a.x + b.x, a.y + b.y, a.z + b.z)
/** Arm vectors are authored for the right arm; the left arm mirrors X. */
const mirrorX = (a: TemplatePoint) => point(-a.x, a.y, a.z)

interface ArmShape {
  upper: TemplatePoint
  fore: TemplatePoint
}

const HANGING: ArmShape = { upper: point(0.05, 0.29), fore: point(0.02, 0.27) }

const skeleton = (
  shoulders: { left: TemplatePoint; right: TemplatePoint },
  nose: TemplatePoint,
  right: ArmShape,
  left: ArmShape,
): Record<TemplateJoint, TemplatePoint> => {
  const rightElbow = add(shoulders.right, right.upper)
  const leftElbow = add(shoulders.left, mirrorX(left.upper))
  return {
    nose,
    leftShoulder: shoulders.left,
    rightShoulder: shoulders.right,
    rightElbow,
    leftElbow,
    rightWrist: add(rightElbow, right.fore),
    leftWrist: add(leftElbow, mirrorX(left.fore)),
    leftHip: point(-0.11, HIP_Y),
    rightHip: point(0.11, HIP_Y),
  }
}

const UPRIGHT_SHOULDERS = { left: point(-0.19, SHOULDER_Y), right: point(0.19, SHOULDER_Y) }
const UPRIGHT_NOSE = point(0, -0.45)

/**
 * Rotate the spine about the hip centre (negative = toward screen left). The
 * arms keep hanging with gravity from the displaced shoulders.
 */
const leaningSkeleton = (degrees: number) => {
  const angle = (degrees * Math.PI) / 180
  const rotate = (p: TemplatePoint) => {
    const dx = p.x
    const dy = p.y - HIP_Y
    return point(dx * Math.cos(angle) - dy * Math.sin(angle), HIP_Y + dx * Math.sin(angle) + dy * Math.cos(angle), p.z)
  }
  return skeleton(
    { left: rotate(UPRIGHT_SHOULDERS.left), right: rotate(UPRIGHT_SHOULDERS.right) },
    rotate(UPRIGHT_NOSE),
    HANGING,
    HANGING,
  )
}

const bones = (torso: BoneRule, right: [BoneRule, BoneRule], left: [BoneRule, BoneRule]): Record<BoneId, BoneRule> => ({
  torso,
  rightUpperArm: right[0],
  rightForearm: right[1],
  leftUpperArm: left[0],
  leftForearm: left[1],
})

const loose: BoneRule = { weight: 0.5, toleranceDeg: 50 }
/**
 * An 18° lean is only cos = 0.95 away from upright, so the spine gets a tight
 * 12° cone: the gauge locks around 13-14°, just before the engine's 15° rule.
 */
const LEAN_SPINE: BoneRule = { weight: 4, toleranceDeg: 12 }

export const POSE_TEMPLATES: Record<GestureId, PoseTemplate> = {
  RIGHT_HAND_UP: {
    id: 'SCAN_ACCESS',
    gesture: 'RIGHT_HAND_UP',
    label: 'SCAN ACCESS',
    // Right elbow out to the side, forearm vertical: the "hand up to the scanner" L-shape.
    joints: skeleton(UPRIGHT_SHOULDERS, UPRIGHT_NOSE, { upper: point(0.25, -0.13), fore: point(0.02, -0.27) }, HANGING),
    bones: bones({ weight: 1, toleranceDeg: 25 }, [{ weight: 1.5, toleranceDeg: 40 }, { weight: 1.5, toleranceDeg: 35 }], [loose, loose]),
    anchorDrop: 0,
    levelWeight: 0,
    gaugeSide: -1,
  },
  LEAN_LEFT: {
    id: 'DODGE_LEFT',
    gesture: 'LEAN_LEFT',
    label: 'DODGE LEFT',
    joints: leaningSkeleton(-18),
    bones: bones(LEAN_SPINE, [loose, loose], [loose, loose]),
    anchorDrop: 0,
    levelWeight: 0,
    gaugeSide: 1,
  },
  LEAN_RIGHT: {
    id: 'DODGE_RIGHT',
    gesture: 'LEAN_RIGHT',
    label: 'DODGE RIGHT',
    joints: leaningSkeleton(18),
    bones: bones(LEAN_SPINE, [loose, loose], [loose, loose]),
    anchorDrop: 0,
    levelWeight: 0,
    gaugeSide: -1,
  },
  SQUAT: {
    id: 'DUCK_LASER',
    gesture: 'SQUAT',
    label: 'DUCK UNDER LASER',
    // Guard arms tucked in front of the chest; the pose is mostly a translation, carried by levelWeight.
    joints: skeleton(UPRIGHT_SHOULDERS, UPRIGHT_NOSE, { upper: point(0.08, 0.24, -0.08), fore: point(-0.1, -0.14, -0.18) }, { upper: point(0.08, 0.24, -0.08), fore: point(-0.1, -0.14, -0.18) }),
    bones: bones({ weight: 1, toleranceDeg: 30 }, [{ weight: 0.25, toleranceDeg: 70 }, { weight: 0.25, toleranceDeg: 70 }], [{ weight: 0.25, toleranceDeg: 70 }, { weight: 0.25, toleranceDeg: 70 }]),
    anchorDrop: 0.25,
    // Heavy enough that the gauge only locks at ~85-90% of the required drop.
    levelWeight: 6,
    gaugeSide: -1,
  },
  VAULT_BREACH: {
    id: 'OPEN_VAULT',
    gesture: 'VAULT_BREACH',
    label: 'OPEN VAULT',
    // PALM LOCK grip: palms raised in front of the chest onto the two scanners. The vault stage
    // draws its own scanners and doors, so the ghost is not shown during this phase.
    joints: skeleton(UPRIGHT_SHOULDERS, UPRIGHT_NOSE, { upper: point(0.02, 0.2, -0.12), fore: point(0.02, -0.05, -0.22) }, { upper: point(0.02, 0.2, -0.12), fore: point(0.02, -0.05, -0.22) }),
    bones: bones({ weight: 1, toleranceDeg: 25 }, [{ weight: 1.25, toleranceDeg: 40 }, { weight: 1.25, toleranceDeg: 40 }], [{ weight: 1.25, toleranceDeg: 40 }, { weight: 1.25, toleranceDeg: 40 }]),
    anchorDrop: 0,
    levelWeight: 0,
    gaugeSide: -1,
  },
}

const LANDMARK_OF: Record<TemplateJoint, number> = {
  nose: PoseIndex.NOSE,
  leftShoulder: PoseIndex.LEFT_SHOULDER,
  rightShoulder: PoseIndex.RIGHT_SHOULDER,
  leftElbow: PoseIndex.LEFT_ELBOW,
  rightElbow: PoseIndex.RIGHT_ELBOW,
  leftWrist: PoseIndex.LEFT_WRIST,
  rightWrist: PoseIndex.RIGHT_WRIST,
  leftHip: PoseIndex.LEFT_HIP,
  rightHip: PoseIndex.RIGHT_HIP,
}

/** Each bone is a direction vector between joint centroids (the torso uses midpoints). */
export const BONE_JOINTS: Record<BoneId, [TemplateJoint[], TemplateJoint[]]> = {
  torso: [['leftShoulder', 'rightShoulder'], ['leftHip', 'rightHip']],
  rightUpperArm: [['rightShoulder'], ['rightElbow']],
  rightForearm: [['rightElbow'], ['rightWrist']],
  leftUpperArm: [['leftShoulder'], ['leftElbow']],
  leftForearm: [['leftElbow'], ['leftWrist']],
}

const BONE_IDS = Object.keys(BONE_JOINTS) as BoneId[]
const MIN_VISIBILITY = 0.35

export interface PoseMatchOptions {
  /**
   * 'world' = MediaPipe worldLandmarks (metres, isotropic, best for depth);
   * 'image' = normalized image landmarks, made isotropic with `aspect`.
   */
  space?: 'world' | 'image'
  /** Video width / height, used only in image space. */
  aspect?: number
  /** 0..1 progress of the template's vertical translation (ducking); ignored when the template has no level term. */
  levelProgress?: number
}

type Vec3 = TemplatePoint

const centroid = (joints: TemplateJoint[], lookup: (joint: TemplateJoint) => Vec3 | null): Vec3 | null => {
  let x = 0
  let y = 0
  let z = 0
  for (const joint of joints) {
    const p = lookup(joint)
    if (!p) return null
    x += p.x
    y += p.y
    z += p.z
  }
  return point(x / joints.length, y / joints.length, z / joints.length)
}

const boneVector = (bone: BoneId, lookup: (joint: TemplateJoint) => Vec3 | null): Vec3 | null => {
  const [fromJoints, toJoints] = BONE_JOINTS[bone]
  const from = centroid(fromJoints, lookup)
  const to = centroid(toJoints, lookup)
  return from && to ? point(to.x - from.x, to.y - from.y, to.z - from.z) : null
}

/** cosθ = (A · B) / (‖A‖ ‖B‖); null for degenerate vectors. */
export const cosineSimilarity = (a: Vec3, b: Vec3) => {
  const lengths = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z)
  if (lengths < 1e-9) return null
  return (a.x * b.x + a.y * b.y + a.z * b.z) / lengths
}

/**
 * Raw cosine is far too forgiving for body poses (an 18° lean still scores
 * cos = 0.95), so each bone's cosine is rescaled over its tolerance cone:
 * 1 at a perfect match, 0 at `toleranceDeg` of angular error or worse.
 */
const coneSimilarity = (cos: number, toleranceDeg: number) => {
  const floor = Math.cos((toleranceDeg * Math.PI) / 180)
  return clamp((cos - floor) / (1 - floor))
}

/** Full breakdown: overall 0..100 plus per-bone similarity for rendering. */
export const matchPose = (landmarks: Landmark[], template: PoseTemplate, options: PoseMatchOptions = {}): PoseMatch => {
  const world = options.space === 'world'
  const aspect = world ? 1 : options.aspect ?? 16 / 9
  // Landmarks arrive unmirrored; negating X puts them in the template's mirrored space.
  const live = (joint: TemplateJoint): Vec3 | null => {
    const landmark = landmarks[LANDMARK_OF[joint]]
    if (!landmark) return null
    // Hips are off-screen at a desk; MediaPipe's extrapolation still gives a usable spine direction.
    const isHip = joint === 'leftHip' || joint === 'rightHip'
    if (!isHip && (landmark.visibility ?? 1) < MIN_VISIBILITY) return null
    return point(-landmark.x * aspect, landmark.y, landmark.z * aspect)
  }
  const ideal = (joint: TemplateJoint) => template.joints[joint]

  const scores = {} as Record<BoneId, number | null>
  let weighted = 0
  let totalWeight = 0
  for (const bone of BONE_IDS) {
    const current = boneVector(bone, live)
    const target = boneVector(bone, ideal)
    const cos = current && target ? cosineSimilarity(current, target) : null
    if (cos === null) {
      scores[bone] = null
      continue
    }
    const rule = template.bones[bone]
    const similarity = coneSimilarity(cos, rule.toleranceDeg)
    scores[bone] = similarity
    weighted += similarity * rule.weight
    totalWeight += rule.weight
  }
  if (template.levelWeight > 0 && options.levelProgress !== undefined) {
    weighted += clamp(options.levelProgress) * template.levelWeight
    totalWeight += template.levelWeight
  }
  const average = totalWeight ? weighted / totalWeight : 0
  return { score: clamp(Math.round(average * 100), 0, 100), bones: scores }
}

export function calculatePoseMatchScore(currentLandmarks: Landmark[], targetTemplate: PoseTemplate, options?: PoseMatchOptions): number {
  return matchPose(currentLandmarks, targetTemplate, options).score
}

/** DUCK's level term: how far the laser collider has travelled toward the beam target (0..1). */
export const duckProgress = (laser?: LaserReading) =>
  laser ? (laser.targetDrop > 0 ? clamp(laser.currentDrop / laser.targetDrop) : 1) : undefined

/** Match a live frame against a gesture's template, preferring metric world landmarks. */
export const matchFrame = (frame: PoseFrame, gesture: GestureId, laser?: LaserReading): PoseMatch => {
  const world = frame.worldLandmarks?.length ? frame.worldLandmarks : null
  return matchPose(world ?? frame.landmarks, POSE_TEMPLATES[gesture], {
    space: world ? 'world' : 'image',
    aspect: frame.aspect,
    levelProgress: duckProgress(laser),
  })
}
