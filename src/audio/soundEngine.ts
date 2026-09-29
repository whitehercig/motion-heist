const ZAP_DURATION = 0.15

// One noise buffer per context: regenerating it on every hit would allocate on the hot path.
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()

const whiteNoise = (context: BaseAudioContext) => {
  const cached = noiseBuffers.get(context)
  if (cached) return cached
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * ZAP_DURATION), context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
  noiseBuffers.set(context, buffer)
  return buffer
}

/** Electric discharge: 150 ms white noise -> 800 Hz band-pass (Q 3) -> fast exponential decay. */
export const playElectricZap = (context: AudioContext, volume = 0.3) => {
  const now = context.currentTime
  const source = context.createBufferSource()
  source.buffer = whiteNoise(context)
  source.playbackRate.setValueAtTime(0.9 + Math.random() * 0.25, now)

  const filter = context.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(800, now)
  filter.Q.setValueAtTime(3, now)

  const gain = context.createGain()
  gain.gain.setValueAtTime(volume, now)
  gain.gain.exponentialRampToValueAtTime(0.01, now + ZAP_DURATION)

  source.connect(filter).connect(gain).connect(context.destination)
  source.start(now)
  source.stop(now + ZAP_DURATION)
}

/** Pose-lock "blip": two quiet rising sine pings, so it never masks the zap or error cues. */
export const playLockBlip = (context: AudioContext, volume = 0.07) => {
  const now = context.currentTime
  const pings: Array<[number, number]> = [[1320, 0], [1760, 0.065]]
  for (const [frequency, offset] of pings) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, now + offset)
    gain.gain.setValueAtTime(0.0001, now + offset)
    gain.gain.exponentialRampToValueAtTime(volume, now + offset + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.06)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(now + offset)
    oscillator.stop(now + offset + 0.07)
  }
}

const loopBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()

/** 2 s of white noise, long enough that a looped scrape never audibly repeats. */
const loopNoise = (context: BaseAudioContext) => {
  const cached = loopBuffers.get(context)
  if (cached) return cached
  const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
  loopBuffers.set(context, buffer)
  return buffer
}

export interface VaultSequence {
  /** Sound 1: capacitor charge, 200 -> 800 Hz over the palm-lock time. */
  startCharge: (durationMs: number) => void
  cancelCharge: () => void
  /** Charge complete: cut the whine, confirm with a relay click. */
  completeCharge: () => void
  /** Sound 2: metal scrape. Notch frequency tracks progress, loudness tracks how fast the doors move. */
  setGrind: (progress: number, speed: number) => void
  stopGrind: () => void
  /** Doors hitting the frame after a release; strength 0..1 (rebounds are quieter). */
  slamShut: (strength: number) => void
  /** Sound 3: final hydraulic lock strike + decompression. */
  breach: () => void
  dispose: () => void
}

interface GrindVoice {
  source: AudioBufferSourceNode
  notch: BiquadFilterNode
  ring: BiquadFilterNode
  gain: GainNode
  rumble: OscillatorNode
  rumbleGain: GainNode
}

/**
 * Procedural audio for the vault finale. Every voice goes through one
 * compressor so the breach can be loud without clipping.
 */
export const playVaultSequence = (context: AudioContext): VaultSequence => {
  const bus = context.createGain()
  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = -16
  compressor.ratio.value = 6
  compressor.attack.value = 0.003
  compressor.release.value = 0.25
  bus.connect(compressor).connect(context.destination)

  let charge: { oscillator: OscillatorNode; gain: GainNode } | null = null
  let grind: GrindVoice | null = null

  const stopCharge = (fade: number) => {
    if (!charge) return
    const now = context.currentTime
    charge.gain.gain.cancelScheduledValues(now)
    charge.gain.gain.setTargetAtTime(0.0001, now, fade)
    charge.oscillator.stop(now + fade * 6)
    charge = null
  }

  const noiseBurst = (duration: number, volume: number, from: number, to: number, type: BiquadFilterType, delay = 0) => {
    const now = context.currentTime + delay
    const source = context.createBufferSource()
    source.buffer = loopNoise(context)
    const filter = context.createBiquadFilter()
    filter.type = type
    filter.frequency.setValueAtTime(from, now)
    filter.frequency.exponentialRampToValueAtTime(to, now + duration)
    const gain = context.createGain()
    gain.gain.setValueAtTime(volume, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
    source.connect(filter).connect(gain).connect(bus)
    source.start(now)
    source.stop(now + duration + 0.05)
  }

  const tone = (type: OscillatorType, from: number, to: number, duration: number, volume: number, delay = 0) => {
    const now = context.currentTime + delay
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(from, now)
    if (to !== from) oscillator.frequency.exponentialRampToValueAtTime(to, now + duration)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    oscillator.connect(gain).connect(bus)
    oscillator.start(now)
    oscillator.stop(now + duration + 0.05)
  }

  const createGrind = (): GrindVoice => {
    const now = context.currentTime
    const source = context.createBufferSource()
    source.buffer = loopNoise(context)
    source.loop = true
    const notch = context.createBiquadFilter()
    notch.type = 'notch'
    notch.Q.value = 3
    // A resonant peak on top of the moving notch is what makes noise read as steel, not hiss.
    const ring = context.createBiquadFilter()
    ring.type = 'peaking'
    ring.Q.value = 11
    ring.gain.value = 16
    const lowpass = context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 6500
    const gain = context.createGain()
    gain.gain.value = 0
    source.connect(notch).connect(ring).connect(lowpass).connect(gain).connect(bus)

    const rumble = context.createOscillator()
    rumble.type = 'sawtooth'
    rumble.frequency.value = 46
    const rumbleFilter = context.createBiquadFilter()
    rumbleFilter.type = 'lowpass'
    rumbleFilter.frequency.value = 160
    const rumbleGain = context.createGain()
    rumbleGain.gain.value = 0
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(bus)
    source.start(now)
    rumble.start(now)
    return { source, notch, ring, gain, rumble, rumbleGain }
  }

  return {
    startCharge(durationMs) {
      stopCharge(0.01)
      const now = context.currentTime
      const seconds = durationMs / 1000
      const oscillator = context.createOscillator()
      oscillator.type = 'sawtooth'
      oscillator.frequency.setValueAtTime(200, now)
      oscillator.frequency.exponentialRampToValueAtTime(800, now + seconds)
      const lowpass = context.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.Q.value = 7
      lowpass.frequency.setValueAtTime(700, now)
      lowpass.frequency.exponentialRampToValueAtTime(3400, now + seconds)
      const gain = context.createGain()
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.07, now + 0.05)
      oscillator.connect(lowpass).connect(gain).connect(bus)
      oscillator.start(now)
      oscillator.stop(now + seconds + 0.6)
      charge = { oscillator, gain }
    },
    cancelCharge() {
      stopCharge(0.03)
    },
    completeCharge() {
      stopCharge(0.012)
      tone('square', 1600, 1600, 0.035, 0.05)
      tone('sine', 110, 70, 0.12, 0.18)
    },
    setGrind(progress, speed) {
      grind ??= createGrind()
      const now = context.currentTime
      const effort = Math.min(1, speed / 1.6)
      grind.notch.frequency.setTargetAtTime(420 + progress * 3000, now, 0.03)
      grind.ring.frequency.setTargetAtTime(1900 + progress * 1500, now, 0.05)
      grind.gain.gain.setTargetAtTime(0.015 + effort * 0.2, now, 0.05)
      grind.rumbleGain.gain.setTargetAtTime(0.04 + effort * 0.22, now, 0.06)
      grind.rumble.frequency.setTargetAtTime(42 + progress * 18, now, 0.1)
    },
    stopGrind() {
      if (!grind) return
      const now = context.currentTime
      grind.gain.gain.setTargetAtTime(0, now, 0.04)
      grind.rumbleGain.gain.setTargetAtTime(0, now, 0.04)
    },
    slamShut(strength) {
      const level = 0.25 + 0.75 * Math.min(1, Math.max(0, strength))
      noiseBurst(0.18, 0.35 * level, 1400, 180, 'lowpass')
      tone('sine', 95, 48, 0.32, 0.45 * level)
      tone('triangle', 640, 610, 0.25, 0.06 * level, 0.01)
    },
    breach() {
      stopCharge(0.01)
      // Hydraulic strike: a 60 Hz body with a falling tail.
      tone('sine', 60, 36, 1.1, 0.75)
      tone('square', 120, 60, 0.09, 0.12)
      // Metallic clang: inharmonic partials of a struck steel slab.
      const partials: Array<[number, number, number]> = [[523, 1.3, 0.09], [1187, 0.9, 0.07], [1851, 0.7, 0.05], [2634, 0.5, 0.04]]
      for (const [frequency, duration, volume] of partials) tone('sine', frequency, frequency * 0.985, duration, volume)
      // Decompression: a band of noise sweeping down like pressure bleeding out.
      noiseBurst(1.1, 0.5, 5200, 260, 'bandpass', 0.04)
      noiseBurst(0.08, 0.6, 9000, 2000, 'highpass')
    },
    dispose() {
      stopCharge(0.02)
      const now = context.currentTime
      if (grind) {
        grind.gain.gain.setTargetAtTime(0, now, 0.03)
        grind.rumbleGain.gain.setTargetAtTime(0, now, 0.03)
        grind.source.stop(now + 0.3)
        grind.rumble.stop(now + 0.3)
        grind = null
      }
      // Let a breach tail ring out across the screen change before tearing the bus down.
      window.setTimeout(() => bus.disconnect(), 1800)
    },
  }
}

/** Dossier boot: a burst of teleprinter ticks, then a two-tone system confirmation. */
export const playDossierBoot = (context: AudioContext) => {
  const start = context.currentTime + 0.02
  let at = start
  for (let i = 0; i < 14; i += 1) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(2100 + Math.random() * 1300, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.022, at + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.014)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + 0.02)
    at += 0.03 + Math.random() * 0.045
  }
  const pings: Array<[number, number]> = [[880, 0.08], [1320, 0.16]]
  for (const [frequency, offset] of pings) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const when = at + offset
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, when)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(0.06, when + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.16)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(when)
    oscillator.stop(when + 0.18)
  }
}
