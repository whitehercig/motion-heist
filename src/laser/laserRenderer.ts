import type { ViewBounds } from '../render/coverViewport'

/**
 * Canvas 2D primitives for the DUCK UNDER LASER beam. Every size is given in
 * CSS pixels and multiplied by `px` (canvas pixels per CSS pixel), so the
 * overlay looks identical however the object-fit: cover video is scaled.
 */

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  alpha: number
  life: number
  maxLife: number
  green: boolean
}

export interface BeamStyle {
  y: number
  bounds: ViewBounds
  /** 0..1 sweep-in of the beam while it arms. */
  reveal: number
  breach: boolean
  /** 0 = neon red, 1 = emerald green. */
  clearMix: number
  alpha: number
  t: number
  px: number
}

const MAX_PARTICLES = 260
const GRAVITY = 980
const MONO = '"SFMono-Regular", Consolas, monospace'
const RED: [number, number, number] = [255, 0, 51]
const GREEN: [number, number, number] = [0, 255, 136]

const mixColor = (mix: number) => RED.map((channel, index) => Math.round(channel + (GREEN[index] - channel) * mix))

export const spawnSparks = (particles: Particle[], x: number, y: number, px: number, count: number, green = false) => {
  for (let i = 0; i < count && particles.length < MAX_PARTICLES; i += 1) {
    const angle = Math.random() * Math.PI * 2
    const speed = (140 + Math.random() * 340) * px
    const life = 0.28 + Math.random() * 0.42
    particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 120 * px, alpha: 1, life, maxLife: life, green })
  }
}

/** In-place update with swap-remove, so the pool never reallocates mid-game. */
export const updateParticles = (particles: Particle[], dt: number, px: number) => {
  const drag = Math.max(0, 1 - 1.8 * dt)
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const particle = particles[i]
    particle.life -= dt
    if (particle.life <= 0) {
      particles[i] = particles[particles.length - 1]
      particles.pop()
      continue
    }
    particle.vy += GRAVITY * px * dt
    particle.vx *= drag
    particle.x += particle.vx * dt
    particle.y += particle.vy * dt
    particle.alpha = particle.life / particle.maxLife
  }
}

export const drawParticles = (ctx: CanvasRenderingContext2D, particles: Particle[], px: number) => {
  if (!particles.length) return
  ctx.save()
  // Additive blending gives the glow without the cost of per-spark shadowBlur.
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineWidth = 2 * px
  for (const particle of particles) {
    const a = particle.alpha
    ctx.strokeStyle = particle.green
      ? `rgba(120, 255, 190, ${a})`
      : `rgba(255, ${Math.round(150 + 105 * a)}, ${Math.round(90 * a)}, ${a})`
    ctx.beginPath()
    ctx.moveTo(particle.x - particle.vx * 0.028, particle.y - particle.vy * 0.028)
    ctx.lineTo(particle.x, particle.y)
    ctx.stroke()
  }
  ctx.restore()
}

export const drawBeam = (ctx: CanvasRenderingContext2D, style: BeamStyle) => {
  const { y, bounds, px, t } = style
  const start = bounds.left
  const end = bounds.left + (bounds.right - bounds.left) * style.reveal
  let color: string
  ctx.save()
  ctx.globalAlpha = style.alpha
  ctx.lineCap = 'round'
  if (style.breach) {
    color = '#ff1100'
    ctx.strokeStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 30 * px
    ctx.lineWidth = (6 + Math.sin(t * 0.028) * 1.6) * px
  } else {
    const [r, g, b] = mixColor(style.clearMix)
    color = `rgb(${r}, ${g}, ${b})`
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`
    ctx.shadowColor = style.clearMix > 0 ? color : '#ff0033'
    ctx.shadowBlur = (15 + style.clearMix * 6) * px
    ctx.lineWidth = 3 * px
  }
  ctx.beginPath()
  ctx.moveTo(start, y)
  ctx.lineTo(end, y)
  ctx.stroke()

  // Hot core: a thin bright filament without shadow sells the neon look cheaply.
  ctx.shadowBlur = 0
  ctx.lineWidth = (style.breach ? 1.6 : 1) * px
  ctx.strokeStyle = style.breach ? 'rgba(255, 226, 205, 0.9)' : 'rgba(255, 255, 255, 0.7)'
  ctx.stroke()

  // Emitter housings at the visible edges of the frame.
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 10 * px
  ctx.fillRect(start, y - 9 * px, 7 * px, 18 * px)
  if (style.reveal >= 1) ctx.fillRect(bounds.right - 7 * px, y - 9 * px, 7 * px, 18 * px)
  else {
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(end, y, 4.5 * px, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

export const drawJointAlarm = (ctx: CanvasRenderingContext2D, x: number, y: number, t: number, px: number) => {
  const blink = 0.5 + 0.5 * Math.sin(t * 0.02)
  const radius = 14 * px
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, `rgba(255, 90, 70, ${0.35 + 0.6 * blink})`)
  gradient.addColorStop(0.55, `rgba(255, 0, 34, ${0.2 + 0.35 * blink})`)
  gradient.addColorStop(1, 'rgba(255, 0, 34, 0)')
  ctx.save()
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = `rgba(255, 60, 60, ${0.45 + 0.55 * blink})`
  ctx.lineWidth = 2 * px
  ctx.stroke()
  ctx.restore()
}

const chevron = (ctx: CanvasRenderingContext2D, x: number, tipY: number, px: number) => {
  ctx.beginPath()
  ctx.moveTo(x, tipY)
  ctx.lineTo(x - 11 * px, tipY - 15 * px)
  ctx.lineTo(x, tipY - 9 * px)
  ctx.lineTo(x + 11 * px, tipY - 15 * px)
  ctx.closePath()
  ctx.fill()
}

/** Strictly vertical correction vector from the offending joint to just below the beam. */
export const drawCorrectionArrow = (ctx: CanvasRenderingContext2D, x: number, fromY: number, toY: number, t: number, px: number) => {
  const tip = Math.max(toY, fromY + 34 * px) + Math.sin(t * 0.012) * 4 * px
  ctx.save()
  ctx.strokeStyle = '#ff3b30'
  ctx.fillStyle = '#ff3b30'
  ctx.shadowColor = '#ff1100'
  ctx.shadowBlur = 10 * px
  ctx.lineWidth = 2.5 * px
  ctx.setLineDash([8 * px, 6 * px])
  ctx.lineDashOffset = -t * 0.05 * px
  ctx.beginPath()
  ctx.moveTo(x, fromY)
  ctx.lineTo(x, tip - 9 * px)
  ctx.stroke()
  ctx.setLineDash([])
  chevron(ctx, x, tip, px)
  ctx.globalAlpha = 0.45
  chevron(ctx, x, tip - 12 * px, px)
  ctx.restore()
}

/** Two-line callout next to the arrow, kept inside the visible (cover-cropped) region. */
export const drawCorrectionLabel = (
  ctx: CanvasRenderingContext2D,
  headline: string,
  measures: string,
  anchorX: number,
  anchorY: number,
  bounds: ViewBounds,
  px: number,
) => {
  const pad = 9 * px
  ctx.save()
  ctx.font = `700 ${14 * px}px ${MONO}`
  const headWidth = ctx.measureText(headline).width
  ctx.font = `600 ${10.5 * px}px ${MONO}`
  const measureWidth = ctx.measureText(measures).width
  const width = Math.max(headWidth, measureWidth) + pad * 2 + 3 * px
  const height = 44 * px
  let x = anchorX + 20 * px
  if (x + width > bounds.right - 6 * px) x = anchorX - 20 * px - width
  x = Math.max(bounds.left + 6 * px, Math.min(x, bounds.right - 6 * px - width))
  const y = Math.max(bounds.top + 6 * px, Math.min(anchorY - height / 2, bounds.bottom - 6 * px - height))

  ctx.fillStyle = 'rgba(42, 4, 10, 0.86)'
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = '#ff3b30'
  ctx.fillRect(x, y, 3 * px, height)
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#fff1ef'
  ctx.font = `700 ${14 * px}px ${MONO}`
  ctx.fillText(headline, x + 3 * px + pad, y + 7 * px)
  ctx.fillStyle = '#ffb3ac'
  ctx.font = `600 ${10.5 * px}px ${MONO}`
  ctx.fillText(measures, x + 3 * px + pad, y + 26 * px)
  ctx.restore()
}

/** Desk mode's virtual head-and-chest collider, so the player can see what must pass under the beam. */
export const drawColliderMarker = (ctx: CanvasRenderingContext2D, x: number, y: number, px: number) => {
  const size = 8 * px
  ctx.save()
  ctx.strokeStyle = 'rgba(64, 232, 214, 0.9)'
  ctx.lineWidth = 1.5 * px
  ctx.beginPath()
  ctx.moveTo(x, y - size)
  ctx.lineTo(x + size, y)
  ctx.lineTo(x, y + size)
  ctx.lineTo(x - size, y)
  ctx.closePath()
  ctx.moveTo(x - size * 1.8, y)
  ctx.lineTo(x + size * 1.8, y)
  ctx.stroke()
  ctx.restore()
}

export const drawBeamStatus = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, alpha: number, size: number, px: number) => {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `800 ${size * px}px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = '#00ff88'
  ctx.shadowColor = '#00ff88'
  ctx.shadowBlur = 16 * px
  ctx.fillText(text, x, y)
  ctx.restore()
}
