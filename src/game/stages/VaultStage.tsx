import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { playVaultSequence, type VaultSequence } from '../../audio/soundEngine'
import { VaultDoorsOverlay } from '../../components/VaultDoorsOverlay'
import { VAULT_LOCK_MS } from '../../motion/vaultBreach'
import type { VaultPhase, VaultReading } from '../../types/game'

interface VaultStageProps {
  videoRef: RefObject<HTMLVideoElement | null>
  feedRef: RefObject<VaultReading | null>
  getAudioContext: () => AudioContext
}

const STATUS: Record<VaultPhase, string> = {
  align: 'PALM LOCK: PLACE BOTH PALMS ON THE SCANNERS',
  locking: 'PALM LOCK: HOLD STILL — CHARGING',
  breaching: 'BREACH READY: PULL ARMS APART',
  breached: 'VAULT BREACHED',
}
const RELEASE_HINT = "DON'T RELEASE — PULL WIDER"
const HINT_MS = 2600

const vibrate = (pattern: number | number[]) => {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern)
  } catch {
    // Haptics are a bonus; laptops simply ignore them.
  }
}

/**
 * The finale: PALM LOCK -> KINETIC BREACH. Mounted only while VAULT_BREACH is
 * the target. It turns the engine's vault state into sound, haptics and the
 * status/banner layer; the doors themselves live in VaultDoorsOverlay.
 */
export function VaultStage({ videoRef, feedRef, getAudioContext }: VaultStageProps) {
  const [phase, setPhase] = useState<VaultPhase>('align')
  const [hint, setHint] = useState<string | null>(null)
  const [breached, setBreached] = useState(false)
  const sequenceRef = useRef<VaultSequence | null>(null)

  const handleImpact = useCallback((strength: number) => {
    sequenceRef.current?.slamShut(strength)
    vibrate(Math.round(30 + 50 * strength))
  }, [])

  useEffect(() => {
    let sequence: VaultSequence | null = null
    try {
      sequence = playVaultSequence(getAudioContext())
    } catch {
      sequence = null
    }
    sequenceRef.current = sequence

    // The reading keeps transition timestamps, so comparing against what we've
    // already reacted to can't miss an event even if two pose frames land between paints.
    const seen: { lockStartedAt: number | null; lockedAt: number | null; releasedAt: number | null; breachedAt: number | null } = {
      lockStartedAt: null,
      lockedAt: null,
      releasedAt: null,
      breachedAt: null,
    }
    let charging = false
    let grinding = false
    let shownPhase: VaultPhase = 'align'
    let lastTimestamp = 0
    let lastProgress = 0
    let speed = 0
    let hintTimer = 0
    let frameId = 0

    const tick = () => {
      frameId = requestAnimationFrame(tick)
      const reading = feedRef.current
      if (!reading) return

      if (reading.phase === 'locking' && reading.lockStartedAt !== seen.lockStartedAt) {
        seen.lockStartedAt = reading.lockStartedAt
        sequence?.startCharge(VAULT_LOCK_MS)
        charging = true
      }
      if (charging && reading.phase === 'align') {
        sequence?.cancelCharge()
        charging = false
      }
      if (reading.lockedAt !== null && reading.lockedAt !== seen.lockedAt) {
        seen.lockedAt = reading.lockedAt
        charging = false
        sequence?.completeCharge()
        vibrate(60)
        window.clearTimeout(hintTimer)
        setHint(null)
      }
      if (reading.releasedAt !== null && reading.releasedAt !== seen.releasedAt) {
        seen.releasedAt = reading.releasedAt
        setHint(RELEASE_HINT)
        window.clearTimeout(hintTimer)
        hintTimer = window.setTimeout(() => setHint(null), HINT_MS)
      }
      if (reading.breachedAt !== null && reading.breachedAt !== seen.breachedAt) {
        seen.breachedAt = reading.breachedAt
        sequence?.stopGrind()
        grinding = false
        sequence?.breach()
        vibrate([90, 40, 180])
        setBreached(true)
      }

      if (reading.phase === 'breaching') {
        if (reading.timestamp !== lastTimestamp) {
          const dt = (reading.timestamp - lastTimestamp) / 1000
          if (lastTimestamp && dt > 0 && dt < 0.25) speed += (Math.abs(reading.breachProgress - lastProgress) / dt - speed) * 0.5
          lastTimestamp = reading.timestamp
          lastProgress = reading.breachProgress
          sequence?.setGrind(reading.breachProgress, speed)
          grinding = true
        }
      } else if (grinding) {
        sequence?.stopGrind()
        grinding = false
        lastTimestamp = 0
        speed = 0
      }

      if (reading.phase !== shownPhase) {
        shownPhase = reading.phase
        setPhase(reading.phase)
      }
    }
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      window.clearTimeout(hintTimer)
      sequence?.dispose()
      sequenceRef.current = null
    }
  }, [feedRef, getAudioContext])

  return (
    <>
      <VaultDoorsOverlay videoRef={videoRef} feedRef={feedRef} onImpact={handleImpact} />
      {!breached && <div className={`vault-status vault-status-${phase}`} role="status" aria-live="polite">{STATUS[phase]}</div>}
      {hint && !breached && <div className="vault-hint" role="alert">⚠ {hint}</div>}
      {breached && (
        <>
          <div className="screen-flash" aria-hidden="true" />
          <div className="vault-banner" role="status"><b>VAULT BREACHED</b><span>—</span><b>MISSION ACCOMPLISHED</b></div>
        </>
      )}
    </>
  )
}
