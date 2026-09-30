import { useEffect, useRef, type RefObject } from 'react'
import { t } from '../i18n/i18n'
import { clamp } from '../motion/geometry'
import { CHEST_BELOW_SHOULDERS, matchFrame, POSE_TEMPLATES, TEMPLATE_TORSO } from '../motion/poseTemplates'
import { createCoverViewport, measureCoverViewport, syncCanvasToVideo, type ViewBounds } from '../render/coverViewport'
import { PoseIndex, type CalibrationBaseline, type PoseFrame } from '../types/pose'
import type { BoneId, GestureId, LaserReading, PoseMatch, PoseTemplate, TemplateJoint, TemplatePoint } from '../types/game'

/** Written by the game loop at pose rate, read by the canvas at display rate. */
export interface HoloFeed {
  frame: PoseFrame
  baseline: CalibrationBaseline
  gesture: GestureId
  laser?: LaserReading
}

interface HoloGuideCanvasProps {
  videoRef: RefObject<HTMLVideoElement | null>
  feedRef: RefObject<HoloFeed | null>
  active: boolean
  onLock?: () => void
}

const LOCK_AT = 85
/** Hysteresis: once locked, jitter down to 78% keeps the lock instead of re-blipping. */
const UNLOCK_BELOW = 78
const BLIP_COOLDOWN_MS = 700
/** The duck ghost sinks slightly past the real laser target so matching it always clears the beam. */
const DUCK_MARGIN = 0.04
const MONO = '"SFMono-Regular", Consolas, monospace'

type Tier = 'amber' | 'cyan' | 'green'

const TIER_STROKE: Record<Tier, string> = {
  amber: 'rgba(255, 170, 0, 0.4)',
  cyan: 'rgba(0, 220, 255, 0.6)',
  green: 'rgba(0, 255, 136, 0.9)',
}
const TIER_SOLID: Record<Tier, string> = { amber: '#ffaa00', cyan: '#00dcff', green: '#00ff88' }
const TIER_FILL: Record<Tier, string> = {
  amber: 'rgba(255, 170, 0, 0.05)',
  cyan: 'rgba(0, 220, 255, 0.07)',
  green: 'rgba(0, 255, 136, 0.1)',
}
/** A limb that is clearly off is called out in amber even while the rest of the ghost is cyan. */
const WEAK_BONE = 'rgba(255, 170, 0, 0.85)'

const SEGMENTS: Array<[TemplateJoint, TemplateJoint, BoneId]> = [
  ['leftShoulder', 'rightShoulder', 'torso'],
  ['leftShoulder', 'leftHip', 'torso'],
  ['rightShoulder', 'rightHip', 'torso'],
  ['leftHip', 'rightHip', 'torso'],
  ['rightShoulder', 'rightElbow', 'rightUpperArm'],
  ['rightElbow', 'rightWrist', 'rightForearm'],
  ['leftShoulder', 'leftElbow', 'leftUpperArm'],
  ['leftElbow', 'leftWrist', 'leftForearm'],
]
const JOINT_NAMES = Object.keys(POSE_TEMPLATES.RIGHT_HAND_UP.joints) as TemplateJoint[]

interface Projected {
  x: number
  y: number
  /** Fake perspective: >1 for joints reaching toward the camera. */
  depth: number
}

const tierFor = (score: number, locked: boolean): Tier => (locked || score >= LOCK_AT ? 'green' : score >= 60 ? 'cyan' : 'amber')

const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate)

const ghostDrop = (template: PoseTemplate, laser?: LaserReading) =>
  template.levelWeight > 0 && laser ? laser.targetDrop + DUCK_MARGIN : template.anchorDrop

const project = (p: TemplatePoint, originX: number, originY: number, unit: number): Projected => {
  const depth = clamp(1 / (1 + p.z * 0.45), 0.7, 1.6)
  return { x: originX + p.x * unit * depth, y: originY + p.y * unit * depth, depth }
}

const drawGhost = (
  ctx: CanvasRenderingContext2D,
  joints: Record<TemplateJoint, Projected>,
  match: PoseMatch,
  tier: Tier,
  unit: number,
  t: number,
  px: number,
) => {
  const { leftShoulder, rightShoulder, leftHip, rightHip, nose } = joints
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Faint torso plate: reads as a hologram volume without hiding the player's own skeleton.
  ctx.fillStyle = TIER_FILL[tier]
  ctx.beginPath()
  ctx.moveTo(leftShoulder.x, leftShoulder.y)
  ctx.lineTo(rightShoulder.x, rightShoulder.y)
  ctx.lineTo(rightHip.x, rightHip.y)
  ctx.lineTo(leftHip.x, leftHip.y)
  ctx.closePath()
  ctx.fill()

  if (tier === 'green') {
    ctx.shadowColor = '#00ff88'
    ctx.shadowBlur = 12 * px
  }
  ctx.setLineDash([4 * px, 4 * px])
  ctx.lineDashOffset = -t * 0.012 * px
  for (const [from, to, bone] of SEGMENTS) {
    const weak = tier !== 'green' && (match.bones[bone] ?? 1) < 0.5
    ctx.strokeStyle = weak ? WEAK_BONE : TIER_STROKE[tier]
    ctx.lineWidth = (weak ? 2.6 : 2) * px
    ctx.beginPath()
    ctx.moveTo(joints[from].x, joints[from].y)
    ctx.lineTo(joints[to].x, joints[to].y)
    ctx.stroke()
  }

  const headRadius = 0.1 * unit
  const headY = nose.y - 0.03 * unit
  const neckX = (leftShoulder.x + rightShoulder.x) / 2
  const neckY = (leftShoulder.y + rightShoulder.y) / 2
  ctx.strokeStyle = TIER_STROKE[tier]
  ctx.lineWidth = 2 * px
  ctx.beginPath()
  ctx.arc(nose.x, headY, headRadius, 0, Math.PI * 2)
  ctx.moveTo(neckX, neckY)
  ctx.lineTo(nose.x + (neckX - nose.x) * 0.15, headY + headRadius)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = TIER_STROKE[tier]
  for (const name of ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHip', 'rightHip'] as const) {
    ctx.beginPath()
    ctx.arc(joints[name].x, joints[name].y, 2.5 * px, 0, Math.PI * 2)
    ctx.fill()
  }
  // Hands grow and gain a ring as they reach toward the camera (OPEN VAULT).
  ctx.strokeStyle = TIER_STROKE[tier]
  ctx.lineWidth = 1.5 * px
  for (const name of ['leftWrist', 'rightWrist'] as const) {
    const hand = joints[name]
    const radius = 4 * px * hand.depth
    ctx.beginPath()
    ctx.arc(hand.x, hand.y, radius, 0, Math.PI * 2)
    ctx.fill()
    if (hand.depth > 1.15) {
      ctx.beginPath()
      ctx.arc(hand.x, hand.y, radius * 2.2, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/** Corner brackets snap onto the ghost when the pose locks. */
const drawLockBrackets = (ctx: CanvasRenderingContext2D, joints: Record<TemplateJoint, Projected>, unit: number, flash: number, px: number) => {
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const name of JOINT_NAMES) {
    const joint = joints[name]
    left = Math.min(left, joint.x)
    right = Math.max(right, joint.x)
    top = Math.min(top, joint.y)
    bottom = Math.max(bottom, joint.y)
  }
  top -= 0.16 * unit
  const pad = (12 + 22 * flash) * px
  left -= pad
  right += pad
  top -= pad
  bottom += pad
  const arm = 14 * px
  ctx.save()
  ctx.strokeStyle = '#00ff88'
  ctx.shadowColor = '#00ff88'
  ctx.shadowBlur = 10 * px
  ctx.lineWidth = 2 * px
  ctx.globalAlpha *= 0.55 + 0.45 * (1 - flash)
  ctx.beginPath()
  for (const [x, y, dx, dy] of [[left, top, 1, 1], [right, top, -1, 1], [left, bottom, 1, -1], [right, bottom, -1, -1]] as const) {
    ctx.moveTo(x, y + dy * arm)
    ctx.lineTo(x, y)
    ctx.lineTo(x + dx * arm, y)
  }
  ctx.stroke()
  ctx.restore()
}

const drawSyncGauge = (
  ctx: CanvasRenderingContext2D,
  headX: number,
  headY: number,
  /** Gap between the head centre and the dial's near edge. */
  offset: number,
  preferredSide: -1 | 1,
  shown: number,
  tier: Tier,
  locked: boolean,
  flash: number,
  bounds: ViewBounds,
  px: number,
) => {
  const radius = 22 * px
  const percent = Math.round(shown)
  const status = t(locked ? 'holo.locked' : percent >= 60 ? 'holo.aligning' : 'holo.searching')
  const label = t('holo.sync', { n: percent, status })
  ctx.save()
  ctx.font = `700 ${10.5 * px}px ${MONO}`
  const labelWidth = ctx.measureText(label).width
  const reach = offset + radius * 2 + 10 * px + labelWidth + 8 * px

  // Flip to the other side of the head if the label would leave the visible frame.
  let side = preferredSide
  if (side === 1 && headX + reach > bounds.right) side = -1
  else if (side === -1 && headX - reach < bounds.left) side = 1
  const cx = clamp(headX + side * (offset + radius), bounds.left + radius + 4 * px, bounds.right - radius - 4 * px)
  const cy = clamp(headY, bounds.top + radius + 4 * px, bounds.bottom - radius - 4 * px)
  const start = -Math.PI / 2

  ctx.lineCap = 'round'
  ctx.lineWidth = 3 * px
  ctx.strokeStyle = 'rgba(210, 240, 255, 0.14)'
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()

  // Threshold ticks at 60% and 85% so the colour changes are legible on the dial itself.
  ctx.lineWidth = 1.5 * px
  ctx.strokeStyle = 'rgba(210, 240, 255, 0.45)'
  ctx.beginPath()
  for (const threshold of [60, LOCK_AT]) {
    const angle = start + (threshold / 100) * Math.PI * 2
    ctx.moveTo(cx + Math.cos(angle) * (radius - 5 * px), cy + Math.sin(angle) * (radius - 5 * px))
    ctx.lineTo(cx + Math.cos(angle) * (radius + 5 * px), cy + Math.sin(angle) * (radius + 5 * px))
  }
  ctx.stroke()

  if (tier === 'green') {
    ctx.shadowColor = '#00ff88'
    ctx.shadowBlur = 12 * px
  }
  ctx.strokeStyle = TIER_SOLID[tier]
  ctx.lineWidth = 3.5 * px
  ctx.beginPath()
  ctx.arc(cx, cy, radius, start, start + (clamp(shown, 0, 100) / 100) * Math.PI * 2)
  ctx.stroke()
  if (flash > 0) {
    ctx.save()
    ctx.globalAlpha *= flash
    ctx.lineWidth = 2 * px
    ctx.beginPath()
    ctx.arc(cx, cy, radius + (1 - flash) * 16 * px, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
  ctx.shadowBlur = 0

  ctx.fillStyle = '#eafcff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${12 * px}px ${MONO}`
  ctx.fillText(`${percent}`, cx, cy + 0.5 * px)

  const textX = cx + side * (radius + 10 * px)
  const boxX = side === 1 ? textX - 5 * px : textX - labelWidth - 5 * px
  ctx.fillStyle = 'rgba(4, 10, 20, 0.62)'
  ctx.fillRect(boxX, cy - 9 * px, labelWidth + 10 * px, 18 * px)
  ctx.fillStyle = TIER_SOLID[tier]
  ctx.textAlign = side === 1 ? 'left' : 'right'
  ctx.font = `700 ${10.5 * px}px ${MONO}`
  ctx.fillText(label, textX, cy + 0.5 * px)
  ctx.restore()
}

interface HoloRuntime {
  feed: HoloFeed | null
  gesture: GestureId | null
  frameTimestamp: number
  match: PoseMatch | null
  anchorX: number | null
  shown: number
  locked: boolean
  flash: number
  lastBlipAt: number
  visibility: number
  dirty: boolean
}

/**
 * Holographic ghost of the pose the current phase expects, placed over the
 * player's calibrated body, with a live SYNC gauge from vector matching.
 * Drawn on its own unmirrored canvas beneath the player's skeleton layer.
 */
export function HoloGuideCanvas({ videoRef, feedRef, active, onLock }: HoloGuideCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onLockRef = useRef(onLock)

  useEffect(() => { onLockRef.current = onLock }, [onLock])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!active || !canvas || !context) return

    const viewport = createCoverViewport()
    const measure = () => measureCoverViewport(canvas, viewport)
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)

    const state: HoloRuntime = {
      feed: null,
      gesture: null,
      frameTimestamp: -1,
      match: null,
      anchorX: null,
      shown: 0,
      locked: false,
      flash: 0,
      lastBlipAt: -Infinity,
      visibility: 0,
      dirty: false,
    }

    let frameId = 0
    let last = performance.now()
    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick)
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now
      if (syncCanvasToVideo(canvas, videoRef.current)) measure()
      const { width, height } = canvas

      const feed = feedRef.current
      if (feed) state.feed = feed
      state.visibility += ((feed ? 1 : 0) - state.visibility) * ease(dt, feed ? 6 : 4)
      const current = state.feed
      if (!current || state.visibility < 0.01) {
        if (state.dirty) context.clearRect(0, 0, width, height)
        state.dirty = false
        return
      }

      const template = POSE_TEMPLATES[current.gesture]
      if (current.gesture !== state.gesture) {
        state.gesture = current.gesture
        state.shown = 0
        state.locked = false
        state.flash = 0
        state.match = null
      }
      if (feed && feed.frame.timestamp !== state.frameTimestamp) {
        state.frameTimestamp = feed.frame.timestamp
        state.match = matchFrame(feed.frame, current.gesture, feed.laser)
        const leftHip = feed.frame.landmarks[PoseIndex.LEFT_HIP]
        const rightHip = feed.frame.landmarks[PoseIndex.RIGHT_HIP]
        if (leftHip && rightHip) {
          const hipX = 1 - (leftHip.x + rightHip.x) / 2
          state.anchorX = state.anchorX === null ? hipX : state.anchorX + (hipX - state.anchorX) * 0.25
        }
      }
      const match = state.match
      if (!match || state.anchorX === null) return

      state.shown += (match.score - state.shown) * ease(dt, 8)
      if (!state.locked && state.shown >= LOCK_AT) {
        state.locked = true
        state.flash = 1
        if (now - state.lastBlipAt > BLIP_COOLDOWN_MS) {
          state.lastBlipAt = now
          onLockRef.current?.()
        }
      } else if (state.locked && state.shown < UNLOCK_BELOW) {
        state.locked = false
      }
      state.flash = Math.max(0, state.flash - dt * 2.2)

      const { baseline } = current
      const torsoHeight = baseline.hipY - baseline.shoulderY
      const unit = (torsoHeight * height) / TEMPLATE_TORSO
      const originX = state.anchorX * width
      const originY = (baseline.shoulderY + (CHEST_BELOW_SHOULDERS + ghostDrop(template, current.laser)) * torsoHeight) * height
      const joints = {} as Record<TemplateJoint, Projected>
      for (const name of JOINT_NAMES) joints[name] = project(template.joints[name], originX, originY, unit)

      const { px, bounds } = viewport
      const tier = tierFor(state.shown, state.locked)
      state.dirty = true
      context.clearRect(0, 0, width, height)
      context.save()
      context.globalAlpha = state.visibility * (0.92 + 0.08 * Math.sin(now * 0.013))
      drawGhost(context, joints, match, tier, unit, now, px)
      if (state.locked) drawLockBrackets(context, joints, unit, state.flash, px)
      const head = joints.nose
      drawSyncGauge(context, head.x, head.y - 0.03 * unit, 0.16 * unit, template.gaugeSide, state.shown, tier, state.locked, state.flash, bounds, px)
      context.restore()
    }
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
      context.setLineDash([])
      context.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [active, feedRef, videoRef])

  return <canvas ref={canvasRef} className="holo-canvas" aria-hidden="true" />
}
