import { useCallback, useRef } from 'react'
import { playDossierBoot, playElectricZap, playLockBlip } from './soundEngine'

export type SoundCue = 'click' | 'scan' | 'success' | 'error' | 'laser' | 'unlock' | 'countdown' | 'score' | 'zap' | 'blip' | 'boot'

const recipes: Record<Exclude<SoundCue, 'zap' | 'blip' | 'boot'>, [number, number, number, OscillatorType]> = {
  click: [330, 0.045, 0.035, 'square'],
  scan: [210, 0.16, 0.045, 'sine'],
  success: [720, 0.12, 0.06, 'sine'],
  error: [126, 0.18, 0.07, 'sawtooth'],
  laser: [310, 0.14, 0.04, 'sawtooth'],
  unlock: [440, 0.22, 0.07, 'triangle'],
  countdown: [520, 0.08, 0.05, 'square'],
  score: [840, 0.09, 0.04, 'sine'],
}

export const useHeistAudio = () => {
  const contextRef = useRef<AudioContext | null>(null)
  /** Shared context for voices that live longer than a cue (e.g. the vault sequence). */
  const getContext = useCallback(() => {
    if (!contextRef.current) contextRef.current = new AudioContext()
    if (contextRef.current.state === 'suspended') void contextRef.current.resume()
    return contextRef.current
  }, [])
  const play = useCallback((cue: SoundCue) => {
    try {
      const context = getContext()
      if (cue === 'zap' || cue === 'blip' || cue === 'boot') {
        if (cue === 'zap') playElectricZap(context)
        else if (cue === 'blip') playLockBlip(context)
        else playDossierBoot(context)
        return
      }
      const [frequency, duration, volume, type] = recipes[cue]
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = type
      oscillator.frequency.setValueAtTime(frequency, context.currentTime)
      if (cue === 'success' || cue === 'unlock') oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.45, context.currentTime + duration)
      if (cue === 'error') oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.62, context.currentTime + duration)
      gain.gain.setValueAtTime(0.0001, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + duration + 0.02)
    } catch {
      // Audio is progressive enhancement; the heist stays playable without it.
    }
  }, [getContext])
  return { play, getContext }
}
