import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'motion-heist-muted'

const readMuted = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

let muted = readMuted()
const listeners = new Set<() => void>()

export const isMuted = () => muted

export const setMuted = (value: boolean) => {
  if (value === muted) return
  muted = value
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // Storage blocked: the choice still holds for this session.
  }
  listeners.forEach((listener) => listener())
}

export const subscribeMuted = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const useMuted = () => useSyncExternalStore(subscribeMuted, isMuted, isMuted)
