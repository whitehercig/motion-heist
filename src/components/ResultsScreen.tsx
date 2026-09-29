import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { buildAuditReport, formatMissionTime, formatSeconds } from '../scoring/scoringEngine'
import {
  CALLSIGN_LENGTH,
  formatEntryDate,
  getLeaderboard,
  normalizeCallsign,
  saveScore,
  type SaveResult,
} from '../scoring/leaderboardStorage'
import type { LeaderboardEntry } from '../types/game'
import type { DossierReport, PhaseTelemetry, RecoveryEntry } from '../types/scoring'

interface SecurityDossierScreenProps {
  report: DossierReport
  /** Pre-fills the callsign field (e.g. from the operative name on the landing screen). */
  defaultCallsign: string
  onReplay: () => void
  /** Shown under the replay button when the camera is still live (hands-free replay). */
  replayHint?: string
  onExit: () => void
  /** Lets the app keep its own leaderboard view in sync after a save. */
  onLeaderboardChange?: (entries: LeaderboardEntry[]) => void
  onBoot?: () => void
  onConfirm?: () => void
}

type CopyState = 'idle' | 'copied' | 'failed'

const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Ease-out count-up for the headline score; instant when the user prefers reduced motion. */
const useCountUp = (target: number, durationMs = 1500) => {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0))
  useEffect(() => {
    if (prefersReducedMotion() || target <= 0) {
      setValue(target)
      return
    }
    let frameId = 0
    const started = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / durationMs)
      setValue(Math.round(target * (1 - (1 - t) ** 3)))
      if (t < 1) frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [target, durationMs])
  return value
}

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs a secure, focused context; fall back to a hidden textarea.
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const copied = document.execCommand('copy')
      area.remove()
      return copied
    } catch {
      return false
    }
  }
}

const phaseStatus = (phase: PhaseTelemetry) => {
  if (phase.completed) return { label: '✓ CONFIRMED', tone: 'ok' }
  if (phase.framesAnalyzed > 0) return { label: '✗ INCOMPLETE', tone: 'bad' }
  return { label: '— NOT REACHED', tone: 'muted' }
}

const percentOrDash = (value: number | null) => (value === null ? '—' : `${value}%`)

function RecoveryCard({ entry }: { entry: RecoveryEntry }) {
  const mark = entry.recovered ? '✓' : '✗'
  return (
    <li className={`recovery-card ${entry.recovered ? '' : 'unresolved'}`}>
      <span className="recovery-phase">{entry.objective}</span>
      <p><b>[{mark}]</b> DETECTED ANOMALY: {entry.anomaly.title} ({entry.anomaly.current} / {entry.anomaly.target})</p>
      <p><b>[✓]</b> ADAPTIVE CORRECTION ISSUED: “{entry.anomaly.correction}”</p>
      <p>
        <b>[{mark}]</b> RECOVERY RESOLUTION: {entry.recovered && entry.recoveryMs !== null
          ? `CONFIRMED WITHIN ${formatSeconds(entry.recoveryMs)}`
          : 'UNRESOLVED — SESSION ENDED'}
      </p>
      <p><b>[{entry.bonus > 0 ? '✓' : '—'}]</b> ERROR RECOVERY BONUS: {entry.bonus > 0 ? `+${entry.bonus} PTS APPLIED` : 'NOT AWARDED'}</p>
      {entry.followUps.length > 0 && (
        <p className="recovery-followups">ALSO FLAGGED IN THIS PHASE: {entry.followUps.map((followUp) => followUp.title).join(' · ')}</p>
      )}
    </li>
  )
}

/**
 * MISSION DEBRIEF styled as a cyber-bank incident dossier. Every block maps
 * to a judging criterion: movements recognized, Error Mode with recovery,
 * kinematic metrics, and the local leaderboard; plus a one-click audit export.
 */
export function SecurityDossierScreen({
  report,
  defaultCallsign,
  onReplay,
  replayHint,
  onExit,
  onLeaderboardChange,
  onBoot,
  onConfirm,
}: SecurityDossierScreenProps) {
  const { telemetry } = report
  const score = useCountUp(report.score)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() => getLeaderboard())
  const [callsign, setCallsign] = useState(() => normalizeCallsign(defaultCallsign))
  const [saved, setSaved] = useState<(SaveResult & { id: string }) | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const bootedRef = useRef(false)
  const onBootRef = useRef(onBoot)

  useEffect(() => {
    // Refs survive StrictMode's double effect run, so the boot sound plays once.
    if (bootedRef.current) return
    bootedRef.current = true
    onBootRef.current?.()
  }, [])

  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2400)
    return () => window.clearTimeout(timer)
  }, [copyState])

  const started = useMemo(() => new Date(telemetry.startedAt), [telemetry.startedAt])
  const breached = telemetry.outcome === 'breached'
  const auditJson = useMemo(() => JSON.stringify(buildAuditReport(report, leaderboard.length), null, 2), [report, leaderboard.length])
  const phases = telemetry.phases

  const saveEntry = (event: FormEvent) => {
    event.preventDefault()
    if (saved || callsign.length !== CALLSIGN_LENGTH) return
    const entry: LeaderboardEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      nickname: callsign,
      score: report.score,
      accuracy: report.motionAccuracy,
      time: Math.round(report.missionMs / 1000),
      date: new Date().toISOString(),
      style: report.rank,
    }
    const result = saveScore(entry)
    setSaved({ ...result, id: entry.id })
    setLeaderboard(result.entries)
    onLeaderboardChange?.(result.entries)
    onConfirm?.()
  }

  const copyAudit = async () => {
    const copied = await copyText(auditJson)
    setCopyState(copied ? 'copied' : 'failed')
    if (copied) onConfirm?.()
  }

  const saveMessage = saved
    ? saved.position === null
      ? `LOGGED AS ${callsign} — BELOW THE TOP ${leaderboard.length}, NOT RECORDED`
      : `LOGGED AS ${callsign} — RANK #${saved.position}${saved.position === 1 ? ' · NEW RECORD' : ''}${saved.persisted ? '' : ' (STORAGE BLOCKED: THIS SESSION ONLY)'}`
    : null

  return (
    <section className="dossier" aria-labelledby="dossier-title">
      <div className="dossier-scan" aria-hidden="true" />

      <header className="dossier-header">
        <p className="dossier-classified">CLASSIFIED //</p>
        <h1 id="dossier-title" className="dossier-typed">INCIDENT REPORT {telemetry.incidentId}</h1>
        <dl className="dossier-meta">
          <div><dt>DATE</dt><dd>{started.toLocaleDateString()}</dd></div>
          <div><dt>TIME</dt><dd>{started.toLocaleTimeString([], { hour12: false })}</dd></div>
          <div><dt>OPERATIVE</dt><dd>{telemetry.operative}</dd></div>
          <div><dt>TRACKING</dt><dd>{telemetry.trackingModes.length ? telemetry.trackingModes.map((mode) => (mode === 'desk' ? 'DESK' : 'FULL-BODY')).join(' + ') : '—'}</dd></div>
          <div><dt>STATUS</dt><dd className={breached ? 'status-breach' : 'status-sealed'}>{breached ? 'VAULT COMPROMISED' : 'INTRUSION CONTAINED'}</dd></div>
        </dl>
      </header>

      <ul className="jury-checklist" aria-label="Judging criteria">
        <li className={report.movementsRecognized >= 3 ? 'ok' : 'bad'}>{report.movementsRecognized >= 3 ? '✓' : '✗'} {report.movementsRecognized}/{report.movementsTotal} MOVEMENTS RECOGNIZED <small>MIN 3</small></li>
        <li className="ok">✓ ERROR MODE <small>{report.anomalies ? `${report.anomalies} DIAGNOSED · ${report.recovered}/${report.recoveries.length} RECOVERED` : 'ARMED · 0 TRIGGERED'}</small></li>
        <li className="ok">✓ KINEMATICS <small>{telemetry.framesAnalyzed.toLocaleString()} FRAMES ANALYZED</small></li>
        <li className="ok">✓ LOCAL LEADERBOARD <small>{leaderboard.length}/10 RECORDS</small></li>
      </ul>

      <div className="dossier-metrics">
        <div className="metric metric-score"><span>FINAL SCORE</span><strong aria-label={`${report.score} points`}>{score.toLocaleString()}</strong></div>
        <div className="metric"><span>MOTION ACCURACY</span><strong>{report.motionAccuracy}%</strong><small>MEAN COSINE POSE SIMILARITY</small></div>
        <div className="metric"><span>AVG CV CONFIDENCE</span><strong>{report.avgConfidence}%</strong><small>MEAN LANDMARK VISIBILITY</small></div>
        <div className="metric"><span>MISSION TIME</span><strong>{formatMissionTime(report.missionMs)}</strong><small>{!breached ? 'SESSION ABANDONED' : telemetry.overtimeMs > 0 ? `INCL. ${formatSeconds(telemetry.overtimeMs)} OVERTIME` : 'START → VAULT BREACH'}</small></div>
        <div className={`metric metric-rank rank-${report.rank.split(' ')[0].toLowerCase()}`}><span>OPERATIVE RANK</span><strong>{report.rank}</strong></div>
      </div>

      <section className="recovery-log" aria-labelledby="recovery-title">
        <h2 id="recovery-title">🛡 AI ERROR DIAGNOSTICS &amp; RECOVERY LOG</h2>
        {report.recoveries.length ? (
          <>
            <p className="recovery-summary">{report.anomalies} ANOMAL{report.anomalies === 1 ? 'Y' : 'IES'} DETECTED · {report.recovered}/{report.recoveries.length} PHASE{report.recoveries.length === 1 ? '' : 'S'} RECOVERED</p>
            <ol className="recovery-list">{report.recoveries.map((entry) => <RecoveryCard key={entry.objective} entry={entry} />)}</ol>
          </>
        ) : (
          <div className="recovery-card clean">
            <p><b>[✓]</b> DIAGNOSTICS ARMED ON ALL {report.movementsTotal} MOVEMENTS</p>
            <p><b>[✓]</b> ANOMALIES DETECTED: 0 — CLEAN INFILTRATION</p>
            <p><b>[—]</b> ERROR RECOVERY BONUS: NOT REQUIRED</p>
          </div>
        )}
      </section>

      <section className="dossier-panel" aria-labelledby="motion-log-title">
        <h2 id="motion-log-title">MOTION SIGNATURE LOG <small>{report.movementsRecognized}/{report.movementsTotal} CONFIRMED</small></h2>
        <table className="dossier-table motion-table">
          <thead>
            <tr><th>#</th><th>MOVEMENT</th><th>STATUS</th><th className="optional">REACTION</th><th>TIME</th><th>SYNC</th><th className="optional">CONF</th><th>ERR</th></tr>
          </thead>
          <tbody>
            {phases.map((phase) => {
              const status = phaseStatus(phase)
              return (
                <tr key={phase.gesture} className={`tone-${status.tone}`}>
                  <td>0{phase.index + 1}</td>
                  <td>{phase.objective}</td>
                  <td className="status-cell">{status.label}</td>
                  <td className="optional">{formatSeconds(phase.reactionMs)}</td>
                  <td>{formatSeconds(phase.durationMs)}</td>
                  <td>{percentOrDash(phase.motionMatch)}</td>
                  <td className="optional">{phase.avgConfidence === null ? '—' : `${Math.round(phase.avgConfidence * 100)}%`}</td>
                  <td className={phase.anomalies.length ? 'err-cell' : ''}>{phase.anomalies.length}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="dossier-panel" aria-labelledby="leaderboard-title">
        <h2 id="leaderboard-title">TOP-10 HEISTS <small>LOCAL · THIS BROWSER</small></h2>
        <form className="callsign-form" onSubmit={saveEntry}>
          <label htmlFor="callsign">CODENAME</label>
          <input
            id="callsign"
            value={callsign}
            onChange={(event) => setCallsign(normalizeCallsign(event.target.value))}
            maxLength={CALLSIGN_LENGTH}
            placeholder="NEO"
            autoComplete="off"
            spellCheck={false}
            disabled={saved !== null}
            aria-describedby="callsign-help"
          />
          <button type="submit" disabled={saved !== null || callsign.length !== CALLSIGN_LENGTH}>{saved ? 'LOGGED ✓' : 'LOG RESULT'}</button>
          <p id="callsign-help" className={saved ? 'callsign-saved' : ''} aria-live="polite">{saveMessage ?? `${CALLSIGN_LENGTH} LETTERS, A–Z`}</p>
        </form>
        {leaderboard.length ? (
          <table className="dossier-table leaderboard-table">
            <thead><tr><th>RANK</th><th>CODENAME</th><th>SCORE</th><th>ACC</th><th className="optional">DATE</th></tr></thead>
            <tbody>
              {leaderboard.map((entry, index) => (
                <tr key={entry.id} className={entry.id === saved?.id ? 'current-entry' : ''}>
                  <td>{String(index + 1).padStart(2, '0')}</td>
                  <td>{entry.nickname}</td>
                  <td>{entry.score.toLocaleString()}</td>
                  <td>{entry.accuracy}%</td>
                  <td className="optional">{formatEntryDate(entry.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dossier-empty">NO RECORDS ON FILE. LOG THIS HEIST TO OPEN THE BOARD.</p>
        )}
      </section>

      <div className="dossier-actions">
        <button className="dossier-button audit" onClick={() => void copyAudit()}>
          {copyState === 'copied' ? 'AUDIT REPORT COPIED ✓' : copyState === 'failed' ? 'COPY BLOCKED — SEE RAW JSON BELOW' : 'COPY JURY AUDIT REPORT'}
        </button>
        <button className="dossier-button replay" onClick={onReplay}>
          REPLAY HEIST ↻{replayHint && <small className="replay-hint">{replayHint}</small>}
        </button>
        <button className="dossier-button ghost" onClick={onExit}>EXIT TO LOBBY</button>
      </div>
      <details className="audit-raw" open={copyState === 'failed'}>
        <summary>VIEW RAW AUDIT JSON</summary>
        <pre>{auditJson}</pre>
      </details>
    </section>
  )
}
