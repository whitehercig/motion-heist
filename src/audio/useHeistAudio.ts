import { useCallback, useEffect, useRef } from 'react'
import { startMusic, type MusicController } from './music'
import { isMuted, subscribeMuted } from './soundSettings'
import { playDossierBoot, playElectricZap, playLockBlip } from './soundEngine'

export type SoundCue = 'click' | 'scan' | 'success' | 'error' | 'laser' | 'unlock' | 'countdown' | 'score' | 'zap' | 'blip' | 'boot' | 'warn' | 'gem' | 'perfect' | 'levelUp'

type Recipe = [number, number, number, OscillatorType]

const recipes: Record<Exclude<SoundCue, 'zap' | 'blip' | 'boot' | 'gem' | 'perfect' | 'levelUp'>, Recipe> = {
  click: [330, 0.045, 0.035, 'square'],
  scan: [210, 0.16, 0.045, 'sine'],
  success: [720, 0.12, 0.06, 'sine'],
  error: [126, 0.18, 0.07, 'sawtooth'],
  laser: [310, 0.14, 0.04, 'sawtooth'],
  unlock: [440, 0.22, 0.07, 'triangle'],
  countdown: [520, 0.08, 0.05, 'square'],
  score: [840, 0.09, 0.04, 'sine'],
  warn: [980, 0.05, 0.03, 'square'],
}

/** Rising arpeggios: diamond pickup, perfect dodge, speed-up fanfare. */
const ARPEGGIOS: Record<'gem' | 'perfect' | 'levelUp', { notes: number[]; step: number; type: OscillatorType; volume: number }> = {
  gem: { notes: [1318.5, 1760, 2637], step: 0.045, type: 'triangle', volume: 0.06 },
  perfect: { notes: [880, 1108.7, 1318.5, 1760], step: 0.04, type: 'sine', volume: 0.07 },
  levelUp: { notes: [440, 554.4, 659.3, 880, 1108.7], step: 0.07, type: 'square', volume: 0.04 },
}

const blip = (context: AudioContext, [frequency, duration, volume, type]: Recipe, at: number, slide?: number) => {
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = type
  oscillator.frequency.setValueAtTime(frequency, at)
  if (slide) oscillator.frequency.exponentialRampToValueAtTime(frequency * slide, at + duration)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(at)
  oscillator.stop(at + duration + 0.02)
}

export const useHeistAudio = () => {
  const contextRef = useRef<AudioContext | null>(null)
  const musicRef = useRef<MusicController | null>(null)

  /** Shared context for voices that live longer than a cue (e.g. the vault sequence). Muting suspends it. */
  const getContext = useCallback(() => {
    if (!contextRef.current) contextRef.current = new AudioContext()
    if (contextRef.current.state === 'suspended' && !isMuted()) void contextRef.current.resume()
    return contextRef.current
  }, [])

  useEffect(() => subscribeMuted(() => {
    const context = contextRef.current
    if (!context) return
    void (isMuted() ? context.suspend() : context.resume())
  }), [])

  const play = useCallback((cue: SoundCue) => {
    if (isMuted()) return
    try {
      const context = getContext()
      if (cue === 'zap') return playElectricZap(context)
      if (cue === 'blip') return playLockBlip(context)
      if (cue === 'boot') return playDossierBoot(context)
      if (cue === 'gem' || cue === 'perfect' || cue === 'levelUp') {
        const { notes, step, type, volume } = ARPEGGIOS[cue]
        notes.forEach((frequency, index) => blip(context, [frequency, step * 2.2, volume, type], context.currentTime + index * step))
        return
      }
      const recipe = recipes[cue]
      const slide = cue === 'success' || cue === 'unlock' ? 1.45 : cue === 'error' ? 0.62 : undefined
      blip(context, recipe, context.currentTime, slide)
    } catch {
      // Audio is progressive enhancement; the heist stays playable without it.
    }
  }, [getContext])

  /** One soundtrack at a time; starting again only retunes it. */
  const startSoundtrack = useCallback((bpm: number, intensity: number) => {
    try {
      const context = getContext()
      if (!musicRef.current) musicRef.current = startMusic(context, bpm)
      musicRef.current.setTempo(bpm)
      musicRef.current.setIntensity(intensity)
    } catch {
      // No Web Audio: play in silence.
    }
  }, [getContext])

  const tuneSoundtrack = useCallback((bpm: number, intensity: number) => {
    musicRef.current?.setTempo(bpm)
    musicRef.current?.setIntensity(intensity)
  }, [])

  const stopSoundtrack = useCallback(() => {
    musicRef.current?.stop()
    musicRef.current = null
  }, [])

  useEffect(() => () => { musicRef.current?.stop() }, [])

  return { play, getContext, startSoundtrack, tuneSoundtrack, stopSoundtrack }
}
