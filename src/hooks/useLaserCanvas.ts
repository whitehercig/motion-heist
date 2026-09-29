import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { laserCorrectionParts } from '../errors/errorAnalyzer'
import {
  drawBeam,
  drawBeamStatus,
  drawColliderMarker,
  drawCorrectionArrow,
  drawCorrectionLabel,
  drawJointAlarm,
  drawParticles,
  spawnSparks,
  updateParticles,
  type Particle,
} from '../laser/laserRenderer'
import { clamp } from '../motion/geometry'
import { createCoverViewport, measureCoverViewport, syncCanvasToVideo } from '../render/coverViewport'
import type { LaserReading } from '../types/game'

/** The beam sweeps in before it can hurt you, so a player standing between phases isn't zapped instantly. */
const ARM_MS = 650
const ZAP_COOLDOWN_MS = 350
const EMIT_INTERVAL_MS = 140
const CLEARED_HOLD_MS = 1100
const CLEARED_FADE_MS = 450

interface SparkBurst {
  x: number
  y: number
  count: number
  green: boolean
}

interface LaserRuntime {
  reading: LaserReading | null
  holdProgress: number
  clearMix: number
  shownSince: number | null
  breached: boolean
  lastZapAt: number
  lastEmitAt: number
  clearedAt: number | null
  clearedBeamY: number
  particles: Particle[]
  pendingBursts: SparkBurst[]
  dirty: boolean
}

const createRuntime = (): LaserRuntime => ({
  reading: null,
  holdProgress: 0,
  clearMix: 0,
  shownSince: null,
  breached: false,
  lastZapAt: -Infinity,
  lastEmitAt: 0,
  clearedAt: null,
  clearedBeamY: 0,
  particles: [],
  pendingBursts: [],
  dirty: false,
})

export interface LaserController {
  /** Feed the latest collision reading (null hides the beam). holdProgress is 0..1 while the pose is valid. */
  update: (reading: LaserReading | null, holdProgress: number) => void
  /** Latch the BEAM CLEARED state; it outlives the phase change that follows success. */
  clear: () => void
  reset: () => void
}

interface UseLaserCanvasOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  active: boolean
  onBreach?: () => void
}

/**
 * Diegetic laser overlay. Collision state arrives at pose-inference rate via
 * the controller; the canvas animates independently at display rate. No React
 * state is touched per frame.
 */
export const useLaserCanvas = ({ canvasRef, videoRef, active, onBreach }: UseLaserCanvasOptions): LaserController => {
  const runtimeRef = useRef<LaserRuntime>(createRuntime())
  const onBreachRef = useRef(onBreach)

  useEffect(() => { onBreachRef.current = onBreach }, [onBreach])

  const controller = useMemo<LaserController>(() => ({
    update(reading, holdProgress) {
      const runtime = runtimeRef.current
      if (runtime.clearedAt !== null) return
      if (!reading) {
        runtime.reading = null
        runtime.shownSince = null
        runtime.breached = false
        return
      }
      const now = performance.now()
      runtime.shownSince ??= now
      const breached = now - runtime.shownSince >= ARM_MS && reading.breached
      if (breached && !runtime.breached) {
        for (const joint of reading.joints) {
          if (joint.breaching) runtime.pendingBursts.push({ x: joint.x, y: reading.beamY, count: 12 + Math.floor(Math.random() * 5), green: false })
        }
        if (now - runtime.lastZapAt > ZAP_COOLDOWN_MS) {
          runtime.lastZapAt = now
          onBreachRef.current?.()
        }
      }
      runtime.breached = breached
      runtime.reading = reading
      runtime.holdProgress = breached ? 0 : holdProgress
    },
    clear() {
      const runtime = runtimeRef.current
      if (!runtime.reading || runtime.clearedAt !== null) return
      runtime.clearedAt = performance.now()
      runtime.clearedBeamY = runtime.reading.beamY
      runtime.breached = false
      for (let i = 0; i < 6; i += 1) {
        runtime.pendingBursts.push({ x: 0.2 + i * 0.12, y: runtime.reading.beamY, count: 6, green: true })
      }
    },
    reset() {
      runtimeRef.current = createRuntime()
    },
  }), [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!active || !canvas || !context) return

    const viewport = createCoverViewport()
    const { bounds } = viewport
    const measure = () => measureCoverViewport(canvas, viewport)
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)

    let frameId = 0
    let last = performance.now()
    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick)
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now

      if (syncCanvasToVideo(canvas, videoRef.current)) measure()
      const px = viewport.px
      const width = canvas.width
      const height = canvas.height
      const runtime = runtimeRef.current
      if (!runtime.reading && runtime.clearedAt === null && !runtime.particles.length && !runtime.pendingBursts.length) {
        if (runtime.dirty) context.clearRect(0, 0, width, height)
        runtime.dirty = false
        return
      }
      runtime.dirty = true
      context.clearRect(0, 0, width, height)
      const centerX = (bounds.left + bounds.right) / 2

      if (runtime.clearedAt !== null) {
        const age = now - runtime.clearedAt
        if (age > CLEARED_HOLD_MS + CLEARED_FADE_MS) {
          runtime.clearedAt = null
          runtime.reading = null
          runtime.shownSince = null
          runtime.clearMix = 0
        } else {
          const alpha = age < CLEARED_HOLD_MS ? 1 : 1 - (age - CLEARED_HOLD_MS) / CLEARED_FADE_MS
          const y = runtime.clearedBeamY * height
          drawBeam(context, { y, bounds, reveal: 1, breach: false, clearMix: 1, alpha, t: now, px })
          drawBeamStatus(context, 'BEAM CLEARED', centerX, y - 16 * px, alpha, 22, px)
        }
      } else if (runtime.reading) {
        const reading = runtime.reading
        const y = reading.beamY * height
        const reveal = clamp((now - (runtime.shownSince ?? now)) / ARM_MS)
        const targetMix = runtime.breached ? 0 : runtime.holdProgress
        runtime.clearMix += (targetMix - runtime.clearMix) * Math.min(1, dt * 10)
        drawBeam(context, { y, bounds, reveal, breach: runtime.breached, clearMix: runtime.clearMix, alpha: 1, t: now, px })
        if (reading.mode === 'desk' && !runtime.breached) drawColliderMarker(context, reading.worst.x * width, reading.worst.y * height, px)

        if (runtime.breached) {
          const emit = now - runtime.lastEmitAt > EMIT_INTERVAL_MS
          if (emit) runtime.lastEmitAt = now
          for (const joint of reading.joints) {
            if (!joint.breaching) continue
            drawJointAlarm(context, joint.x * width, joint.y * height, now, px)
            if (emit) spawnSparks(runtime.particles, joint.x * width, y, px, 3)
          }
          const worstX = reading.worst.x * width
          const worstY = reading.worst.y * height
          drawCorrectionArrow(context, worstX, worstY + 18 * px, y + 28 * px, now, px)
          const [headline, measures] = laserCorrectionParts(reading)
          drawCorrectionLabel(context, headline, measures, worstX, (worstY + y) / 2, bounds, px)
        } else if (reveal >= 1 && runtime.holdProgress > 0) {
          drawBeamStatus(context, `CLEARING ${Math.round(runtime.holdProgress * 100)}%`, centerX, y - 14 * px, clamp(runtime.clearMix * 1.5), 15, px)
        }
      }

      for (const burst of runtime.pendingBursts) {
        spawnSparks(runtime.particles, burst.x * width, burst.y * height, px, burst.count, burst.green)
      }
      runtime.pendingBursts.length = 0
      updateParticles(runtime.particles, dt, px)
      drawParticles(context, runtime.particles, px)
    }
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
      context.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [active, canvasRef, videoRef])

  return controller
}
