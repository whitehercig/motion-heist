import { POSE_TEMPLATES, TEMPLATE_TORSO } from '../motion/poseTemplates'
import type { GestureId, TemplateJoint, TemplatePoint } from '../types/game'

/** Arcade obstacle drawn around the figure, so the icon says what to dodge. */
export type GlyphDecor = 'beam' | 'wallLeft' | 'wallRight' | 'diamond' | 'light' | 'handsUp'

interface PoseGlyphProps {
  gesture: GestureId
  decor?: GlyphDecor
  size?: number
  className?: string
}

const NEUTRAL = POSE_TEMPLATES.FREEZE.joints
const BONES: Array<[TemplateJoint, TemplateJoint]> = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
]

interface Figure {
  joints: Record<TemplateJoint, TemplatePoint>
  /** Knee and ankle per side; the templates only describe the upper body. */
  legs: Array<[TemplatePoint, TemplatePoint, TemplatePoint]>
}

const p = (x: number, y: number): TemplatePoint => ({ x, y, z: 0 })

const shift = (joints: Record<TemplateJoint, TemplatePoint>, dy: number) =>
  Object.fromEntries(Object.entries(joints).map(([name, point]) => [name, p(point.x, point.y + dy)])) as Record<TemplateJoint, TemplatePoint>

/** Both hands above the head: the menu gesture (replay / continue). */
const handsUp = (): Record<TemplateJoint, TemplatePoint> => ({
  ...NEUTRAL,
  leftElbow: p(-0.3, -0.3),
  rightElbow: p(0.3, -0.3),
  leftWrist: p(-0.26, -0.58),
  rightWrist: p(0.26, -0.58),
})

const figureFor = (gesture: GestureId, decor?: GlyphDecor): Figure => {
  if (decor === 'handsUp') return { ...figureFor('FREEZE'), joints: handsUp() }
  const template = POSE_TEMPLATES[gesture]
  const drop = template.anchorDrop * TEMPLATE_TORSO
  const joints = drop ? shift(template.joints, drop) : template.joints
  const leftHip = joints.leftHip
  const rightHip = joints.rightHip
  if (drop) {
    // Squat: knees push forward and out, feet stay on the floor.
    return { joints, legs: [[leftHip, p(leftHip.x - 0.16, 0.66), p(-0.13, 0.9)], [rightHip, p(rightHip.x + 0.16, 0.66), p(0.13, 0.9)]] }
  }
  // Standing (leans bend at the hips; the legs stay planted).
  return { joints, legs: [[leftHip, p(-0.12, 0.62), p(-0.13, 0.9)], [rightHip, p(0.12, 0.62), p(0.13, 0.9)]] }
}

const line = (a: TemplatePoint, b: TemplatePoint, key: string, className: string) => (
  <line key={key} className={className} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
)

function Stick({ figure, className }: { figure: Figure; className: string }) {
  const { joints } = figure
  const head = joints.nose
  const neck = p((joints.leftShoulder.x + joints.rightShoulder.x) / 2, (joints.leftShoulder.y + joints.rightShoulder.y) / 2)
  return (
    <g className={className}>
      {BONES.map(([from, to]) => line(joints[from], joints[to], `${from}-${to}`, 'bone'))}
      {figure.legs.map(([hip, knee, ankle], index) => (
        <g key={index}>{line(hip, knee, 'thigh', 'bone')}{line(knee, ankle, 'shin', 'bone')}</g>
      ))}
      {line(neck, p(head.x, head.y + 0.08), 'neck', 'bone')}
      <circle className="head" cx={head.x} cy={head.y - 0.02} r={0.085} />
      <circle className="hand" cx={joints.leftWrist.x} cy={joints.leftWrist.y} r={0.03} />
      <circle className="hand" cx={joints.rightWrist.x} cy={joints.rightWrist.y} r={0.03} />
    </g>
  )
}

function Decor({ decor }: { decor: GlyphDecor }) {
  switch (decor) {
    case 'beam':
      return <line className="decor-beam" x1={-0.6} y1={-0.42} x2={0.6} y2={-0.42} />
    case 'wallLeft':
      return <g className="decor-wall">{[-0.58, -0.5, -0.42, -0.34, -0.26, -0.18, -0.1, -0.02].map((x) => <line key={x} x1={x} y1={-0.62} x2={x} y2={0.92} />)}</g>
    case 'wallRight':
      return <g className="decor-wall">{[0.58, 0.5, 0.42, 0.34, 0.26, 0.18, 0.1, 0.02].map((x) => <line key={x} x1={x} y1={-0.62} x2={x} y2={0.92} />)}</g>
    case 'diamond':
      return <polygon className="decor-diamond" points="0.38,-0.62 0.46,-0.52 0.38,-0.4 0.3,-0.52" />
    case 'light':
      return <polygon className="decor-light" points="-0.05,-0.62 0.05,-0.62 0.5,0.92 -0.5,0.92" />
    case 'handsUp':
      return null
  }
}

/**
 * Stick figure built from the same pose templates the SYNC matcher uses, so
 * the move list can never drift from what the game actually checks. A faint
 * neutral stance sits behind the target pose; CSS pulses between them.
 */
export function PoseGlyph({ gesture, decor, size = 120, className = '' }: PoseGlyphProps) {
  const target = figureFor(gesture, decor)
  const neutral = figureFor('FREEZE')
  const pose = decor === 'wallLeft' ? figureFor('LEAN_RIGHT') : decor === 'wallRight' ? figureFor('LEAN_LEFT') : target
  return (
    <svg className={`pose-glyph ${className}`} viewBox="-0.62 -0.66 1.24 1.62" width={size} height={size * 1.3} aria-hidden="true">
      {decor && <Decor decor={decor} />}
      {gesture !== 'FREEZE' && <Stick figure={neutral} className="stick-neutral" />}
      <Stick figure={pose} className="stick-target" />
    </svg>
  )
}
