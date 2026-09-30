import { useEffect, useRef, type RefObject } from 'react'
import { t } from '../i18n/i18n'
import { createCoverViewport, measureCoverViewport, syncCanvasToVideo } from '../render/coverViewport'
import type { VaultReading } from '../types/game'

interface VaultDoorsOverlayProps {
  videoRef: RefObject<HTMLVideoElement | null>
  feedRef: RefObject<VaultReading | null>
  /** Fired when sprung-back doors hit the closed position; strength is 0..1. */
  onImpact?: (strength: number) => void
}

const MONO = '"SFMono-Regular", Consolas, monospace'
const CYAN = '#3ff0ff'

/**
 * Spring presets. Tracking is critically damped and stiff so the doors sit on
 * the player's hands with ~30 ms of lag; release is under-damped so the doors
 * slam and rebound; the breach glides open with a heavy overshoot.
 */
const SPRINGS = {
  track: { stiffness: 900, damping: 60 },
  release: { stiffness: 420, damping: 9 },
  breach: { stiffness: 55, damping: 9 },
} as const

interface DoorPhysics {
  open: number
  velocity: number
  shake: number
}

/** Brushed steel, recessed panels, rivets, hazard stripes along the seam, half a lock wheel. Built once per size. */
const buildDoorTexture = (width: number, height: number, px: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const base = ctx.createLinearGradient(0, 0, width, height)
  base.addColorStop(0, '#232931')
  base.addColorStop(0.5, '#3f4955')
  base.addColorStop(1, '#1d232b')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, width, height)

  for (let y = 0; y < height; y += 2 * px) {
    ctx.fillStyle = Math.random() > 0.5 ? `rgba(255, 255, 255, ${Math.random() * 0.045})` : `rgba(0, 0, 0, ${Math.random() * 0.08})`
    ctx.fillRect(0, y, width, px)
  }

  const panel = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = 'rgba(8, 12, 18, 0.28)'
    ctx.fillRect(x, y, w, h)
    ctx.lineWidth = 2 * px
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
    ctx.beginPath()
    ctx.moveTo(x, y + h)
    ctx.lineTo(x, y)
    ctx.lineTo(x + w, y)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.beginPath()
    ctx.moveTo(x + w, y)
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x, y + h)
    ctx.stroke()
  }
  const stripe = 30 * px
  panel(width * 0.1, height * 0.08, width * 0.72 - stripe, height * 0.36)
  panel(width * 0.1, height * 0.56, width * 0.72 - stripe, height * 0.3)

  const rivet = (x: number, y: number) => {
    const gradient = ctx.createRadialGradient(x - 1.5 * px, y - 1.5 * px, 0, x, y, 4.5 * px)
    gradient.addColorStop(0, '#aab6c3')
    gradient.addColorStop(1, '#161b22')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, 4 * px, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let y = 22 * px; y < height - 10 * px; y += 46 * px) {
    rivet(14 * px, y)
    rivet(width - stripe - 14 * px, y)
  }

  // Hazard stripes along the seam and across the foot of the door.
  const hazard = (x: number, y: number, w: number, h: number) => {
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    ctx.fillStyle = '#111'
    ctx.fillRect(x, y, w, h)
    ctx.fillStyle = '#e9b10a'
    const band = 16 * px
    for (let offset = -h - w; offset < w + h; offset += band * 2) {
      ctx.beginPath()
      ctx.moveTo(x + offset, y + h)
      ctx.lineTo(x + offset + band, y + h)
      ctx.lineTo(x + offset + band + h, y)
      ctx.lineTo(x + offset + h, y)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }
  hazard(width - stripe, 0, stripe, height)
  hazard(0, height - 22 * px, width - stripe, 22 * px)

  // Half of the central lock wheel; the mirrored right door completes it.
  const cx = width
  const cy = height * 0.47
  const radius = Math.min(height * 0.16, width * 0.42)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, width - stripe * 0.5, height)
  ctx.clip()
  ctx.lineWidth = 9 * px
  ctx.strokeStyle = '#59636f'
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 3 * px
  ctx.strokeStyle = '#1a1f26'
  ctx.beginPath()
  ctx.arc(cx, cy, radius * 0.62, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 6 * px
  ctx.strokeStyle = '#4c5561'
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * radius * 0.2, cy + Math.sin(angle) * radius * 0.2)
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
    ctx.stroke()
  }
  ctx.restore()

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.fillRect(width - 3 * px, 0, 3 * px, height)
  return canvas
}

const stepSpring = (door: DoorPhysics, target: number, spring: { stiffness: number; damping: number }, dt: number) => {
  // Semi-implicit Euler in fixed sub-steps stays stable for the stiff tracking spring.
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
  const h = dt / steps
  let impact = 0
  for (let i = 0; i < steps; i += 1) {
    door.velocity += (spring.stiffness * (target - door.open) - spring.damping * door.velocity) * h
    door.open += door.velocity * h
    if (door.open < 0) {
      // The frame stops the doors: bounce back with some energy lost.
      impact = Math.max(impact, -door.velocity)
      door.open = 0
      door.velocity = -door.velocity * 0.35
    }
  }
  return impact
}

/**
 * Massive steel vault doors drawn over the camera. Their opening follows the
 * player's wrist spread through a spring, and the palm scanners, wrist cursors
 * and tethers are drawn on top so the player always sees their hands.
 */
export function VaultDoorsOverlay({ videoRef, feedRef, onImpact }: VaultDoorsOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onImpactRef = useRef(onImpact)

  useEffect(() => { onImpactRef.current = onImpact }, [onImpact])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const viewport = createCoverViewport()
    const measure = () => measureCoverViewport(canvas, viewport)
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)

    const door: DoorPhysics = { open: 0, velocity: 0, shake: 0 }
    let texture: HTMLCanvasElement | null = null
    let textureKey = ''
    let frameId = 0
    let last = performance.now()

    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick)
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now
      if (syncCanvasToVideo(canvas, videoRef.current)) measure()
      const { width, height } = canvas
      const { px, bounds } = viewport
      const doorWidth = (bounds.right - bounds.left) / 2
      const doorHeight = bounds.bottom - bounds.top
      if (doorWidth <= 0 || doorHeight <= 0) return

      const key = `${Math.round(doorWidth)}x${Math.round(doorHeight)}`
      if (key !== textureKey) {
        texture = buildDoorTexture(doorWidth, doorHeight, px)
        textureKey = key
      }

      const reading = feedRef.current
      const phase = reading?.phase ?? 'align'
      const target = phase === 'breached' ? 1.05 : phase === 'breaching' ? reading?.breachProgress ?? 0 : 0
      const spring = phase === 'breached' ? SPRINGS.breach : phase === 'breaching' ? SPRINGS.track : SPRINGS.release
      const impact = stepSpring(door, target, spring, dt)
      if (impact > 0.6) {
        door.shake = Math.min(1, impact / 4)
        onImpactRef.current?.(door.shake)
      }
      door.shake = Math.max(0, door.shake - dt * 3.5)

      const shakeX = (Math.random() - 0.5) * 16 * px * door.shake
      const shakeY = (Math.random() - 0.5) * 8 * px * door.shake
      const seam = (bounds.left + bounds.right) / 2
      const slide = Math.max(0, door.open) * (doorWidth + 12 * px)

      context.clearRect(0, 0, width, height)
      context.save()
      context.translate(shakeX, shakeY)

      // Light spilling out of the vault through the gap.
      if (slide > 1) {
        const glow = context.createLinearGradient(seam - slide, 0, seam + slide, 0)
        glow.addColorStop(0, 'rgba(255, 196, 92, 0.55)')
        glow.addColorStop(0.5, `rgba(255, 226, 150, ${0.08 + 0.2 * Math.min(1, door.open)})`)
        glow.addColorStop(1, 'rgba(255, 196, 92, 0.55)')
        context.fillStyle = glow
        context.fillRect(seam - slide, bounds.top, slide * 2, doorHeight)
      }

      if (texture) {
        context.globalAlpha = 0.96
        context.drawImage(texture, seam - doorWidth - slide, bounds.top)
        context.save()
        context.translate(seam + slide + doorWidth, bounds.top)
        context.scale(-1, 1)
        context.drawImage(texture, 0, 0)
        context.restore()
        context.globalAlpha = 1
      }

      if (reading) {
        drawScanners(context, reading, width, height, now, px)
        if (phase === 'breaching') drawTethers(context, reading, width, height, seam, slide, px, now)
        drawCursors(context, reading, width, height, px)
        if (phase === 'breaching' || phase === 'locking') drawReadout(context, reading, seam, bounds.bottom - 60 * px, px)
      }
      context.restore()
    }
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
      context.setLineDash([])
      context.clearRect(0, 0, canvas.width, canvas.height)
      texture = null
    }
  }, [feedRef, videoRef])

  return <canvas ref={canvasRef} className="vault-canvas" aria-hidden="true" />
}

const drawScanners = (ctx: CanvasRenderingContext2D, reading: VaultReading, width: number, height: number, t: number, px: number) => {
  if (reading.phase === 'breaching' || reading.phase === 'breached') return
  const radius = reading.radius * width
  reading.targets.forEach((target, index) => {
    const x = target.x * width
    const y = target.y * height
    ctx.save()
    const fill = ctx.createRadialGradient(x, y, 0, x, y, radius)
    fill.addColorStop(0, target.engaged ? 'rgba(63, 240, 255, 0.45)' : 'rgba(63, 240, 255, 0.16)')
    fill.addColorStop(1, 'rgba(63, 240, 255, 0)')
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = target.engaged ? CYAN : 'rgba(63, 240, 255, 0.6)'
    ctx.shadowColor = CYAN
    ctx.shadowBlur = (target.engaged ? 16 : 6) * px
    ctx.lineWidth = 2 * px
    ctx.setLineDash([7 * px, 6 * px])
    ctx.lineDashOffset = (index === 0 ? -1 : 1) * t * 0.03 * px
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(x, y, radius * 0.35, 0, Math.PI * 2)
    ctx.moveTo(x - radius * 0.55, y)
    ctx.lineTo(x + radius * 0.55, y)
    ctx.moveTo(x, y - radius * 0.55)
    ctx.lineTo(x, y + radius * 0.55)
    ctx.stroke()

    if (reading.lockProgress > 0) {
      ctx.lineWidth = 5 * px
      ctx.strokeStyle = '#eaffff'
      ctx.beginPath()
      ctx.arc(x, y, radius + 7 * px, -Math.PI / 2, -Math.PI / 2 + reading.lockProgress * Math.PI * 2)
      ctx.stroke()
    }
    ctx.shadowBlur = 0
    ctx.fillStyle = 'rgba(220, 252, 255, 0.85)'
    ctx.font = `700 ${10 * px}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.fillText(index === 0 ? 'L · PALM SCAN' : 'R · PALM SCAN', x, y + radius + 18 * px)
    ctx.restore()
  })
}

const drawTethers = (
  ctx: CanvasRenderingContext2D,
  reading: VaultReading,
  width: number,
  height: number,
  seam: number,
  slide: number,
  px: number,
  t: number,
) => {
  ctx.save()
  ctx.strokeStyle = 'rgba(63, 240, 255, 0.75)'
  ctx.shadowColor = CYAN
  ctx.shadowBlur = 10 * px
  ctx.lineWidth = 2 * px
  ctx.setLineDash([10 * px, 6 * px])
  ctx.lineDashOffset = -t * 0.08 * px
  reading.wrists.forEach((wrist, index) => {
    const x = wrist.x * width
    const y = wrist.y * height
    // Each hand is visibly "holding" the inner edge of its own door.
    const edge = index === 0 ? seam - slide : seam + slide
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(edge, y)
    ctx.stroke()
  })
  ctx.restore()
}

const drawCursors = (ctx: CanvasRenderingContext2D, reading: VaultReading, width: number, height: number, px: number) => {
  ctx.save()
  reading.wrists.forEach((wrist, index) => {
    if (!wrist.tracked && reading.phase !== 'breaching') return
    const x = wrist.x * width
    const y = wrist.y * height
    const engaged = reading.phase === 'breaching' || reading.targets[index].engaged
    ctx.shadowColor = CYAN
    ctx.shadowBlur = 14 * px
    ctx.fillStyle = engaged ? CYAN : 'rgba(63, 240, 255, 0.35)'
    ctx.strokeStyle = '#eaffff'
    ctx.lineWidth = 2 * px
    ctx.beginPath()
    ctx.arc(x, y, 9 * px, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  })
  ctx.restore()
}

const drawReadout = (ctx: CanvasRenderingContext2D, reading: VaultReading, seam: number, y: number, px: number) => {
  const breaching = reading.phase === 'breaching'
  const value = breaching ? reading.breachProgress : reading.lockProgress
  const label = t(breaching ? 'vault.breachMeter' : 'vault.chargeMeter', { n: Math.round(value * 100) })
  const barWidth = 220 * px
  ctx.save()
  ctx.fillStyle = 'rgba(3, 8, 14, 0.78)'
  ctx.fillRect(seam - barWidth / 2 - 10 * px, y - 24 * px, barWidth + 20 * px, 42 * px)
  ctx.fillStyle = 'rgba(210, 240, 255, 0.18)'
  ctx.fillRect(seam - barWidth / 2, y + 6 * px, barWidth, 5 * px)
  ctx.fillStyle = breaching ? '#ffc45c' : CYAN
  ctx.shadowColor = ctx.fillStyle
  ctx.shadowBlur = 10 * px
  ctx.fillRect(seam - barWidth / 2, y + 6 * px, barWidth * value, 5 * px)
  ctx.shadowBlur = 0
  ctx.fillStyle = '#eafcff'
  ctx.font = `700 ${12 * px}px ${MONO}`
  ctx.textAlign = 'center'
  ctx.fillText(label, seam, y - 4 * px)
  ctx.restore()
}
