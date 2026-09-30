import { getLang, t, type Params, type StringKey } from '../i18n/i18n'
import { isMuted } from './soundSettings'

/** Don't let the announcer talk over itself: a newer line waits for this gap. */
const MIN_GAP_MS = 900
let lastSpokenAt = 0

const pickVoice = (lang: string) => {
  try {
    const voices = window.speechSynthesis.getVoices()
    return voices.find((voice) => voice.lang.toLowerCase().startsWith(lang)) ?? null
  } catch {
    return null
  }
}

/**
 * Short announcer lines through the browser's own speech engine. Pure
 * progressive enhancement: no voice for the language, muted, or no API
 * means silence, never an error.
 */
export const announce = (key: StringKey, params?: Params, urgent = false) => {
  if (isMuted()) return
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const now = performance.now()
    if (!urgent && now - lastSpokenAt < MIN_GAP_MS) return
    const lang = getLang()
    const voice = pickVoice(lang)
    if (!voice) return
    lastSpokenAt = now
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(t(key, params))
    utterance.voice = voice
    utterance.lang = voice.lang
    utterance.rate = 1.12
    utterance.pitch = 0.9
    utterance.volume = 0.9
    synth.speak(utterance)
  } catch {
    // Speech is a bonus.
  }
}

/** Chrome loads the voice list asynchronously; touching it early warms it up. */
export const warmUpVoices = () => {
  try {
    window.speechSynthesis?.getVoices()
  } catch {
    // ignore
  }
}
