import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHeistAudio } from './audio/useHeistAudio'
import { DEMO_DURATION_MS, MISSION, MISSION_DURATION_MS, OVERTIME_LIMIT_MS, OVERTIME_SCORE_FACTOR } from './game/mission'
import { t, type StringKey } from './i18n/i18n'
import { STRINGS } from './i18n/strings'
import { useLang } from './i18n/useLang'
import { LangToggle } from './components/LangToggle'
import { HoloGuideCanvas, type HoloFeed } from './components/HoloGuideCanvas'
import { VaultStage } from './game/stages/VaultStage'
import { useLaserCanvas } from './hooks/useLaserCanvas'
import { usePoseCamera } from './hooks/usePoseCamera'
import { averageBaselines, BaselineManager } from './motion/baselineManager'
import { bothHandsRaised, REPLAY_ARM_DELAY_MS, REPLAY_HOLD_MS } from './motion/menuGestures'
import { canCalibrate, calibrationFrom, GestureEngine } from './motion/gestureEngine'
import { SecurityDossierScreen } from './components/ResultsScreen'
import { getLeaderboard } from './scoring/leaderboardStorage'
import { buildDossier, createStats, recoveryBonus, scoreMistake, scoreSuccess } from './scoring/scoringEngine'
import { MissionRecorder } from './scoring/telemetryRecorder'
import type { CalibrationBaseline, PoseFrame } from './types/pose'
import type { GameSession, GestureSignal, LeaderboardEntry, MovementError, Screen, VaultReading } from './types/game'
import type { DossierReport } from './types/scoring'
import './styles.css'
import './features.css'

/** Counts down, then up with a "+" once the mission is in overtime. */
const formatTime = (milliseconds: number) => {
  const seconds = milliseconds >= 0 ? Math.ceil(milliseconds / 1000) : Math.floor(-milliseconds / 1000)
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return milliseconds >= 0 ? clock : `+${clock}`
}

/** Flash + banner time between the vault breach and the debrief screen. */
const VAULT_OUTRO_MS = 1200

const initialSignal: GestureSignal = {
  gesture: 'RIGHT_HAND_UP', progress: 0, confidence: 0, valid: false, success: false, attempting: false,
}

const scoreAccuracy = (session: GameSession) => session.stats.successfulActions
  ? Math.min(100, Math.round(session.stats.totalAccuracy / session.stats.successfulActions))
  : 0

function App() {
  useLang()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const laserCanvasRef = useRef<HTMLCanvasElement>(null)
  const holoFeedRef = useRef<HoloFeed | null>(null)
  const vaultFeedRef = useRef<VaultReading | null>(null)
  const screenRef = useRef<Screen>('landing')
  const frameRef = useRef<PoseFrame | null>(null)
  const gameRef = useRef<GameSession | null>(null)
  const baselineRef = useRef<CalibrationBaseline | null>(null)
  const engineRef = useRef(new GestureEngine())
  const baselinesRef = useRef(new BaselineManager())
  const recorderRef = useRef(new MissionRecorder())
  const calibrationSamplesRef = useRef<CalibrationBaseline[]>([])
  const lastUiFrameRef = useRef(0)
  /** Diagnoses already penalized in the current phase: each costs points once, even if it recurs. */
  const penalizedRef = useRef(new Set<string>())
  const correctionStartedRef = useRef<number | null>(null)
  const resolveMotionRef = useRef<(signal: GestureSignal) => void>(() => undefined)
  const calibrateFrameRef = useRef<(frame: PoseFrame | null) => void>(() => undefined)
  const replayFrameRef = useRef<(frame: PoseFrame | null) => void>(() => undefined)
  const resultsShownAtRef = useRef(0)
  const replayRaisedSinceRef = useRef<number | null>(null)
  const finishedRef = useRef(false)

  const [screen, setScreen] = useState<Screen>('landing')
  const [playerName, setPlayerName] = useState('')
  const [demoMode, setDemoMode] = useState(true)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [countdown, setCountdown] = useState(3)
  const [game, setGame] = useState<GameSession | null>(null)
  const [remainingMs, setRemainingMs] = useState(MISSION_DURATION_MS)
  const [signal, setSignal] = useState<GestureSignal>(initialSignal)
  const [movementError, setMovementError] = useState<MovementError | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() => getLeaderboard())
  const [dossier, setDossier] = useState<DossierReport | null>(null)
  const [replayProgress, setReplayProgress] = useState(0)
  const { play, getContext: getAudioContext } = useHeistAudio()
  const playZap = useCallback(() => play('zap'), [play])
  const playBlip = useCallback(() => play('blip'), [play])
  const playBoot = useCallback(() => play('boot'), [play])
  const playConfirm = useCallback(() => play('score'), [play])
  const laser = useLaserCanvas({ canvasRef: laserCanvasRef, videoRef, active: screen === 'playing', onBreach: playZap })

  useEffect(() => { screenRef.current = screen }, [screen])
  useEffect(() => { gameRef.current = game }, [game])

  const onPoseFrame = useCallback((frame: PoseFrame | null) => {
    frameRef.current = frame
    if (screenRef.current === 'calibrating') calibrateFrameRef.current(frame)
    if (screenRef.current === 'results') replayFrameRef.current(frame)
    if (screenRef.current === 'playing') {
      holoFeedRef.current = null
      const activeGame = gameRef.current
      if (!activeGame || !baselineRef.current) return
      const action = MISSION[activeGame.phase]
      if (!action) return
      // A desk <-> full-body switch changes the body's scale on screen; hold judgement until it is re-locked.
      const baseline = frame ? baselinesRef.current.resolve(frame) : baselineRef.current
      let nextSignal: GestureSignal
      if (!baseline) {
        engineRef.current.reset(action.gesture)
        nextSignal = { gesture: action.gesture, progress: 0, confidence: 0, valid: false, success: false, attempting: false, recalibrating: true }
      } else {
        nextSignal = engineRef.current.update(action.gesture, frame, baseline)
        // The vault stage draws its own scanners and doors instead of a ghost.
        if (frame && action.gesture !== 'VAULT_BREACH') holoFeedRef.current = { frame, baseline, gesture: action.gesture, laser: nextSignal.metrics?.laser }
        if (nextSignal.vault) vaultFeedRef.current = nextSignal.vault
      }
      if (frame) recorderRef.current.recordFrame(nextSignal, frame.timestamp)
      laser.update(nextSignal.metrics?.laser ?? null, nextSignal.valid ? nextSignal.progress : 0)
      if (nextSignal.success && nextSignal.metrics?.laser) laser.clear()
      const uiTick = (frame?.timestamp ?? performance.now()) - lastUiFrameRef.current > 85
      if (uiTick) {
        lastUiFrameRef.current = frame?.timestamp ?? performance.now()
        setSignal(nextSignal)
      }
      if (nextSignal.error) {
        const title = nextSignal.error.title
        // A known diagnosis only refreshes the live numbers; it is never penalized twice.
        if (penalizedRef.current.has(title) && uiTick) setMovementError(nextSignal.error)
        if (!penalizedRef.current.has(title)) {
          penalizedRef.current.add(title)
          correctionStartedRef.current ??= performance.now()
          recorderRef.current.recordAnomaly(nextSignal.error, performance.now())
          setMovementError(nextSignal.error)
          const penalized = scoreMistake(activeGame.score, activeGame.stats)
          const updated = { ...activeGame, ...penalized }
          gameRef.current = updated
          setGame(updated)
          play('error')
        }
      }
      if (nextSignal.success) resolveMotionRef.current(nextSignal)
    }
  }, [laser, play])

  const camera = usePoseCamera({
    videoRef,
    canvasRef,
    onFrame: onPoseFrame,
    focusPoints: movementError?.focus ?? [],
  })
  const { start: startCamera, stop: stopCamera } = camera

  const finishMission = useCallback((session: GameSession) => {
    if (finishedRef.current) return
    finishedRef.current = true
    const breached = session.phase >= MISSION.length
    const telemetry = recorderRef.current.finish(performance.now(), breached ? 'breached' : 'timeout', session.score, session.stats.mistakes)
    setDossier(buildDossier(telemetry, MISSION))
    // The camera stays on: the debrief shows it as a CCTV feed and watches for the replay gesture.
    resultsShownAtRef.current = performance.now()
    replayRaisedSinceRef.current = null
    setReplayProgress(0)
    setScreen('results')
    setToast(null)
    if (!breached) play('error')
  }, [play])

  const resolveMotion = useCallback((motionSignal: GestureSignal) => {
    const activeGame = gameRef.current
    if (!activeGame) return
    const phaseElapsed = performance.now() - activeGame.phaseStartedAt
    const scored = scoreSuccess(activeGame.score, activeGame.stats, motionSignal, phaseElapsed)
    const overtime = Date.now() - activeGame.startedAt > activeGame.durationMs
    const earned = overtime ? Math.round(scored.earned * OVERTIME_SCORE_FACTOR) : scored.earned
    const correctedFor = correctionStartedRef.current ? Math.max(0, performance.now() - correctionStartedRef.current) : 0
    const nextStats = correctionStartedRef.current
      ? { ...scored.stats, corrections: scored.stats.corrections + 1, correctionMs: scored.stats.correctionMs + correctedFor }
      : scored.stats
    const bonus = correctionStartedRef.current ? recoveryBonus(correctedFor) : 0
    const now = performance.now()
    recorderRef.current.completePhase(now, earned, bonus)
    const nextPhase = activeGame.phase + 1
    if (nextPhase < MISSION.length) recorderRef.current.beginPhase(nextPhase, MISSION[nextPhase], now)
    const updated: GameSession = {
      ...activeGame,
      score: activeGame.score + earned + bonus,
      stats: nextStats,
      phase: nextPhase,
      phaseStartedAt: now,
    }
    gameRef.current = updated
    setGame(updated)
    setToast(`${t('toast.confirmed', { n: earned })}${bonus ? t('toast.recovery', { n: bonus }) : ''}${overtime ? t('toast.overtime') : ''}`)
    setMovementError(null)
    setWarning(null)
    setSignal({ ...motionSignal, progress: 1 })
    penalizedRef.current.clear()
    correctionStartedRef.current = null
    engineRef.current.reset(nextPhase < MISSION.length ? MISSION[nextPhase].gesture : null)
    // The vault stage plays its own breach strike for the finale.
    if (nextPhase < MISSION.length) play('success')
    window.setTimeout(() => setToast(null), 1600)
    if (nextPhase >= MISSION.length) window.setTimeout(() => finishMission(updated), VAULT_OUTRO_MS)
  }, [finishMission, play])
  resolveMotionRef.current = resolveMotion

  const handleCalibrationFrame = useCallback((frame: PoseFrame | null) => {
    if (!frame || !canCalibrate(frame)) {
      if (performance.now() - lastUiFrameRef.current > 120) {
        lastUiFrameRef.current = performance.now()
        setCalibrationProgress(Math.max(0, calibrationSamplesRef.current.length / 18))
      }
      return
    }
    const baseline = calibrationFrom(frame)
    if (!baseline || calibrationSamplesRef.current.length >= 18) return
    // The player switched between desk and full-body framing mid-calibration: start over at the new distance.
    if (calibrationSamplesRef.current[0] && calibrationSamplesRef.current[0].mode !== baseline.mode) calibrationSamplesRef.current = []
    calibrationSamplesRef.current.push(baseline)
    const progress = calibrationSamplesRef.current.length / 18
    setCalibrationProgress(progress)
    if (progress >= 1) {
      const averaged = averageBaselines(calibrationSamplesRef.current)
      baselineRef.current = averaged
      baselinesRef.current.seed(averaged)
      setToast(t('toast.bodyLocked'))
      play('scan')
      setScreen('briefing')
    }
  }, [play])
  calibrateFrameRef.current = handleCalibrationFrame

  const beginMission = useCallback(() => {
    const baseline = baselineRef.current
    if (!baseline) return
    const session: GameSession = {
      playerName: playerName.trim().slice(0, 16).toUpperCase() || t('landing.namePlaceholder'),
      startedAt: Date.now(),
      phaseStartedAt: performance.now(),
      durationMs: demoMode ? DEMO_DURATION_MS : MISSION_DURATION_MS,
      score: 0,
      phase: 0,
      stats: createStats(),
      baseline,
    }
    finishedRef.current = false
    penalizedRef.current.clear()
    correctionStartedRef.current = null
    engineRef.current.reset(MISSION[0].gesture)
    recorderRef.current.start(session.playerName, session.phaseStartedAt, session.durationMs)
    recorderRef.current.beginPhase(0, MISSION[0], session.phaseStartedAt)
    vaultFeedRef.current = null
    laser.reset()
    gameRef.current = session
    setGame(session)
    setRemainingMs(session.durationMs)
    setSignal(initialSignal)
    setMovementError(null)
    setWarning(null)
    setToast(t('toast.infiltration'))
    setScreen('playing')
    play('scan')
    window.setTimeout(() => setToast(null), 1400)
  }, [demoMode, laser, play, playerName])

  useEffect(() => {
    if (screen !== 'briefing') return
    setCountdown(3)
    let value = 3
    const interval = window.setInterval(() => {
      play('countdown')
      value -= 1
      if (value <= 0) {
        window.clearInterval(interval)
        beginMission()
      } else setCountdown(value)
    }, 900)
    return () => window.clearInterval(interval)
  }, [beginMission, play, screen])

  useEffect(() => {
    if (screen !== 'playing') return
    const timer = window.setInterval(() => {
      const session = gameRef.current
      if (!session) return
      const elapsed = Date.now() - session.startedAt
      const remaining = session.durationMs - elapsed
      setRemainingMs(remaining)
      const phaseElapsed = performance.now() - session.phaseStartedAt
      if (remaining < 0) {
        setWarning(t('warn.overtime'))
      } else if (phaseElapsed > 12_000 && Math.floor(phaseElapsed / 4000) > 2) {
        setWarning(t('warn.slow'))
      }
      // Only an abandoned session ends without the vault.
      if (-remaining > OVERTIME_LIMIT_MS && session.phase < MISSION.length) finishMission(session)
    }, 200)
    return () => window.clearInterval(timer)
  }, [finishMission, screen])

  const startHeist = async () => {
    play('click')
    calibrationSamplesRef.current = []
    baselineRef.current = null
    baselinesRef.current.reset()
    setCalibrationProgress(0)
    setMovementError(null)
    setToast(null)
    setScreen('calibrating')
    await startCamera()
  }

  const exitToLobby = () => {
    stopCamera()
    setDossier(null)
    setScreen('landing')
  }

  replayFrameRef.current = (frame) => {
    const now = performance.now()
    const raised = frame !== null && now - resultsShownAtRef.current > REPLAY_ARM_DELAY_MS && bothHandsRaised(frame)
    if (!raised) {
      if (replayRaisedSinceRef.current !== null) {
        replayRaisedSinceRef.current = null
        setReplayProgress(0)
      }
      return
    }
    replayRaisedSinceRef.current ??= now
    const progress = Math.min(1, (now - replayRaisedSinceRef.current) / REPLAY_HOLD_MS)
    setReplayProgress(progress)
    if (progress >= 1) {
      replayRaisedSinceRef.current = null
      setReplayProgress(0)
      void startHeist()
    }
  }

  // Leaving the mission/debrief flow releases the camera (and its indicator light).
  useEffect(() => {
    if (screen === 'landing' || screen === 'leaderboard') stopCamera()
  }, [screen, stopCamera])

  const currentAction = game && game.phase < MISSION.length ? MISSION[game.phase] : MISSION[MISSION.length - 1]
  const accuracy = game ? scoreAccuracy(game) : 0
  const cameraTag = camera.status === 'tracking' && frameRef.current ? t('camera.bodyDetected') : camera.status === 'tracking' ? t('camera.moveIntoFrame') : t(camera.message)
  const motionProgress = Math.round(signal.progress * 100)

  return (
    <main className={`app screen-${screen}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grid-surface" aria-hidden="true" />

      {screen === 'landing' && (
        <section className="landing panel-frame">
          <div className="eyebrow"><span className="live-dot" /> {t('landing.eyebrow')}</div>
          <div className="landing-copy">
            <p className="serial">{t('landing.serial')}</p>
            <h1>MOTION<span>:</span> HEIST</h1>
            <p className="tagline">{t('landing.tagline')}</p>
            <p className="intro">{t('landing.intro')}</p>
          </div>
          <div className="landing-controls">
            <label className="name-field">{t('landing.name')}
              <input maxLength={16} value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder={t('landing.namePlaceholder')} aria-label={t('landing.name')} />
            </label>
            <button className={`demo-toggle ${demoMode ? 'enabled' : ''}`} onClick={() => setDemoMode((enabled) => !enabled)} aria-pressed={demoMode}>
              <span>{t('landing.demo')}</span><b>{demoMode ? t('landing.demoOn') : t('landing.demoOff')}</b>
            </button>
            <button className="primary-button" onClick={() => void startHeist()}><span>{t('mode.story')}</span><b>→</b></button>
            <p className="button-note">{t('landing.note')}</p>
          </div>
          <div className="landing-meta">
            <span>{t('landing.noKeyboard')}</span><i /> <span>{t('landing.noMouse')}</span><i /> <span>{t('landing.justMove')}</span>
          </div>
          <div className="landing-corner"><LangToggle /><button className="quiet-button" onClick={() => setScreen('leaderboard')}>{t('landing.leaderboard')}</button></div>
        </section>
      )}

      {/* One persistent stage: the same <video> survives from calibration into the debrief (CCTV). */}
      {(screen === 'calibrating' || screen === 'briefing' || screen === 'playing' || (screen === 'results' && camera.status === 'tracking')) && (
        <div className={`camera-stage ${screen === 'results' ? 'cctv' : ''}`}>
          <video ref={videoRef} className="camera-video" muted playsInline />
          {/* Before the skeleton layer so the player's own bones always draw over the hologram. */}
          <HoloGuideCanvas videoRef={videoRef} feedRef={holoFeedRef} active={screen === 'playing'} onLock={playBlip} />
          <canvas ref={canvasRef} className="pose-canvas" />
          <div className="camera-shade" />
          <div className="scanline" />
          <canvas ref={laserCanvasRef} className="laser-canvas" />
          <div className={`desk-badge ${camera.trackingMode === 'desk' && camera.status === 'tracking' ? 'visible' : ''}`} role="status" aria-hidden={camera.trackingMode !== 'desk'}>
            <span className="desk-badge-dot" /><b>{t('desk.active')}</b><i /><span>{t('desk.tracking')}</span>
          </div>
          {screen === 'playing' && (currentAction.gesture === 'LEAN_LEFT' || currentAction.gesture === 'LEAN_RIGHT' || currentAction.gesture === 'RIGHT_HAND_UP') && <div className="laser" />}
          {screen === 'playing' && currentAction.gesture === 'FREEZE' && <div className={`searchlight ${signal.error ? 'spotted' : ''}`} aria-hidden="true"><span>{t('searchlight.label')}</span></div>}
          {screen === 'results' && (
            <div className="cctv-overlay" aria-live="polite">
              <span className="cctv-tag"><i /> {t('dossier.cctv')}</span>
              <span className="cctv-replay">{replayProgress > 0 ? t('common.replayProgress', { n: Math.round(replayProgress * 100) }) : t('common.replayGesture')}</span>
              <span className="cctv-meter"><b style={{ width: `${replayProgress * 100}%` }} /></span>
            </div>
          )}
        </div>
      )}

      {(screen === 'calibrating' || screen === 'briefing' || screen === 'playing') && (
        <section className={`mission-view ${screen === 'playing' && game && game.phase >= MISSION.length ? 'vault-exit' : ''}`}>
          {screen === 'calibrating' && (
            <div className="calibration-overlay">
              <p className="eyebrow"><span className="live-dot" /> {t('calib.eyebrow')}</p>
              <h2>{camera.status === 'tracking' ? calibrationProgress < .2 ? t('camera.moveIntoFrame') : t('calib.hold') : t('calib.init')}</h2>
              <p>{camera.status !== 'tracking' ? t(camera.message) : camera.trackingMode === 'desk' ? t('calib.desk') : t('calib.full')}</p>
              <div className="calibration-bar"><span style={{ width: `${calibrationProgress * 100}%` }} /></div>
              <div className="calibration-readout"><span>{t('calib.bodyMap', { n: Math.round(calibrationProgress * 100) })}</span><span>{camera.fps ? `${camera.fps} FPS` : t('calib.linking')}</span></div>
              {(camera.status === 'denied' || camera.status === 'error' || camera.status === 'unsupported') && <button className="primary-button compact" onClick={() => void startHeist()}>{t('camera.retry')}</button>}
            </div>
          )}

          {screen === 'briefing' && (
            <div className="briefing-overlay">
              <p className="eyebrow"><span className="live-dot" /> {t('brief.eyebrow')}</p>
              <h2>{t('brief.title1')}<br /><em>{t('brief.title2')}</em></h2>
              <div className="briefing-data"><span>{t('brief.limit')} <b>{t('common.sec', { n: (demoMode ? DEMO_DURATION_MS : MISSION_DURATION_MS) / 1000 })}</b></span><span>{t('brief.objective')} <b>{t('brief.objectiveValue')}</b></span></div>
              <p className="get-ready">{t('brief.ready')}</p>
              <strong className="countdown">{countdown}</strong>
            </div>
          )}

          {screen === 'playing' && game && (
            <>
              <header className="hud-top">
                <div><span>{t('hud.mission')}</span><b>{t('hud.missionName')}</b></div>
                <div className="time-readout"><span>{remainingMs < 0 ? t('hud.overtime') : t('common.time')}</span><b className={remainingMs < 20_000 ? 'urgent' : ''}>{formatTime(remainingMs)}</b></div>
                <div className="score-readout"><span>{t('common.score')}</span><b>{game.score.toLocaleString()}</b></div>
              </header>
              <aside className="camera-status"><span className={frameRef.current ? 'live-dot' : 'warning-dot'} /> <b>{t('camera.label')}</b> {cameraTag}<small>{camera.fps || '--'} FPS</small></aside>
              {currentAction.gesture === 'VAULT_BREACH' && <VaultStage videoRef={videoRef} feedRef={vaultFeedRef} getAudioContext={getAudioContext} />}
              <section className={`objective-card ${currentAction.gesture === 'VAULT_BREACH' ? 'vault-docked' : ''}`}>
                <span className="phase">{t(`move.${currentAction.gesture}.scene`)} / {String((game?.phase ?? 0) + 1).padStart(2, '0')}</span>
                <h2>{t(`move.${currentAction.gesture}.name`)}</h2>
                <p>{camera.trackingMode === 'desk' && currentAction.gesture === 'SQUAT' ? t('move.SQUAT.deskHint') : t(`move.${currentAction.gesture}.hint`)}</p>
                <div className="hold-meter"><span style={{ width: `${motionProgress}%` }} /></div>
                <div className="meter-label"><span>{signal.recalibrating ? t('hud.relocking') : signal.valid ? t('hud.validating') : signal.attempting ? t('hud.detected') : t('hud.waiting')}</span><b>{motionProgress}%</b></div>
              </section>
              <aside className="mission-rail">
                {MISSION.map((action, index) => <div key={action.gesture} className={index < game.phase ? 'done' : index === game.phase ? 'active' : ''}><b>0{index + 1}</b><span>{t(`move.${action.gesture}.name`)}</span></div>)}
              </aside>
              <aside className="combo-card"><span>{t('common.combo')}</span><b>×{game.stats.combo}</b><small>{t('common.accuracy', { n: accuracy })}</small></aside>
              {movementError && <ErrorOverlay error={movementError} />}
              {warning && <div className="warning-banner">⚠ {warning}</div>}
              {toast && <div className="success-toast">✓ {toast}</div>}
            </>
          )}
        </section>
      )}

      {screen === 'results' && dossier && (
        <SecurityDossierScreen
          report={dossier}
          defaultCallsign={playerName}
          onReplay={() => void startHeist()}
          replayHint={camera.status === 'tracking' ? t('common.orRaiseHands') : undefined}
          onExit={exitToLobby}
          onLeaderboardChange={setLeaderboard}
          onBoot={playBoot}
          onConfirm={playConfirm}
        />
      )}

      {screen === 'leaderboard' && (
        <section className="leaderboard-screen panel-frame">
          <button className="back-button" onClick={() => setScreen(dossier ? 'results' : 'landing')}>{t('common.back')}</button>
          <p className="eyebrow"><span className="live-dot" /> {t('board.eyebrow')}</p>
          <h1>{t('board.title1')}<span>{t('board.title2')}</span></h1>
          <p className="board-note">{t('board.note')}</p>
          <div className="score-table">
            <div className="table-head"><span>{t('board.rank')}</span><span>{t('board.operative')}</span><span>{t('board.style')}</span><span>{t('board.accuracy')}</span><span>{t('common.score')}</span></div>
            {leaderboard.length ? leaderboard.map((entry, index) => <div className="table-row" key={entry.id}><span>0{index + 1}</span><b>{entry.nickname}</b><span>{styleLabel(entry.style)}</span><span>{entry.accuracy}%</span><strong>{entry.score.toLocaleString()}</strong></div>) : <p className="empty-board">{t('board.empty')}</p>}
          </div>
          {!dossier && <button className="primary-button compact" onClick={() => setScreen('landing')}>{t('board.start')}</button>}
        </section>
      )}
    </main>
  )
}

/** Ranks are stored as English ids; older records may hold free text, shown as-is. */
const styleLabel = (style: string) => {
  const key = `rank.${style}`
  return key in STRINGS ? t(key as StringKey) : style
}

function ErrorOverlay({ error }: { error: MovementError }) {
  return <aside className="error-overlay" role="status" aria-live="polite">
    <div className="error-title"><span>⚠</span><div><small>{t('hud.error')}</small><b>{error.title}</b></div></div>
    <p>{error.detail}</p>
    <div className="error-correction"><strong>{error.arrow}</strong><span>{error.correction}</span></div>
    <div className="error-measures"><span>{error.current}</span><i /><b>{error.target}</b></div>
  </aside>
}

export default App
