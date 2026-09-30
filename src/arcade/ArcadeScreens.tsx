import { useState, type FormEvent } from 'react'
import { describeSave, LeaderboardPanel } from '../components/ResultsScreen'
import { LangToggle } from '../components/LangToggle'
import { PhotoFinish } from '../components/PhotoFinish'
import { t } from '../i18n/i18n'
import { useLang } from '../i18n/useLang'
import { getLeaderboard, normalizeCallsign, saveScore, CALLSIGN_LENGTH, type SaveResult } from '../scoring/leaderboardStorage'
import type { LeaderboardEntry } from '../types/game'
import type { ArcadeResult } from './ArcadeStage'

export const hitRate = (result: ArcadeResult) => {
  const { dodged, hits } = result.stats
  return dodged + hits ? Math.round((dodged / (dodged + hits)) * 100) : 0
}

function StatGrid({ result }: { result: ArcadeResult }) {
  const { stats } = result
  return (
    <div className="arcade-stats">
      <div><span>{t('arcade.dodged')}</span><b>{stats.dodged}</b></div>
      <div><span>{t('arcade.diamonds')}</span><b>💎 {stats.diamonds}</b></div>
      <div><span>{t('arcade.perfects')}</span><b>{stats.perfects}</b></div>
      <div><span>{t('arcade.bestCombo')}</span><b>{stats.bestCombo}</b></div>
      <div><span>{t('arcade.accuracy')}</span><b>{hitRate(result)}%</b></div>
      <div><span>{t('arcade.survival')}</span><b>+{stats.survivalBonus}</b></div>
    </div>
  )
}

/** The hands-up gesture meter shared by every post-run screen. */
function GestureHint({ progress, label }: { progress: number; label: string }) {
  return (
    <p className="gesture-hint">
      <span>{progress > 0 ? t('common.holdProgress', { n: Math.round(progress * 100) }) : label}</span>
      <i><b style={{ width: `${progress * 100}%` }} /></i>
    </p>
  )
}

interface ArcadeResultsProps {
  result: ArcadeResult
  name: string
  replayProgress: number
  onReplay: () => void
  onExit: () => void
  onConfirm: () => void
}

export function ArcadeResultsScreen({ result, name, replayProgress, onReplay, onExit, onConfirm }: ArcadeResultsProps) {
  useLang()
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() => getLeaderboard('arcade'))
  const [callsign, setCallsign] = useState(() => normalizeCallsign(name))
  const [saved, setSaved] = useState<(SaveResult & { id: string }) | null>(null)

  const saveEntry = (event: FormEvent) => {
    event.preventDefault()
    if (saved || callsign.length !== CALLSIGN_LENGTH) return
    const entry: LeaderboardEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      nickname: callsign,
      score: result.stats.score,
      accuracy: hitRate(result),
      time: Math.round(result.durationMs / 1000),
      date: new Date().toISOString(),
      style: 'LASER RUSH',
      mode: 'arcade',
    }
    const saveResult = saveScore(entry)
    setSaved({ ...saveResult, id: entry.id })
    setLeaderboard(saveResult.entries)
    onConfirm()
  }

  return (
    <section className="dossier arcade-debrief" aria-labelledby="arcade-title">
      <header className="dossier-header">
        <div className="dossier-toolbar"><LangToggle /></div>
        <p className="dossier-classified">{t('arcade.results')}</p>
        <h1 id="arcade-title" className="arcade-debrief-title">{t(result.outcome === 'survived' ? 'arcade.done' : 'arcade.over')}</h1>
      </header>
      <div className="arcade-debrief-body">
        <PhotoFinish snapshot={result.snapshot} name={name} score={result.stats.score} crime="arcade" />
        <div>
          <div className="metric metric-score"><span>{t('dossier.finalScore')}</span><strong>{result.stats.score.toLocaleString()}</strong></div>
          <StatGrid result={result} />
          <div className="dossier-actions">
            <button className="dossier-button replay" onClick={onReplay}>{t('arcade.again')}</button>
            <button className="dossier-button ghost" onClick={onExit}>{t('common.lobby')}</button>
          </div>
          <GestureHint progress={replayProgress} label={t('common.replayGesture')} />
        </div>
      </div>
      <LeaderboardPanel
        leaderboard={leaderboard}
        title={t('dossier.top10Arcade')}
        callsign={callsign}
        onCallsign={setCallsign}
        saved={saved}
        saveMessage={saved ? describeSave(saved, callsign, leaderboard.length) : null}
        onSubmit={saveEntry}
      />
    </section>
  )
}

interface DuelSwapProps {
  first: ArcadeResult
  progress: number
  onStart: () => void
  onExit: () => void
}

export function DuelSwapScreen({ first, progress, onStart, onExit }: DuelSwapProps) {
  useLang()
  return (
    <section className="duel-panel" aria-labelledby="duel-swap-title">
      <p className="eyebrow"><span className="live-dot" /> {t('mode.duel')} · {t('common.player', { n: 1 })} ✓</p>
      <h1 id="duel-swap-title">{t('duel.swapTitle')}</h1>
      <p className="duel-text">{t('duel.swapText', { score: first.stats.score.toLocaleString() })}</p>
      <PhotoFinish snapshot={first.snapshot} name={t('common.player', { n: 1 })} score={first.stats.score} crime="arcade" compact />
      <button className="primary-button compact" onClick={onStart}>{t('duel.start2')} →</button>
      <GestureHint progress={progress} label={t('duel.swapHint')} />
      <button className="quiet-button duel-exit" onClick={onExit}>{t('common.lobby')}</button>
    </section>
  )
}

interface DuelResultProps {
  results: [ArcadeResult, ArcadeResult]
  progress: number
  onRematch: () => void
  onExit: () => void
}

export function DuelResultScreen({ results, progress, onRematch, onExit }: DuelResultProps) {
  useLang()
  const [one, two] = results
  const winner = one.stats.score === two.stats.score ? 0 : one.stats.score > two.stats.score ? 1 : 2
  return (
    <section className="duel-panel duel-result" aria-labelledby="duel-result-title">
      <p className="eyebrow"><span className="live-dot" /> {t('duel.result')}</p>
      <h1 id="duel-result-title">{winner ? t('duel.wins', { player: t('common.player', { n: winner }) }) : t('duel.draw')}</h1>
      <div className="duel-versus">
        {results.map((result, index) => (
          <div key={index} className={`duel-side ${winner === index + 1 ? 'winner' : ''}`}>
            {winner === index + 1 && <span className="duel-crown" aria-hidden="true">👑</span>}
            <PhotoFinish snapshot={result.snapshot} name={t('common.player', { n: index + 1 })} score={result.stats.score} crime="arcade" compact />
            <strong>{result.stats.score.toLocaleString()}</strong>
            <small>💎 {result.stats.diamonds} · {t('arcade.perfects')} {result.stats.perfects} · {t('arcade.bestCombo')} {result.stats.bestCombo}</small>
          </div>
        ))}
        <b className="duel-vs" aria-hidden="true">VS</b>
      </div>
      <div className="dossier-actions">
        <button className="dossier-button replay" onClick={onRematch}>{t('duel.rematch')}</button>
        <button className="dossier-button ghost" onClick={onExit}>{t('common.lobby')}</button>
      </div>
      <GestureHint progress={progress} label={t('common.replayGesture')} />
    </section>
  )
}
