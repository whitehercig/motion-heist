import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { announce } from '../audio/voice'
import type { SoundCue } from '../audio/useHeistAudio'
import { t } from '../i18n/i18n'
import { beamYFor } from '../laser/laserCollision'
import { drawBeam, drawParticles, spawnSparks, updateParticles, type Particle } from '../laser/laserRenderer'
import { clamp } from '../motion/geometry'
import { createCoverViewport, measureCoverViewport, syncCanvasToVideo, type CoverViewport } from '../render/coverViewport'
import { captureFrame } from '../render/wantedPoster'
import type { CalibrationBaseline, PoseFrame } from '../types/pose'
import {
  ARCADE_DURATION_MS,
  ARCADE_LIVES,
  ArcadeEngine,
  placeDiamond,
  wallEdge,
  type ArcadeEvent,
  type ArcadeOutcome,
  type ArcadeStats,
  type Grade,
} from './arcadeEngine'

export type ArcadeSink = (frame: PoseFrame | null, baseline: CalibrationBaseline | null) => void

export interface ArcadeResult {
  stats: ArcadeStats
  outcome: ArcadeOutcome
  snapshot: HTMLCanvasElement | null
  durationMs: number
}

interface ArcadeStageProps {
  videoRef: RefObject<HTMLVideoElement | null>
  /** App forwards every pose frame (with the resolved baseline) through this. */
  sinkRef: MutableRefObject<ArcadeSink | null>
  seed: number
  playerLabel?: string
  play: (cue: SoundCue) => void
  onTune: (bpm: number, intensity: number) => void
  onShake: () => void
  onFinish: (result: ArcadeResult) => void
}

interface Hud {
  score: number
  lives: number
  combo: number
  multiplier: number
  secondsLeft: number
  level: number
}

type PopupTone = 'perfect' | 'great' | 'ok' | 'bad' | 'info'

interface Popup {
  id: number
  text: string
  sub?: string
  tone: PopupTone
  x: number
  y: number
}

const MONO = '"SFMono-Regular", Consolas, monospace'
const END_DELAY_MS = 1600
const POPUP_MS = 950
const CAPTURE_GAP_MS = 1500

const TONE: Record<Grade, PopupTone> = { PERFECT: 'perfect', GREAT: 'great', OK: 'ok' }

const drawCallout = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, px: number, alpha = 1) => {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `900 ${size * px}px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const width = ctx.measureText(text).width
  ctx.fillStyle = 'rgba(4, 8, 16, 0.72)'
  ctx.fillRect(x - width / 2 - 12 * px, y - size * 0.8 * px, width + 24 * px, size * 1.6 * px)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5 * px
  ctx.strokeRect(x - width / 2 - 12 * px, y - size * 0.8 * px, width + 24 * px, size * 1.6 * px)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 12 * px
  ctx.fillText(text, x, y + 1 * px)
  ctx.restore()
}

const drawWall = (ctx: CanvasRenderingContext2D, from: number, to: number, top: number, bottom: number, intensity: number, t: number, px: number) => {
  ctx.save()
  ctx.fillStyle = `rgba(255, 0, 60, ${0.05 + 0.2 * intensity})`
  ctx.fillRect(from, top, to - from, bottom - top)
  if (intensity > 0.5) {
    ctx.strokeStyle = 'rgba(255, 40, 80, 0.85)'
    ctx.shadowColor = '#ff0033'
    ctx.shadowBlur = 14 * px
    ctx.lineWidth = 2.5 * px
    const spacing = 30 * px
    const offset = (t * 0.05 * px) % spacing
    ctx.beginPath()
    for (let x = from + offset; x < to; x += spacing) {
      ctx.moveTo(x, top)
      ctx.lineTo(x, bottom)
    }
    ctx.stroke()
  }
  ctx.restore()
}

const drawDiamond = (ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, life: number, t: number, pop: number, px: number) => {
  const size = radius * 0.75 * (0.6 + 0.4 * pop)
  ctx.save()
  ctx.translate(x, y)
  // Countdown ring: the diamond fades out when it closes.
  ctx.strokeStyle = life > 0.3 ? 'rgba(120, 255, 240, 0.8)' : 'rgba(255, 120, 120, 0.9)'
  ctx.lineWidth = 3 * px
  ctx.beginPath()
  ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * life)
  ctx.stroke()
  ctx.rotate(Math.sin(t * 0.004) * 0.3)
  const gradient = ctx.createLinearGradient(-size, -size, size, size)
  gradient.addColorStop(0, '#ffffff')
  gradient.addColorStop(0.45, '#7ffcff')
  gradient.addColorStop(1, '#2e80ff')
  ctx.fillStyle = gradient
  ctx.shadowColor = '#5ff5ff'
  ctx.shadowBlur = 22 * px
  ctx.beginPath()
  ctx.moveTo(0, -size)
  ctx.lineTo(size * 0.8, -size * 0.25)
  ctx.lineTo(0, size)
  ctx.lineTo(-size * 0.8, -size * 0.25)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.lineWidth = 1.2 * px
  ctx.beginPath()
  ctx.moveTo(-size * 0.8, -size * 0.25)
  ctx.lineTo(size * 0.8, -size * 0.25)
  ctx.moveTo(0, -size)
  ctx.lineTo(-size * 0.3, -size * 0.25)
  ctx.lineTo(0, size)
  ctx.lineTo(size * 0.3, -size * 0.25)
  ctx.lineTo(0, -size)
  ctx.stroke()
  ctx.restore()
}

const drawSearchlight = (
  ctx: CanvasRenderingContext2D,
  bodyX: number,
  bodyY: number,
  width: number,
  height: number,
  progress: number,
  active: boolean,
  failed: boolean,
  px: number,
) => {
  ctx.save()
  const color = failed ? '255, 50, 60' : '255, 228, 150'
  if (!active) {
    // Warning: a thin cone from the ceiling swings toward the player.
    ctx.globalAlpha = 0.25 + 0.55 * progress
    const spread = width * (0.04 + 0.1 * progress)
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, `rgba(${color}, 0.55)`)
    gradient.addColorStop(1, `rgba(${color}, 0)`)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.moveTo(width / 2 - 8 * px, 0)
    ctx.lineTo(width / 2 + 8 * px, 0)
    ctx.lineTo(bodyX + spread, height)
    ctx.lineTo(bodyX - spread, height)
    ctx.closePath()
    ctx.fill()
  } else {
    const radius = width * 0.22
    const gradient = ctx.createRadialGradient(bodyX, bodyY, radius * 0.1, bodyX, bodyY, radius * 1.6)
    gradient.addColorStop(0, `rgba(${color}, ${failed ? 0.55 : 0.42})`)
    gradient.addColorStop(0.55, `rgba(${color}, 0.16)`)
    gradient.addColorStop(1, `rgba(${color}, 0)`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
  }
  ctx.restore()
}

/**
 * LASER RUSH play surface. Owns the engine for one run: pose frames come in
 * through `sinkRef`, the display loop advances the timeline, draws the
 * obstacles over the camera, and turns engine cues into sound, voice,
 * popups and the photo-finish snapshot.
 */
export function ArcadeStage({ videoRef, sinkRef, seed, playerLabel, play, onTune, onShake, onFinish }: ArcadeStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hud, setHud] = useState<Hud>({ score: 0, lives: ARCADE_LIVES, combo: 0, multiplier: 1, secondsLeft: ARCADE_DURATION_MS / 1000, level: 0 })
  const [popups, setPopups] = useState<Popup[]>([])
  const [banner, setBanner] = useState<ArcadeOutcome | null>(null)
  const callbacks = useRef({ play, onTune, onShake, onFinish })
  useEffect(() => { callbacks.current = { play, onTune, onShake, onFinish } }, [play, onTune, onShake, onFinish])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const engine = new ArcadeEngine(seed, performance.now())
    const viewport: CoverViewport = createCoverViewport()
    const measure = () => measureCoverViewport(canvas, viewport)
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)

    let baseline: CalibrationBaseline | null = null
    const particles: Particle[] = []
    let popupId = 0
    let lastHudAt = 0
    let snapshot: HTMLCanvasElement | null = null
    let snapshotCombo = -1
    let lastCaptureAt = -Infinity
    let finishTimer = 0
    let frameId = 0
    let last = performance.now()
    const failedAt = new Map<number, number>()
    const passedAt = new Map<number, number>()

    sinkRef.current = (frame, resolved) => {
      if (resolved) baseline = resolved
      if (frame && resolved) engine.observe(frame, resolved)
    }

    /** Normalized (mirrored) video coordinates -> % of the visible stage, for DOM popups. */
    const toScreen = (x: number, y: number) => {
      const { bounds } = viewport
      const w = bounds.right - bounds.left || canvas.width || 1
      const h = bounds.bottom - bounds.top || canvas.height || 1
      return {
        x: clamp(((x * canvas.width - bounds.left) / w) * 100, 12, 88),
        y: clamp(((y * canvas.height - bounds.top) / h) * 100, 14, 86),
      }
    }

    const pushPopup = (text: string, tone: PopupTone, x: number, y: number, sub?: string) => {
      const id = popupId++
      const at = toScreen(x, y)
      setPopups((current) => [...current.slice(-5), { id, text, sub, tone, x: at.x, y: at.y }])
      window.setTimeout(() => setPopups((current) => current.filter((popup) => popup.id !== id)), POPUP_MS)
    }

    const capture = (combo: number, now: number) => {
      if (combo <= snapshotCombo || now - lastCaptureAt < CAPTURE_GAP_MS) return
      const shot = captureFrame(videoRef.current)
      if (!shot) return
      snapshot = shot
      snapshotCombo = combo
      lastCaptureAt = now
    }

    const handleCues = (now: number) => {
      const { play: sound } = callbacks.current
      for (const cue of engine.drain()) {
        switch (cue.type) {
          case 'telegraph':
            sound('warn')
            if (cue.kind === 'SEARCHLIGHT') announce('voice.freeze', undefined, true)
            break
          case 'pass': {
            const label = cue.kind === 'DIAMOND' ? `💎 +${cue.points}` : `+${cue.points}`
            pushPopup(t(`judge.${cue.grade}`), TONE[cue.grade], cue.x, cue.y - 0.08, label)
            sound(cue.kind === 'DIAMOND' ? 'gem' : cue.grade === 'PERFECT' ? 'perfect' : 'success')
            spawnSparks(particles, cue.x * canvas.width, cue.y * canvas.height, viewport.px, cue.grade === 'PERFECT' ? 22 : 12, true)
            if (cue.combo > 0 && cue.combo % 5 === 0) announce('voice.combo', { n: cue.combo })
            else if (cue.grade === 'PERFECT' && cue.combo >= 3) announce('voice.perfect')
            if (cue.grade !== 'OK') capture(cue.combo, now)
            break
          }
          case 'hit':
            pushPopup(t(cue.kind === 'SEARCHLIGHT' ? 'judge.SPOTTED' : 'judge.HIT'), 'bad', cue.x, cue.y - 0.1, '−♥')
            sound('zap')
            callbacks.current.onShake()
            spawnSparks(particles, cue.x * canvas.width, cue.y * canvas.height, viewport.px, 26)
            break
          case 'miss': {
            const event = engine.events.find((item) => item.id === cue.id)
            if (event && baseline) {
              const spot = placeDiamond(event, baseline)
              pushPopup(t('judge.MISSED'), 'info', spot.x, spot.y)
            }
            break
          }
          case 'levelUp':
            pushPopup(t('arcade.speedUp'), 'info', 0.5, 0.22, t('arcade.level', { n: cue.level + 1 }))
            sound('levelUp')
            announce('voice.speedUp')
            callbacks.current.onTune(112 + cue.level * 9, 0.35 + cue.level * 0.13)
            break
          case 'end':
            setBanner(cue.outcome)
            sound(cue.outcome === 'survived' ? 'unlock' : 'error')
            if (cue.outcome === 'out') announce('voice.over', undefined, true)
            snapshot ??= captureFrame(videoRef.current)
            finishTimer = window.setTimeout(() => {
              callbacks.current.onFinish({ stats: { ...engine.stats }, outcome: cue.outcome, snapshot, durationMs: engine.elapsed(performance.now()) })
            }, END_DELAY_MS)
            break
        }
      }
    }

    const drawEvent = (event: ArcadeEvent, elapsed: number, now: number) => {
      if (!baseline) return
      const { width, height } = canvas
      const { px, bounds } = viewport
      const failed = event.state === 'failed'
      if (event.kind === 'DIAMOND') {
        if (event.state !== 'active') return
        const spot = placeDiamond(event, baseline)
        const age = (elapsed - event.spawnAt) / (event.endAt - event.spawnAt)
        drawDiamond(context, spot.x * width, spot.y * height, spot.radius * width, 1 - age, now, clamp((elapsed - event.spawnAt) / 150), px)
        return
      }
      const warning = event.state === 'telegraph'
      const progress = warning ? clamp((elapsed - event.spawnAt) / (event.impactAt - event.spawnAt)) : 1
      const blink = 0.5 + 0.5 * Math.sin(now * 0.025)
      const recentlyFailed = failed && now - (failedAt.get(event.id) ?? now) < 500
      const recentlyPassed = event.state === 'passed' && now - (passedAt.get(event.id) ?? now) < 450
      if (!warning && event.state !== 'active' && !recentlyFailed && !recentlyPassed) return

      if (event.kind === 'LOW_BEAM') {
        const y = beamYFor(baseline) * height
        if (recentlyPassed) {
          const fade = 1 - (now - (passedAt.get(event.id) ?? now)) / 450
          drawBeam(context, { y, bounds, reveal: 1, breach: false, clearMix: 1, alpha: fade, t: now, px })
          return
        }
        if (warning) {
          // Dashed guide across the room: where the beam will fire.
          context.save()
          context.setLineDash([14 * px, 10 * px])
          context.strokeStyle = `rgba(255, 60, 90, ${0.35 + 0.35 * blink})`
          context.lineWidth = 2 * px
          context.beginPath()
          context.moveTo(bounds.left, y)
          context.lineTo(bounds.right, y)
          context.stroke()
          context.restore()
        }
        drawBeam(context, { y, bounds, reveal: progress, breach: failed, clearMix: 0, alpha: warning ? 0.35 + 0.3 * blink : 1, t: now, px })
        if (warning) drawCallout(context, `${t('obs.LOW_BEAM.call')} ↓`, (bounds.left + bounds.right) / 2, y - 42 * px, '#ff4d6d', 22, px, 0.7 + 0.3 * blink)
        return
      }

      if (event.kind === 'WALL_LEFT' || event.kind === 'WALL_RIGHT') {
        const edge = wallEdge(event.kind, baseline) * width
        const [from, to] = event.kind === 'WALL_LEFT' ? [bounds.left, edge] : [edge, bounds.right]
        const intensity = warning ? 0.15 + 0.3 * progress * blink : recentlyPassed ? 0.4 : 1
        drawWall(context, from, to, bounds.top, bounds.bottom, intensity, now, px)
        context.save()
        context.setLineDash([10 * px, 8 * px])
        context.strokeStyle = 'rgba(255, 80, 110, 0.9)'
        context.lineWidth = 2 * px
        context.beginPath()
        context.moveTo(edge, bounds.top)
        context.lineTo(edge, bounds.bottom)
        context.stroke()
        context.restore()
        if (warning) {
          const arrow = event.kind === 'WALL_LEFT' ? '→' : '←'
          const safeCenter = event.kind === 'WALL_LEFT' ? (edge + bounds.right) / 2 : (bounds.left + edge) / 2
          drawCallout(context, t('obs.WALL.call', { arrow }), safeCenter, bounds.top + (bounds.bottom - bounds.top) * 0.3, '#ff4d6d', 22, px, 0.7 + 0.3 * blink)
        }
        return
      }

      // SEARCHLIGHT
      drawSearchlight(context, engine.bodyX * width, engine.bodyY * height, width, height, progress, !warning, failed, px)
      const centerX = (bounds.left + bounds.right) / 2
      const labelY = bounds.top + 70 * px
      drawCallout(context, t('obs.SEARCHLIGHT.call'), centerX, labelY, failed ? '#ff4d6d' : '#ffe39a', 24, px, warning ? 0.7 + 0.3 * blink : 1)
      if (!warning && engine.energy !== undefined) {
        // Live motion meter: how close the player is to being spotted.
        const meterWidth = 180 * px
        const level = clamp(engine.energy / 0.22, 0, 1.4) / 1.4
        context.save()
        context.fillStyle = 'rgba(4, 8, 16, 0.7)'
        context.fillRect(centerX - meterWidth / 2, labelY + 26 * px, meterWidth, 8 * px)
        context.fillStyle = level > 0.71 ? '#ff4d6d' : level > 0.45 ? '#ffc45c' : '#00ff88'
        context.fillRect(centerX - meterWidth / 2, labelY + 26 * px, meterWidth * level, 8 * px)
        context.fillStyle = '#ffffff'
        context.fillRect(centerX - meterWidth / 2 + meterWidth * (1 / 1.4), labelY + 22 * px, 2 * px, 16 * px)
        context.restore()
      }
    }

    callbacks.current.onTune(112, 0.35)
    pushPopup(t('arcade.go'), 'info', 0.5, 0.3)
    announce('voice.go', undefined, true)

    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick)
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now
      if (syncCanvasToVideo(canvas, videoRef.current)) measure()

      engine.advance(now)
      // Stamp when each obstacle resolved (here or in observe()) for the short hit / clear flashes.
      for (const event of engine.events) {
        if (event.state === 'failed' && !failedAt.has(event.id)) failedAt.set(event.id, now)
        if (event.state === 'passed' && !passedAt.has(event.id)) passedAt.set(event.id, now)
      }
      handleCues(now)

      const elapsed = engine.elapsed(now)
      context.clearRect(0, 0, canvas.width, canvas.height)
      for (const event of engine.events) drawEvent(event, elapsed, now)
      updateParticles(particles, dt, viewport.px)
      drawParticles(context, particles, viewport.px)

      if (now - lastHudAt > 100) {
        lastHudAt = now
        const { stats } = engine
        setHud({
          score: stats.score,
          lives: stats.lives,
          combo: stats.combo,
          multiplier: engine.multiplier,
          secondsLeft: Math.max(0, Math.ceil((ARCADE_DURATION_MS - elapsed) / 1000)),
          level: engine.level,
        })
      }
      // Fallback photo a few seconds in, so every run ends with a poster.
      if (!snapshot && elapsed > 4000) capture(0, now)
    }
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      window.clearTimeout(finishTimer)
      observer.disconnect()
      sinkRef.current = null
      context.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [seed, sinkRef, videoRef])

  const timeClass = hud.secondsLeft <= 10 ? 'urgent' : ''
  return (
    <>
      <canvas ref={canvasRef} className="arcade-canvas" aria-hidden="true" />
      <header className="arcade-hud">
        <div className="arcade-lives" aria-label={`${t('arcade.lives')}: ${hud.lives}`}>
          <span>{playerLabel ?? t('arcade.lives')}</span>
          <b>{Array.from({ length: ARCADE_LIVES }, (_, index) => <i key={index} className={index < hud.lives ? 'on' : ''}>♥</i>)}</b>
        </div>
        <div className="arcade-time">
          <span>{t('arcade.level', { n: hud.level + 1 })}</span>
          <b className={timeClass}>{`0:${String(hud.secondsLeft).padStart(2, '0')}`}</b>
        </div>
        <div className="arcade-score">
          <span>{t('common.score')}</span>
          <b>{hud.score.toLocaleString()}</b>
          <small className={hud.multiplier > 1 ? 'hot' : ''}>{t('common.combo')} {hud.combo} · ×{hud.multiplier}</small>
        </div>
      </header>
      <div className="arcade-popups" aria-live="polite">
        {popups.map((popup) => (
          <div key={popup.id} className={`judge-pop tone-${popup.tone}`} style={{ left: `${popup.x}%`, top: `${popup.y}%` }}>
            <b>{popup.text}</b>{popup.sub && <small>{popup.sub}</small>}
          </div>
        ))}
      </div>
      {banner && <div className={`arcade-banner ${banner}`} role="status"><b>{t(banner === 'survived' ? 'arcade.done' : 'arcade.over')}</b></div>}
    </>
  )
}
