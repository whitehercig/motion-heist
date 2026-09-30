import { evaluateLaser } from '../laser/laserCollision'
import { clamp, midpoint, mirroredPoint } from '../motion/geometry'
import { extractMetrics } from '../motion/gestureEngine'
import { MotionEnergyMeter } from '../motion/motionEnergy'
import { PoseIndex, type CalibrationBaseline, type PoseFrame } from '../types/pose'

/**
 * LASER RUSH: a 60-second stream of obstacles judged against the same body
 * metrics as the story (lean angle, laser collision, motion energy), so it
 * works standing or seated. The whole timeline is generated up front from a
 * seed: two duel players face exactly the same run.
 */

export type ObstacleKind = 'LOW_BEAM' | 'WALL_LEFT' | 'WALL_RIGHT' | 'DIAMOND' | 'SEARCHLIGHT'
export type Grade = 'PERFECT' | 'GREAT' | 'OK'
export type EventState = 'pending' | 'telegraph' | 'active' | 'passed' | 'failed'

export interface ArcadeEvent {
  id: number
  kind: ObstacleKind
  /** Milliseconds from run start. Diamonds skip the telegraph: spawnAt === impactAt. */
  spawnAt: number
  impactAt: number
  endAt: number
  /** Diamond offset from the calibrated shoulder centre: x in shoulder widths, y in torso heights. */
  dx: number
  dy: number
  state: EventState
  grade?: Grade
  unsafeFrames: number
  /** Lowest safety margin seen while active (1 = exactly on the threshold). */
  minMargin: number
  /** Searchlight: highest motion energy seen while active. */
  peakEnergy: number
}

export type ArcadeCue =
  | { type: 'telegraph'; kind: ObstacleKind }
  | { type: 'pass'; kind: ObstacleKind; grade: Grade; points: number; combo: number; x: number; y: number }
  | { type: 'hit'; kind: ObstacleKind; lives: number; x: number; y: number }
  | { type: 'miss'; id: number }
  | { type: 'levelUp'; level: number }
  | { type: 'end'; outcome: ArcadeOutcome }

export type ArcadeOutcome = 'survived' | 'out'

export interface ArcadeStats {
  score: number
  lives: number
  combo: number
  bestCombo: number
  dodged: number
  diamonds: number
  perfects: number
  hits: number
  judged: number
  survivalBonus: number
}

export const ARCADE_DURATION_MS = 60_000
export const ARCADE_LIVES = 3
const LEVEL_MS = 10_000
const LEAN_DEGREES = 12
/** Head offset (shoulder widths) that clears a laser wall without leaning, e.g. by stepping aside. */
const WALL_CLEARANCE = 0.3
const FREEZE_LIMIT = 0.22
const DIAMOND_RADIUS = 0.075
/** Two bad frames in a row before a hit counts: one jittery landmark must not cost a life. */
const HIT_FRAMES = 2
const ACTIVE_MS: Record<Exclude<ObstacleKind, 'DIAMOND'>, number> = {
  LOW_BEAM: 520,
  WALL_LEFT: 560,
  WALL_RIGHT: 560,
  SEARCHLIGHT: 1400,
}
const POINTS: Record<Grade, number> = { PERFECT: 300, GREAT: 200, OK: 120 }
const DIAMOND_POINTS: Record<Grade, number> = { PERFECT: 250, GREAT: 180, OK: 120 }
const SURVIVAL_BONUS_PER_LIFE = 500

/** mulberry32: tiny, fast, and identical in every browser for the same seed. */
const rng = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let r = Math.imul(a ^ (a >>> 15), 1 | a)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export const newSeed = () => Math.floor(Math.random() * 2 ** 31)

export const levelAt = (ms: number) => Math.min(5, Math.floor(ms / LEVEL_MS))

export const buildTimeline = (seed: number, durationMs = ARCADE_DURATION_MS): ArcadeEvent[] => {
  const random = rng(seed)
  const events: ArcadeEvent[] = []
  let id = 0
  const push = (kind: ObstacleKind, spawnAt: number, impactAt: number, endAt: number, dx = 0, dy = 0) => {
    events.push({ id: id++, kind, spawnAt, impactAt, endAt, dx, dy, state: 'pending', unsafeFrames: 0, minMargin: Infinity, peakEnergy: 0 })
  }

  // Body obstacles: one at a time, faster and with shorter warnings every 10 s.
  let time = 2200
  const recent: ObstacleKind[] = []
  while (time < durationMs - 2000) {
    const level = levelAt(time)
    const telegraph = Math.max(650, 1200 - level * 100)
    const pool: Array<[ObstacleKind, number]> = [['LOW_BEAM', 3], ['WALL_LEFT', 2], ['WALL_RIGHT', 2], ['SEARCHLIGHT', level >= 1 ? 1.8 : 0]]
    let kind: ObstacleKind = 'LOW_BEAM'
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const total = pool.reduce((sum, [, weight]) => sum + weight, 0)
      let pick = random() * total
      kind = pool.find(([, weight]) => (pick -= weight) < 0)?.[0] ?? 'LOW_BEAM'
      // Never three of the same in a row: variety is the fun.
      if (!(recent.length >= 2 && recent[recent.length - 1] === kind && recent[recent.length - 2] === kind)) break
    }
    recent.push(kind)
    const active = ACTIVE_MS[kind as Exclude<ObstacleKind, 'DIAMOND'>]
    push(kind, time, time + telegraph, time + telegraph + active)
    const gap = Math.max(700, 1900 - level * 230) + random() * 500
    time += telegraph + active + gap
  }

  // Diamonds: an independent rhythm. They may overlap obstacles, even the searchlight: greed has a price.
  time = 3600
  while (time < durationMs - 1500) {
    const level = levelAt(time)
    const life = Math.max(1100, 1900 - level * 140)
    const side = random() < 0.5 ? -1 : 1
    push('DIAMOND', time, time, time + life, side * (0.9 + random() * 1.0), -1.05 + random() * 1.2)
    time += life + 900 + random() * 1600
  }
  return events.sort((a, b) => a.spawnAt - b.spawnAt)
}

const gradeFor = (margin: number): Grade => (margin >= 1.35 ? 'PERFECT' : margin >= 1.1 ? 'GREAT' : 'OK')

export interface DiamondPlacement { x: number; y: number; radius: number }

export const placeDiamond = (event: ArcadeEvent, baseline: CalibrationBaseline): DiamondPlacement => {
  const torso = baseline.hipY - baseline.shoulderY
  return {
    x: clamp(baseline.shoulderX + event.dx * baseline.shoulderWidth, 0.12, 0.88),
    y: clamp(baseline.shoulderY + event.dy * torso, 0.1, 0.85),
    radius: DIAMOND_RADIUS,
  }
}

/** Screen-space edge of a laser wall: the head must end up past it (mirrored x). */
export const wallEdge = (kind: 'WALL_LEFT' | 'WALL_RIGHT', baseline: CalibrationBaseline) =>
  baseline.shoulderX + (kind === 'WALL_LEFT' ? 1 : -1) * WALL_CLEARANCE * baseline.shoulderWidth

export class ArcadeEngine {
  readonly events: ArcadeEvent[]
  readonly stats: ArcadeStats = { score: 0, lives: ARCADE_LIVES, combo: 0, bestCombo: 0, dodged: 0, diamonds: 0, perfects: 0, hits: 0, judged: 0, survivalBonus: 0 }
  outcome: ArcadeOutcome | null = null
  level = 0
  /** Latest body position for placing popups (mirrored normalized). */
  bodyX = 0.5
  bodyY = 0.4
  energy: number | undefined
  private readonly motion = new MotionEnergyMeter()
  private readonly cues: ArcadeCue[] = []

  constructor(seed: number, private readonly startedAt: number, readonly durationMs = ARCADE_DURATION_MS) {
    this.events = buildTimeline(seed, durationMs)
  }

  elapsed(now: number) {
    return Math.max(0, now - this.startedAt)
  }

  get multiplier() {
    return 1 + Math.min(3, Math.floor(this.stats.combo / 4))
  }

  /** Cues since the last call (sounds, popups, voice). */
  drain() {
    return this.cues.splice(0)
  }

  /** Judges the active obstacles against one pose frame. */
  observe(frame: PoseFrame, baseline: CalibrationBaseline) {
    if (this.outcome) return
    const t = this.elapsed(frame.timestamp)
    const metrics = extractMetrics(frame, baseline)
    if (!metrics || metrics.confidence < 0.45) return
    this.energy = this.motion.update(frame, metrics.shoulderWidth)
    const nose = mirroredPoint(frame, PoseIndex.NOSE)
    const shoulders = midpoint(mirroredPoint(frame, PoseIndex.LEFT_SHOULDER), mirroredPoint(frame, PoseIndex.RIGHT_SHOULDER))
    this.bodyX = shoulders.x
    this.bodyY = (nose.y + shoulders.y) / 2
    const aspect = frame.aspect ?? 16 / 9
    const wrists = [PoseIndex.LEFT_WRIST, PoseIndex.RIGHT_WRIST]
      .filter((index) => (frame.landmarks[index]?.visibility ?? 0) > 0.4)
      .map((index) => mirroredPoint(frame, index))

    for (const event of this.events) {
      if (event.state !== 'active' || t > event.endAt) continue
      if (event.kind === 'DIAMOND') {
        const spot = placeDiamond(event, baseline)
        const touched = wrists.some((wrist) => Math.hypot(wrist.x - spot.x, (wrist.y - spot.y) / aspect) < spot.radius)
        if (touched) this.collect(event, t, spot)
        continue
      }
      let safe = true
      let margin = 2
      if (event.kind === 'LOW_BEAM') {
        const reading = evaluateLaser(frame, baseline)
        // No reading = the upper body left the frame downward: that is a very successful duck.
        if (reading) {
          safe = !reading.breached
          margin = reading.targetDrop > 0 ? reading.currentDrop / reading.targetDrop : 2
        }
      } else if (event.kind === 'WALL_LEFT' || event.kind === 'WALL_RIGHT') {
        const direction = event.kind === 'WALL_LEFT' ? 1 : -1
        const shift = ((nose.x - baseline.shoulderX) * direction) / baseline.shoulderWidth
        const lean = metrics.leanDegrees * direction
        margin = Math.max(shift / WALL_CLEARANCE, lean / LEAN_DEGREES)
        safe = margin >= 1
      } else if (event.kind === 'SEARCHLIGHT' && this.energy !== undefined) {
        event.peakEnergy = Math.max(event.peakEnergy, this.energy)
        margin = this.energy > 0 ? FREEZE_LIMIT / this.energy : 3
        safe = this.energy <= FREEZE_LIMIT
      }
      event.minMargin = Math.min(event.minMargin, margin)
      event.unsafeFrames = safe ? 0 : event.unsafeFrames + 1
      if (event.unsafeFrames >= HIT_FRAMES) this.hit(event, nose.x, event.kind === 'LOW_BEAM' ? nose.y : this.bodyY)
    }
  }

  /** Advances the timeline on the display clock, even when no pose frames arrive. */
  advance(now: number) {
    if (this.outcome) return
    const t = this.elapsed(now)
    const level = levelAt(t)
    if (level > this.level) {
      this.level = level
      this.cues.push({ type: 'levelUp', level })
    }
    for (const event of this.events) {
      if (event.state === 'pending' && t >= event.spawnAt) {
        event.state = event.kind === 'DIAMOND' ? 'active' : 'telegraph'
        if (event.kind !== 'DIAMOND') this.cues.push({ type: 'telegraph', kind: event.kind })
      }
      if (event.state === 'telegraph' && t >= event.impactAt) event.state = 'active'
      if (event.state === 'active' && t > event.endAt) {
        if (event.kind === 'DIAMOND') {
          event.state = 'failed'
          this.cues.push({ type: 'miss', id: event.id })
        } else {
          this.pass(event)
        }
      }
    }
    const bodyEventsLeft = this.events.some((event) => event.kind !== 'DIAMOND' && (event.state === 'telegraph' || event.state === 'active'))
    if (t >= this.durationMs && !bodyEventsLeft) this.finish('survived')
  }

  private award(base: number) {
    this.stats.combo += 1
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo)
    const points = Math.round(base * this.multiplier)
    this.stats.score += points
    return points
  }

  private pass(event: ArcadeEvent) {
    const grade = event.kind === 'SEARCHLIGHT'
      ? (event.peakEnergy < 0.1 ? 'PERFECT' : event.peakEnergy < 0.16 ? 'GREAT' : 'OK')
      : gradeFor(event.minMargin === Infinity ? 2 : event.minMargin)
    event.state = 'passed'
    event.grade = grade
    this.stats.dodged += 1
    this.stats.judged += 1
    if (grade === 'PERFECT') this.stats.perfects += 1
    const points = this.award(POINTS[grade])
    this.cues.push({ type: 'pass', kind: event.kind, grade, points, combo: this.stats.combo, x: this.bodyX, y: this.bodyY })
  }

  private collect(event: ArcadeEvent, t: number, spot: DiamondPlacement) {
    const age = (t - event.spawnAt) / (event.endAt - event.spawnAt)
    const grade: Grade = age < 0.45 ? 'PERFECT' : age < 0.75 ? 'GREAT' : 'OK'
    event.state = 'passed'
    event.grade = grade
    this.stats.diamonds += 1
    if (grade === 'PERFECT') this.stats.perfects += 1
    const points = this.award(DIAMOND_POINTS[grade])
    this.cues.push({ type: 'pass', kind: 'DIAMOND', grade, points, combo: this.stats.combo, x: spot.x, y: spot.y })
  }

  private hit(event: ArcadeEvent, x: number, y: number) {
    event.state = 'failed'
    this.stats.hits += 1
    this.stats.judged += 1
    this.stats.combo = 0
    this.stats.lives = Math.max(0, this.stats.lives - 1)
    this.cues.push({ type: 'hit', kind: event.kind, lives: this.stats.lives, x, y })
    if (this.stats.lives === 0) this.finish('out')
  }

  private finish(outcome: ArcadeOutcome) {
    if (this.outcome) return
    this.outcome = outcome
    if (outcome === 'survived') {
      this.stats.survivalBonus = this.stats.lives * SURVIVAL_BONUS_PER_LIFE
      this.stats.score += this.stats.survivalBonus
    }
    this.cues.push({ type: 'end', outcome })
  }
}
