/**
 * Procedural heist soundtrack: kick, clap, hats, a minor bass riff and a
 * pluck arp, synthesized on the fly with Web Audio (no audio files, works
 * offline). A lookahead scheduler keeps timing tight while the tempo and
 * intensity follow the game: the arcade speeds up, overtime gets tense.
 */
export interface MusicController {
  setTempo: (bpm: number) => void
  /** 0 = sparse (kick + bass), 1 = everything. */
  setIntensity: (value: number) => void
  stop: () => void
}

const LOOKAHEAD_S = 0.12
const TICK_MS = 25
const MASTER = 0.11
/** Bass roots per bar (A1, A1, C2, G1): a four-bar minor loop. */
const ROOTS = [55, 55, 65.41, 49]
const BASS_STEPS = new Set([0, 3, 6, 8, 11, 14])
const ARP_STEPS = [2, 6, 10, 14]
const ARP_RATIOS = [4, 6, 4.8, 8]

let noiseBuffer: AudioBuffer | null = null
const noise = (ctx: AudioContext) => {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
  }
  return noiseBuffer
}

const envelope = (ctx: AudioContext, destination: AudioNode, time: number, peak: number, decay: number) => {
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, time)
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
  gain.connect(destination)
  return gain
}

const kick = (ctx: AudioContext, out: AudioNode, time: number) => {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(140, time)
  osc.frequency.exponentialRampToValueAtTime(42, time + 0.12)
  osc.connect(envelope(ctx, out, time, 0.95, 0.22))
  osc.start(time)
  osc.stop(time + 0.25)
}

const noiseHit = (ctx: AudioContext, out: AudioNode, time: number, type: BiquadFilterType, frequency: number, peak: number, decay: number) => {
  const source = ctx.createBufferSource()
  source.buffer = noise(ctx)
  const filter = ctx.createBiquadFilter()
  filter.type = type
  filter.frequency.value = frequency
  source.connect(filter).connect(envelope(ctx, out, time, peak, decay))
  source.start(time, Math.random() * 0.5, decay + 0.02)
}

const tone = (ctx: AudioContext, out: AudioNode, time: number, type: OscillatorType, frequency: number, peak: number, decay: number, cutoff: number) => {
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(frequency, time)
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(cutoff, time)
  filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.35), time + decay)
  osc.connect(filter).connect(envelope(ctx, out, time, peak, decay))
  osc.start(time)
  osc.stop(time + decay + 0.02)
}

export const startMusic = (ctx: AudioContext, initialBpm = 104): MusicController => {
  const master = ctx.createGain()
  master.gain.setValueAtTime(0.0001, ctx.currentTime)
  master.gain.exponentialRampToValueAtTime(MASTER, ctx.currentTime + 0.8)
  master.connect(ctx.destination)

  let bpm = initialBpm
  let intensity = 0.4
  let step = 0
  let nextTime = ctx.currentTime + 0.08
  let stopped = false

  const schedule = (index: number, time: number) => {
    const bar = Math.floor(index / 16) % ROOTS.length
    const s = index % 16
    const root = ROOTS[bar]
    if (s === 0 || s === 8 || (intensity > 0.55 && s === 10)) kick(ctx, master, time)
    if (s === 4 || s === 12) noiseHit(ctx, master, time, 'bandpass', 1900, 0.32, 0.09)
    if (s % 2 === 0 || intensity > 0.7) noiseHit(ctx, master, time, 'highpass', 7200, s % 4 === 2 ? 0.16 : 0.08, 0.035)
    if (BASS_STEPS.has(s)) tone(ctx, master, time, 'sawtooth', root, 0.3, 0.16, 380 + intensity * 700)
    if (intensity > 0.3) {
      const arp = ARP_STEPS.indexOf(s)
      if (arp !== -1) tone(ctx, master, time, 'triangle', root * ARP_RATIOS[(arp + bar) % ARP_RATIOS.length], 0.1 + intensity * 0.06, 0.2, 2600)
    }
  }

  const timer = window.setInterval(() => {
    if (stopped || ctx.state !== 'running') return
    // After a suspend (mute), skip ahead instead of firing the backlog all at once.
    if (nextTime < ctx.currentTime - 0.2) nextTime = ctx.currentTime + 0.05
    while (nextTime < ctx.currentTime + LOOKAHEAD_S) {
      schedule(step, nextTime)
      step += 1
      nextTime += 60 / bpm / 4
    }
  }, TICK_MS)

  return {
    setTempo: (value) => { bpm = Math.max(70, Math.min(180, value)) },
    setIntensity: (value) => { intensity = Math.max(0, Math.min(1, value)) },
    stop: () => {
      if (stopped) return
      stopped = true
      window.clearInterval(timer)
      const now = ctx.currentTime
      master.gain.cancelScheduledValues(now)
      master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now)
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
      window.setTimeout(() => master.disconnect(), 500)
    },
  }
}
