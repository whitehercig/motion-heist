import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { plural, t } from '../i18n/i18n'
import { useLang } from '../i18n/useLang'
import { LangToggle } from './LangToggle'
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
  /** The WANTED poster, rendered above the metrics when a snapshot was captured. */
  photo?: ReactNode
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
  if (phase.completed) return { label: t('dossier.statusConfirmed'), tone: 'ok' }
  if (phase.framesAnalyzed > 0) return { label: t('dossier.statusIncomplete'), tone: 'bad' }
  return { label: t('dossier.statusUnreached'), tone: 'muted' }
}

const percentOrDash = (value: number | null) => (value === null ? '—' : `${value}%`)

function RecoveryCard({ entry }: { entry: RecoveryEntry }) {
  const mark = entry.recovered ? '✓' : '✗'
  return (
    <li className={`recovery-card ${entry.recovered ? '' : 'unresolved'}`}>
      <span className="recovery-phase">{t(`move.${entry.gesture}.name`)}</span>
      <p><b>[{mark}]</b> {t('dossier.detected')} {entry.anomaly.title} ({entry.anomaly.current} / {entry.anomaly.target})</p>
      <p><b>[✓]</b> {t('dossier.issued')} “{entry.anomaly.correction}”</p>
      <p>
        <b>[{mark}]</b> {t('dossier.resolution')} {entry.recovered && entry.recoveryMs !== null
          ? t('dossier.confirmedWithin', { t: formatSeconds(entry.recoveryMs) })
          : t('dossier.unresolved')}
      </p>
      <p><b>[{entry.bonus > 0 ? '✓' : '—'}]</b> {t('dossier.bonus')} {entry.bonus > 0 ? t('dossier.bonusApplied', { n: entry.bonus }) : t('dossier.bonusNone')}</p>
      {entry.followUps.length > 0 && (
        <p className="recovery-followups">{t('dossier.followUps')} {entry.followUps.map((followUp) => followUp.title).join(' · ')}</p>
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
  photo,
}: SecurityDossierScreenProps) {
  useLang()
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
      mode: 'story',
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

  const saveMessage = saved ? describeSave(saved, callsign, leaderboard.length) : null

  return (
    <section className="dossier" aria-labelledby="dossier-title">
      <div className="dossier-scan" aria-hidden="true" />

      <header className="dossier-header">
        <div className="dossier-toolbar"><LangToggle /></div>
        <p className="dossier-classified">{t('dossier.classified')}</p>
        <h1 id="dossier-title" className="dossier-typed">{t('dossier.title', { id: telemetry.incidentId })}</h1>
        <dl className="dossier-meta">
          <div><dt>{t('dossier.date')}</dt><dd>{started.toLocaleDateString()}</dd></div>
          <div><dt>{t('dossier.time')}</dt><dd>{started.toLocaleTimeString([], { hour12: false })}</dd></div>
          <div><dt>{t('dossier.operative')}</dt><dd>{telemetry.operative}</dd></div>
          <div><dt>{t('dossier.tracking')}</dt><dd>{telemetry.trackingModes.length ? telemetry.trackingModes.map((mode) => (mode === 'desk' ? t('dossier.desk') : t('dossier.full'))).join(' + ') : '—'}</dd></div>
          <div><dt>{t('dossier.status')}</dt><dd className={breached ? 'status-breach' : 'status-sealed'}>{breached ? t('dossier.compromised') : t('dossier.contained')}</dd></div>
        </dl>
      </header>

      <ul className="jury-checklist" aria-label={t('dossier.criteria')}>
        <li className={report.movementsRecognized >= 3 ? 'ok' : 'bad'}>{report.movementsRecognized >= 3 ? '✓' : '✗'} {t('dossier.movements', { n: report.movementsRecognized, total: report.movementsTotal })} <small>{t('dossier.min3')}</small></li>
        <li className="ok">✓ {t('dossier.errorMode')} <small>{report.anomalies ? t('dossier.errorModeStats', { n: report.anomalies, r: report.recovered, total: report.recoveries.length }) : t('dossier.errorModeArmed')}</small></li>
        <li className="ok">✓ {t('dossier.kinematics')} <small>{t('dossier.frames', { n: telemetry.framesAnalyzed.toLocaleString() })}</small></li>
        <li className="ok">✓ {t('dossier.localBoard')} <small>{t('dossier.records', { n: leaderboard.length })}</small></li>
      </ul>

      {photo}

      <div className="dossier-metrics">
        <div className="metric metric-score"><span>{t('dossier.finalScore')}</span><strong aria-label={t('dossier.points', { n: report.score })}>{score.toLocaleString()}</strong></div>
        <div className="metric"><span>{t('dossier.accuracy')}</span><strong>{report.motionAccuracy}%</strong><small>{t('dossier.accuracyNote')}</small></div>
        <div className="metric"><span>{t('dossier.confidence')}</span><strong>{report.avgConfidence}%</strong><small>{t('dossier.confidenceNote')}</small></div>
        <div className="metric"><span>{t('dossier.missionTime')}</span><strong>{formatMissionTime(report.missionMs)}</strong><small>{!breached ? t('dossier.abandoned') : telemetry.overtimeMs > 0 ? t('dossier.inclOvertime', { t: formatSeconds(telemetry.overtimeMs) }) : t('dossier.startToBreach')}</small></div>
        <div className={`metric metric-rank rank-${report.rank.split(' ')[0].toLowerCase()}`}><span>{t('dossier.rank')}</span><strong>{t(`rank.${report.rank}`)}</strong></div>
      </div>

      <section className="recovery-log" aria-labelledby="recovery-title">
        <h2 id="recovery-title">{t('dossier.recoveryTitle')}</h2>
        {report.recoveries.length ? (
          <>
            <p className="recovery-summary">{t('dossier.recoverySummary', {
              anomalies: plural(report.anomalies, 'dossier.anomaly.one', 'dossier.anomaly.few', 'dossier.anomaly.many'),
              r: report.recovered,
              total: report.recoveries.length,
            })}</p>
            <ol className="recovery-list">{report.recoveries.map((entry) => <RecoveryCard key={entry.gesture} entry={entry} />)}</ol>
          </>
        ) : (
          <div className="recovery-card clean">
            <p><b>[✓]</b> {t('dossier.cleanArmed', { n: report.movementsTotal })}</p>
            <p><b>[✓]</b> {t('dossier.cleanZero')}</p>
            <p><b>[—]</b> {t('dossier.cleanBonus')}</p>
          </div>
        )}
      </section>

      <section className="dossier-panel" aria-labelledby="motion-log-title">
        <h2 id="motion-log-title">{t('dossier.motionLog')} <small>{t('dossier.confirmedCount', { n: report.movementsRecognized, total: report.movementsTotal })}</small></h2>
        <table className="dossier-table motion-table">
          <thead>
            <tr><th>#</th><th>{t('dossier.col.movement')}</th><th>{t('dossier.col.status')}</th><th className="optional">{t('dossier.col.reaction')}</th><th>{t('dossier.col.time')}</th><th>{t('dossier.col.sync')}</th><th className="optional">{t('dossier.col.conf')}</th><th>{t('dossier.col.err')}</th></tr>
          </thead>
          <tbody>
            {phases.map((phase) => {
              const status = phaseStatus(phase)
              return (
                <tr key={phase.gesture} className={`tone-${status.tone}`}>
                  <td>0{phase.index + 1}</td>
                  <td>{t(`move.${phase.gesture}.name`)}</td>
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

      <LeaderboardPanel
        leaderboard={leaderboard}
        title={t('dossier.top10')}
        callsign={callsign}
        onCallsign={setCallsign}
        saved={saved}
        saveMessage={saveMessage}
        onSubmit={saveEntry}
      />

      <div className="dossier-actions">
        <button className="dossier-button audit" onClick={() => void copyAudit()}>
          {copyState === 'copied' ? t('dossier.copied') : copyState === 'failed' ? t('dossier.copyFailed') : t('dossier.copy')}
        </button>
        <button className="dossier-button replay" onClick={onReplay}>
          {t('dossier.replay')}{replayHint && <small className="replay-hint">{replayHint}</small>}
        </button>
        <button className="dossier-button ghost" onClick={onExit}>{t('common.lobby')}</button>
      </div>
      <details className="audit-raw" open={copyState === 'failed'}>
        <summary>{t('dossier.rawJson')}</summary>
        <pre>{auditJson}</pre>
      </details>
    </section>
  )
}

export const describeSave = (saved: SaveResult, callsign: string, boardSize: number) =>
  saved.position === null
    ? t('dossier.belowTop', { c: callsign, n: boardSize })
    : `${t('dossier.loggedRank', { c: callsign, p: saved.position })}${saved.position === 1 ? t('dossier.newRecord') : ''}${saved.persisted ? '' : t('dossier.storageBlocked')}`

interface LeaderboardPanelProps {
  leaderboard: LeaderboardEntry[]
  title: string
  callsign: string
  onCallsign: (value: string) => void
  saved: { id: string } | null
  saveMessage: string | null
  onSubmit: (event: FormEvent) => void
}

/** Top-10 table with the three-letter callsign form; shared by the heist dossier and the arcade debrief. */
export function LeaderboardPanel({ leaderboard, title, callsign, onCallsign, saved, saveMessage, onSubmit }: LeaderboardPanelProps) {
  return (
    <section className="dossier-panel" aria-labelledby="leaderboard-title">
      <h2 id="leaderboard-title">{title} <small>{t('dossier.localNote')}</small></h2>
      <form className="callsign-form" onSubmit={onSubmit}>
        <label htmlFor="callsign">{t('dossier.codename')}</label>
        <input
          id="callsign"
          value={callsign}
          onChange={(event) => onCallsign(normalizeCallsign(event.target.value))}
          maxLength={CALLSIGN_LENGTH}
          placeholder="NEO"
          autoComplete="off"
          spellCheck={false}
          disabled={saved !== null}
          aria-describedby="callsign-help"
        />
        <button type="submit" disabled={saved !== null || callsign.length !== CALLSIGN_LENGTH}>{saved ? t('dossier.logged') : t('dossier.log')}</button>
        <p id="callsign-help" className={saved ? 'callsign-saved' : ''} aria-live="polite">{saveMessage ?? t('dossier.letters', { n: CALLSIGN_LENGTH })}</p>
      </form>
      {leaderboard.length ? (
        <table className="dossier-table leaderboard-table">
          <thead><tr><th>{t('dossier.col.rank')}</th><th>{t('dossier.col.codename')}</th><th>{t('dossier.col.score')}</th><th>{t('dossier.col.acc')}</th><th className="optional">{t('dossier.col.date')}</th></tr></thead>
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
        <p className="dossier-empty">{t('dossier.empty')}</p>
      )}
    </section>
  )
}
