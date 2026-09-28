import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHeistAudio } from './audio/useHeistAudio'
import { MISSION, MISSION_DURATION_MS } from './game/mission'
import { usePoseCamera } from './hooks/usePoseCamera'
import { canCalibrate, calibrationFrom, GestureEngine } from './motion/gestureEngine'
import { getLeaderboard, saveScore } from './scoring/leaderboard'
import { createStats, scoreMistake, scoreSuccess, styleFor } from './scoring/score'
import type { CalibrationBaseline, PoseFrame } from './types/pose'
import type { GameSession, GestureSignal, LeaderboardEntry, MovementError, Screen } from './types/game'
import './styles.css'

const formatTime = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const averageBaseline = (samples: CalibrationBaseline[]): CalibrationBaseline => ({
  hipY: samples.reduce((sum, item) => sum + item.hipY, 0) / samples.length,
  torso: samples.reduce((sum, item) => sum + item.torso, 0) / samples.length,
  shoulderWidth: samples.reduce((sum, item) => sum + item.shoulderWidth, 0) / samples.length,
  capturedAt: Date.now(),
})

const initialSignal: GestureSignal = {
  gesture: 'RIGHT_HAND_UP', progress: 0, confidence: 0, valid: false, success: false, attempting: false,
}

const scoreAccuracy = (session: GameSession) => session.stats.successfulActions
  ? Math.min(100, Math.round(session.stats.totalAccuracy / session.stats.successfulActions))
  : 0

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<Screen>('landing')
  const frameRef = useRef<PoseFrame | null>(null)
  const gameRef = useRef<GameSession | null>(null)
  const baselineRef = useRef<CalibrationBaseline | null>(null)
  const engineRef = useRef(new GestureEngine())
  const calibrationSamplesRef = useRef<CalibrationBaseline[]>([])
  const lastUiFrameRef = useRef(0)
  const lastErrorKeyRef = useRef<string | null>(null)
  const correctionStartedRef = useRef<number | null>(null)
  const resolveMotionRef = useRef<(signal: GestureSignal) => void>(() => undefined)
  const calibrateFrameRef = useRef<(frame: PoseFrame | null) => void>(() => undefined)
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
  const [lastEntry, setLastEntry] = useState<LeaderboardEntry | null>(null)
  const { play } = useHeistAudio()

  useEffect(() => { screenRef.current = screen }, [screen])
  useEffect(() => { gameRef.current = game }, [game])

  const onPoseFrame = useCallback((frame: PoseFrame | null) => {
    frameRef.current = frame
    if (screenRef.current === 'calibrating') calibrateFrameRef.current(frame)
    if (screenRef.current === 'playing') {
      const activeGame = gameRef.current
      if (!activeGame || !baselineRef.current) return
      const action = MISSION[activeGame.phase]
      if (!action) return
      const nextSignal = engineRef.current.update(action.gesture, frame, baselineRef.current)
      if ((frame?.timestamp ?? performance.now()) - lastUiFrameRef.current > 85) {
        lastUiFrameRef.current = frame?.timestamp ?? performance.now()
        setSignal(nextSignal)
      }
      if (nextSignal.error) {
        const key = `${activeGame.phase}:${nextSignal.error.title}`
        if (key !== lastErrorKeyRef.current) {
          lastErrorKeyRef.current = key
          correctionStartedRef.current ??= performance.now()
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
  }, [play])

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
    const accuracy = scoreAccuracy(session)
    const elapsed = session.durationMs - Math.max(0, session.durationMs - (Date.now() - session.startedAt))
    const entry: LeaderboardEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      nickname: session.playerName,
      score: session.score,
      accuracy,
      time: Math.round(elapsed / 1000),
      date: new Date().toLocaleDateString(),
      style: styleFor(accuracy, session.stats.mistakes),
    }
    const nextLeaderboard = saveScore(entry)
    setLeaderboard(nextLeaderboard)
    setLastEntry(entry)
    setScreen('results')
    setToast(session.phase >= MISSION.length ? 'VAULT OPENED' : 'MISSION TIME EXPIRED')
    play(session.phase >= MISSION.length ? 'unlock' : 'error')
    stopCamera()
  }, [play, stopCamera])

  const resolveMotion = useCallback((motionSignal: GestureSignal) => {
    const activeGame = gameRef.current
    if (!activeGame) return
    const phaseElapsed = performance.now() - activeGame.phaseStartedAt
    const scored = scoreSuccess(activeGame.score, activeGame.stats, motionSignal, phaseElapsed)
    const correctedFor = correctionStartedRef.current ? Math.max(0, performance.now() - correctionStartedRef.current) : 0
    const nextStats = correctionStartedRef.current
      ? { ...scored.stats, corrections: scored.stats.corrections + 1, correctionMs: scored.stats.correctionMs + correctedFor }
      : scored.stats
    const nextPhase = activeGame.phase + 1
    const updated: GameSession = {
      ...activeGame,
      score: scored.score,
      stats: nextStats,
      phase: nextPhase,
      phaseStartedAt: performance.now(),
    }
    gameRef.current = updated
    setGame(updated)
    setToast(`+${scored.earned} MOTION CONFIRMED`)
    setMovementError(null)
    setWarning(null)
    setSignal({ ...motionSignal, progress: 1 })
    lastErrorKeyRef.current = null
    correctionStartedRef.current = null
    engineRef.current.reset(nextPhase < MISSION.length ? MISSION[nextPhase].gesture : null)
    play(nextPhase === MISSION.length ? 'unlock' : 'success')
    window.setTimeout(() => setToast(null), 1600)
    if (nextPhase >= MISSION.length) window.setTimeout(() => finishMission(updated), 1100)
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
    calibrationSamplesRef.current.push(baseline)
    const progress = calibrationSamplesRef.current.length / 18
    setCalibrationProgress(progress)
    if (progress >= 1) {
      const averaged = averageBaseline(calibrationSamplesRef.current)
      baselineRef.current = averaged
      setToast('BODY LOCKED')
      play('scan')
      setScreen('briefing')
    }
  }, [play])
  calibrateFrameRef.current = handleCalibrationFrame

  const beginMission = useCallback(() => {
    const baseline = baselineRef.current
    if (!baseline) return
    const session: GameSession = {
      playerName: playerName.trim().slice(0, 16).toUpperCase() || 'OPERATIVE',
      startedAt: Date.now(),
      phaseStartedAt: performance.now(),
      durationMs: demoMode ? 55_000 : MISSION_DURATION_MS,
      score: 0,
      phase: 0,
      stats: createStats(),
      baseline,
    }
    finishedRef.current = false
    lastErrorKeyRef.current = null
    correctionStartedRef.current = null
    engineRef.current.reset(MISSION[0].gesture)
    gameRef.current = session
    setGame(session)
    setRemainingMs(session.durationMs)
    setSignal(initialSignal)
    setMovementError(null)
    setWarning(null)
    setToast('INFILTRATION ACTIVE')
    setScreen('playing')
    play('scan')
    window.setTimeout(() => setToast(null), 1400)
  }, [demoMode, play, playerName])

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
      const remaining = Math.max(0, session.durationMs - elapsed)
      setRemainingMs(remaining)
      const phaseElapsed = performance.now() - session.phaseStartedAt
      if (phaseElapsed > 12_000 && Math.floor(phaseElapsed / 4000) > 2) {
        setWarning('MISSION WARNING — take your time. The motion target is still active.')
      }
      if (remaining === 0) finishMission(session)
    }, 200)
    return () => window.clearInterval(timer)
  }, [finishMission, screen])

  const startHeist = async () => {
    play('click')
    calibrationSamplesRef.current = []
    baselineRef.current = null
    setCalibrationProgress(0)
    setMovementError(null)
    setToast(null)
    setScreen('calibrating')
    await startCamera()
  }

  const restart = async () => {
    stopCamera()
    setLastEntry(null)
    setScreen('landing')
  }

  const currentAction = game && game.phase < MISSION.length ? MISSION[game.phase] : MISSION[MISSION.length - 1]
  const accuracy = game ? scoreAccuracy(game) : 0
  const isNewHighScore = lastEntry !== null && leaderboard[0]?.id === lastEntry.id
  const cameraTag = camera.status === 'tracking' && frameRef.current ? 'BODY DETECTED' : camera.status === 'tracking' ? 'MOVE INTO FRAME' : camera.message
  const motionProgress = Math.round(signal.progress * 100)

  return (
    <main className={`app screen-${screen}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grid-surface" aria-hidden="true" />

      {screen === 'landing' && (
        <section className="landing panel-frame">
          <div className="eyebrow"><span className="live-dot" /> ADMIT HACKATHON / MOTION CASE</div>
          <div className="landing-copy">
            <p className="serial">MISSION INTERFACE // 01</p>
            <h1>MOTION<span>:</span> HEIST</h1>
            <p className="tagline">YOUR BODY IS THE CONTROLLER</p>
            <p className="intro">Infiltrate a high-security vault with five precise movements. No controller. No keyboard. Just move.</p>
          </div>
          <div className="landing-controls">
            <label className="name-field">OPERATIVE NAME
              <input maxLength={16} value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="OPERATIVE" aria-label="Operative name" />
            </label>
            <button className={`demo-toggle ${demoMode ? 'enabled' : ''}`} onClick={() => setDemoMode((enabled) => !enabled)} aria-pressed={demoMode}>
              <span>JURY DEMO MODE</span><b>{demoMode ? 'ON · 55 SEC' : 'OFF · 90 SEC'}</b>
            </button>
            <button className="primary-button" onClick={() => void startHeist()}><span>START HEIST</span><b>→</b></button>
            <p className="button-note">Camera access is requested after start.</p>
          </div>
          <div className="landing-meta">
            <span>NO KEYBOARD</span><i /> <span>NO MOUSE</span><i /> <span>JUST MOVE</span>
          </div>
          <div className="gesture-strip" aria-label="Mission gestures">
            {['RAISE', 'LEAN L', 'LEAN R', 'SQUAT', 'HANDS FWD'].map((item, index) => <span key={item}><b>0{index + 1}</b>{item}</span>)}
          </div>
          <button className="quiet-button leaderboard-launch" onClick={() => setScreen('leaderboard')}>LOCAL LEADERBOARD ↗</button>
        </section>
      )}

      {(screen === 'calibrating' || screen === 'briefing' || screen === 'playing') && (
        <section className="mission-view">
          <div className="camera-stage">
            <video ref={videoRef} className="camera-video" muted playsInline />
            <canvas ref={canvasRef} className="pose-canvas" />
            <div className="camera-shade" />
            <div className="scanline" />
            {screen === 'playing' && <div className={`laser laser-${game?.phase ?? 0}`} />}
          </div>

          {screen === 'calibrating' && (
            <div className="calibration-overlay">
              <p className="eyebrow"><span className="live-dot" /> CAMERA CALIBRATION</p>
              <h2>{camera.status === 'tracking' ? calibrationProgress < .2 ? 'MOVE INTO FRAME' : 'HOLD YOUR POSITION' : 'INITIALIZING CAMERA'}</h2>
              <p>{camera.status === 'tracking' ? 'Stand back until your shoulders, hips and knees are visible.' : camera.message}</p>
              <div className="calibration-bar"><span style={{ width: `${calibrationProgress * 100}%` }} /></div>
              <div className="calibration-readout"><span>{Math.round(calibrationProgress * 100)}% BODY MAP</span><span>{camera.fps ? `${camera.fps} FPS` : 'LINKING'}</span></div>
              {(camera.status === 'denied' || camera.status === 'error' || camera.status === 'unsupported') && <button className="primary-button compact" onClick={() => void startHeist()}>RETRY CAMERA</button>}
            </div>
          )}

          {screen === 'briefing' && (
            <div className="briefing-overlay">
              <p className="eyebrow"><span className="live-dot" /> BODY LOCKED / SYSTEM READY</p>
              <h2>VAULT SECURITY<br /><em>ACTIVE</em></h2>
              <div className="briefing-data"><span>TIME LIMIT <b>{demoMode ? '55 SEC' : '90 SEC'}</b></span><span>OBJECTIVE <b>BREAK INTO THE VAULT</b></span></div>
              <p className="get-ready">GET READY</p>
              <strong className="countdown">{countdown}</strong>
            </div>
          )}

          {screen === 'playing' && game && (
            <>
              <header className="hud-top">
                <div><span>MISSION 01</span><b>VAULT INFILTRATION</b></div>
                <div className="time-readout"><span>TIME</span><b className={remainingMs < 20_000 ? 'urgent' : ''}>{formatTime(remainingMs)}</b></div>
                <div className="score-readout"><span>SCORE</span><b>{game.score.toLocaleString()}</b></div>
              </header>
              <aside className="camera-status"><span className={frameRef.current ? 'live-dot' : 'warning-dot'} /> <b>CAMERA</b> {cameraTag}<small>{camera.fps || '--'} FPS</small></aside>
              <section className="objective-card">
                <span className="phase">{currentAction.scene}</span>
                <h2>{currentAction.objective}</h2>
                <p>{currentAction.hint}</p>
                <div className="hold-meter"><span style={{ width: `${motionProgress}%` }} /></div>
                <div className="meter-label"><span>{signal.valid ? 'VALIDATING HOLD' : signal.attempting ? 'MOTION DETECTED' : 'WAITING FOR MOTION'}</span><b>{motionProgress}%</b></div>
              </section>
              <aside className="mission-rail">
                {MISSION.map((action, index) => <div key={action.gesture} className={index < game.phase ? 'done' : index === game.phase ? 'active' : ''}><b>0{index + 1}</b><span>{action.objective}</span></div>)}
              </aside>
              <aside className="combo-card"><span>COMBO</span><b>×{game.stats.combo}</b><small>ACCURACY {accuracy}%</small></aside>
              {movementError && <ErrorOverlay error={movementError} />}
              {warning && <div className="warning-banner">⚠ {warning}</div>}
              {toast && <div className="success-toast">✓ {toast}</div>}
            </>
          )}
        </section>
      )}

      {screen === 'results' && lastEntry && (
        <section className="result-screen panel-frame">
          <p className="eyebrow"><span className="live-dot" /> MISSION DEBRIEF / SECURED</p>
          <h1>HEIST <em>COMPLETE</em></h1>
          {isNewHighScore && <div className="high-score">✦ NEW HIGH SCORE ✦</div>}
          <div className="final-score"><span>FINAL SCORE</span><strong>{lastEntry.score.toLocaleString()}</strong></div>
          <div className="stats-grid">
            <Stat label="MOTION ACCURACY" value={`${lastEntry.accuracy}%`} />
            <Stat label="SUCCESSFUL ACTIONS" value={`${game?.stats.successfulActions ?? 0}/5`} />
            <Stat label="MISTAKES" value={String(game?.stats.mistakes ?? 0)} />
            <Stat label="CORRECTION TIME" value={`${((game?.stats.correctionMs ?? 0) / 1000).toFixed(1)}s`} />
            <Stat label="TIME USED" value={`${lastEntry.time}s`} />
            <Stat label="MOTION STYLE" value={lastEntry.style} accent />
          </div>
          <div className="result-actions"><button className="primary-button" onClick={() => void restart()}>PLAY AGAIN <b>↻</b></button><button className="secondary-button" onClick={() => setScreen('leaderboard')}>LEADERBOARD</button></div>
        </section>
      )}

      {screen === 'leaderboard' && (
        <section className="leaderboard-screen panel-frame">
          <button className="back-button" onClick={() => setScreen(lastEntry ? 'results' : 'landing')}>← BACK</button>
          <p className="eyebrow"><span className="live-dot" /> LOCAL VAULT RECORDS</p>
          <h1>LEADER<span>BOARD</span></h1>
          <p className="board-note">Stored only in this browser. Top ten infiltrations.</p>
          <div className="score-table">
            <div className="table-head"><span>RANK</span><span>OPERATIVE</span><span>STYLE</span><span>ACCURACY</span><span>SCORE</span></div>
            {leaderboard.length ? leaderboard.map((entry, index) => <div className={`table-row ${entry.id === lastEntry?.id ? 'latest' : ''}`} key={entry.id}><span>0{index + 1}</span><b>{entry.nickname}</b><span>{entry.style}</span><span>{entry.accuracy}%</span><strong>{entry.score.toLocaleString()}</strong></div>) : <p className="empty-board">No records yet. Your vault is waiting.</p>}
          </div>
          {!lastEntry && <button className="primary-button compact" onClick={() => setScreen('landing')}>START A HEIST</button>}
        </section>
      )}
    </main>
  )
}

function ErrorOverlay({ error }: { error: MovementError }) {
  return <aside className="error-overlay" role="status" aria-live="polite">
    <div className="error-title"><span>⚠</span><div><small>MOVEMENT ERROR</small><b>{error.title}</b></div></div>
    <p>{error.detail}</p>
    <div className="error-correction"><strong>{error.arrow}</strong><span>{error.correction}</span></div>
    <div className="error-measures"><span>{error.current}</span><i /><b>{error.target}</b></div>
  </aside>
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={accent ? 'stat accent-stat' : 'stat'}><span>{label}</span><b>{value}</b></div>
}

export default App
