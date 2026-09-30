import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArcadeStage, type ArcadeResult, type ArcadeSink } from './arcade/ArcadeStage'
import { ArcadeResultsScreen, DuelResultScreen, DuelSwapScreen } from './arcade/ArcadeScreens'
import { newSeed } from './arcade/arcadeEngine'
import { useHeistAudio } from './audio/useHeistAudio'
import { announce, warmUpVoices } from './audio/voice'
import { DEMO_DURATION_MS, MISSION, MISSION_DURATION_MS, OVERTIME_LIMIT_MS, OVERTIME_SCORE_FACTOR } from './game/mission'
import { t, type StringKey } from './i18n/i18n'
import { STRINGS } from './i18n/strings'
import { useLang } from './i18n/useLang'
import { LangToggle } from './components/LangToggle'
import { SoundToggle } from './components/SoundToggle'
import { MoveListPanel } from './components/MoveListPanel'
import { PhotoFinish } from './components/PhotoFinish'
import { PoseGlyph } from './components/PoseGlyph'
import { HoloGuideCanvas, type HoloFeed } from './components/HoloGuideCanvas'
import { VaultStage } from './game/stages/VaultStage'
import { useLaserCanvas } from './hooks/useLaserCanvas'
import { usePoseCamera } from './hooks/usePoseCamera'
import { averageBaselines, BaselineManager } from './motion/baselineManager'
import { bothHandsRaised, REPLAY_ARM_DELAY_MS, REPLAY_HOLD_MS } from './motion/menuGestures'
import { canCalibrate, calibrationFrom, GestureEngine } from './motion/gestureEngine'
import { SecurityDossierScreen } from './components/ResultsScreen'
import { captureFrame } from './render/wantedPoster'
import { getLeaderboard, type BoardMode } from './scoring/leaderboardStorage'
import { buildDossier, createStats, recoveryBonus, scoreMistake, scoreSuccess } from './scoring/scoringEngine'
import { MissionRecorder } from './scoring/telemetryRecorder'
import type { CalibrationBaseline, PoseFrame } from './types/pose'
import type { GameMode, GameSession, GestureSignal, MovementError, Screen, VaultReading } from './types/game'
import type { DossierReport } from './types/scoring'
import './styles.css'
import './features.css'
import './modes.css'

/** Counts down, then up with a "+" once the mission is in overtime. */
const formatTime = (milliseconds: number) => {
  const seconds = milliseconds >= 0 ? Math.ceil(milliseconds / 1000) : Math.floor(-milliseconds / 1000)
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return milliseconds >= 0 ? clock : `+${clock}`
}

/** Flash + banner time between the vault breach and the debrief screen. */
const VAULT_OUTRO_MS = 1200
/** Pause on the "nice!" card between training moves. */
const TRAINING_NEXT_MS = 900
const SHAKE_MS = 450
const ROMAN = ['I', 'II', 'III']
/** Screens that keep the camera as a small CCTV window and listen for the hands-up gesture. */
const CCTV_SCREENS: Screen[] = ['results', 'arcadeResults', 'duelSwap', 'duelResult']

const MODES: Array<{ id: GameMode; icon: string }> = [
  { id: 'story', icon: '🔓' },
  { id: 'arcade', icon: '⚡' },
  { id: 'duel', icon: '⚔' },
  { id: 'training', icon: '🎯' },
]

type Grade = 'PERFECT' | 'GREAT' | 'OK'

const initialSignal: GestureSignal = {
  gesture: 'RIGHT_HAND_UP', progress: 0, confidence: 0, valid: false, success: false, attempting: false,
}

const scoreAccuracy = (session: GameSession) => session.stats.successfulActions
  ? Math.min(100, Math.round(session.stats.totalAccuracy / session.stats.successfulActions))
  : 0

/** Ranks are stored as English ids; older records may hold free text, shown as-is. */
const styleLabel = (style: string) => {
  if (style === 'LASER RUSH') return t('mode.arcade')
  const key = `rank.${style}`
  return key in STRINGS ? t(key as StringKey) : style
}

/** Story judgement: fast and clean is PERFECT, clean is GREAT, anything that needed a correction is OK. */
const storyGrade = (phaseMs: number, corrected: boolean): Grade => (corrected ? 'OK' : phaseMs < 3500 ? 'PERFECT' : 'GREAT')

function App() {
  useLang()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const laserCanvasRef = useRef<HTMLCanvasElement>(null)
  const holoFeedRef = useRef<HoloFeed | null>(null)
  const vaultFeedRef = useRef<VaultReading | null>(null)
  const arcadeSinkRef = useRef<ArcadeSink | null>(null)
  const screenRef = useRef<Screen>('landing')
  const modeRef = useRef<GameMode>('story')
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
  const handsUpFrameRef = useRef<(frame: PoseFrame | null) => void>(() => undefined)
  const handsUpArmedAtRef = useRef(0)
  const handsUpSinceRef = useRef<number | null>(null)
  const trainingDoneRef = useRef(false)
  /** True during the short "nice!" pause between training moves: no judging, so the same move can't fire twice. */
  const trainingPauseRef = useRef(false)
  const duelResultsRef = useRef<ArcadeResult[]>([])
  const storyPhotoRef = useRef<HTMLCanvasElement | null>(null)
  const finishedRef = useRef(false)
  const shakeTimerRef = useRef(0)

  const [screen, setScreen] = useState<Screen>('landing')
  const [mode, setMode] = useState<GameMode>('story')
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
  const [boardMode, setBoardMode] = useState<BoardMode>('story')
  const [dossier, setDossier] = useState<DossierReport | null>(null)
  const [storyPhoto, setStoryPhoto] = useState<HTMLCanvasElement | null>(null)
  const [handsUpProgress, setHandsUpProgress] = useState(0)
  const [trainingDone, setTrainingDone] = useState(false)
  const [showMoves, setShowMoves] = useState(false)
  const [judge, setJudge] = useState<{ id: number; grade: Grade } | null>(null)
  const [actCard, setActCard] = useState<{ id: number; act: number } | null>(null)
  const [shake, setShake] = useState(false)
  const [arcadeSeed, setArcadeSeed] = useState(newSeed)
  const [arcadeRun, setArcadeRun] = useState(0)
  const [arcadeResult, setArcadeResult] = useState<ArcadeResult | null>(null)
  const [duelResults, setDuelResults] = useState<ArcadeResult[]>([])
  const { play, getContext: getAudioContext, startSoundtrack, tuneSoundtrack, stopSoundtrack } = useHeistAudio()
  const playZap = useCallback(() => play('zap'), [play])
  const playBlip = useCallback(() => play('blip'), [play])
  const playBoot = useCallback(() => play('boot'), [play])
  const playConfirm = useCallback(() => play('score'), [play])
  const laser = useLaserCanvas({ canvasRef: laserCanvasRef, videoRef, active: screen === 'playing', onBreach: playZap })

  useEffect(() => { screenRef.current = screen }, [screen])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { gameRef.current = game }, [game])

  const triggerShake = useCallback(() => {
    setShake(true)
    window.clearTimeout(shakeTimerRef.current)
    shakeTimerRef.current = window.setTimeout(() => setShake(false), SHAKE_MS)
  }, [])

  const showAct = useCallback((act: number) => {
    setActCard({ id: performance.now(), act })
    announce('voice.act', { n: act })
  }, [])

  /** Arms the "both hands up" gesture for the screen that was just shown. */
  const armHandsUp = useCallback(() => {
    handsUpArmedAtRef.current = performance.now()
    handsUpSinceRef.current = null
    setHandsUpProgress(0)
  }, [])

  const onPoseFrame = useCallback((frame: PoseFrame | null) => {
    frameRef.current = frame
    const current = screenRef.current
    if (current === 'calibrating') calibrateFrameRef.current(frame)
    if (CCTV_SCREENS.includes(current)) handsUpFrameRef.current(frame)
    if (current === 'arcade') {
      const baseline = frame ? baselinesRef.current.resolve(frame) : baselineRef.current
      arcadeSinkRef.current?.(frame, baseline)
    }
    if (current === 'playing') {
      holoFeedRef.current = null
      if (trainingDoneRef.current) {
        handsUpFrameRef.current(frame)
        return
      }
      if (trainingPauseRef.current) return
      const activeGame = gameRef.current
      if (!activeGame || !baselineRef.current) return
      const action = MISSION[activeGame.phase]
      if (!action) return
      const training = modeRef.current === 'training'
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
      if (frame && !training) recorderRef.current.recordFrame(nextSignal, frame.timestamp)
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
          setMovementError(nextSignal.error)
          triggerShake()
          if (training) {
            play('warn')
          } else {
            recorderRef.current.recordAnomaly(nextSignal.error, performance.now())
            const penalized = scoreMistake(activeGame.score, activeGame.stats)
            const updated = { ...activeGame, ...penalized }
            gameRef.current = updated
            setGame(updated)
            play('error')
          }
        }
      }
      if (nextSignal.success) resolveMotionRef.current(nextSignal)
    }
  }, [laser, play, triggerShake])

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
    setStoryPhoto(storyPhotoRef.current ?? captureFrame(videoRef.current))
    stopSoundtrack()
    // The camera stays on: the debrief shows it as a CCTV feed and watches for the replay gesture.
    armHandsUp()
    setScreen('results')
    setToast(null)
    if (!breached) play('error')
  }, [armHandsUp, play, stopSoundtrack])

  const startCalibration = useCallback(async () => {
    play('click')
    warmUpVoices()
    calibrationSamplesRef.current = []
    baselineRef.current = null
    baselinesRef.current.reset()
    trainingDoneRef.current = false
    setTrainingDone(false)
    setCalibrationProgress(0)
    setMovementError(null)
    setToast(null)
    setScreen('calibrating')
    await startCamera()
  }, [play, startCamera])

  const launch = useCallback((next: GameMode) => {
    modeRef.current = next
    setMode(next)
    setShowMoves(false)
    if (next === 'arcade' || next === 'duel') {
      setArcadeSeed(newSeed())
      setArcadeResult(null)
      duelResultsRef.current = []
      setDuelResults([])
    }
    void startCalibration()
  }, [startCalibration])

  const advanceTraining = useCallback((session: GameSession) => {
    const nextPhase = session.phase + 1
    penalizedRef.current.clear()
    correctionStartedRef.current = null
    setMovementError(null)
    setSignal({ ...initialSignal, gesture: MISSION[Math.min(nextPhase, MISSION.length - 1)].gesture })
    if (nextPhase >= MISSION.length) {
      // Let the vault doors finish their breach animation before the wrap-up card covers them.
      trainingPauseRef.current = true
      window.setTimeout(() => {
        trainingPauseRef.current = false
        if (modeRef.current !== 'training') return
        trainingDoneRef.current = true
        setTrainingDone(true)
        armHandsUp()
        play('unlock')
      }, VAULT_OUTRO_MS)
      return
    }
    setToast(t('train.nice'))
    trainingPauseRef.current = true
    window.setTimeout(() => {
      trainingPauseRef.current = false
      const active = gameRef.current
      if (!active || modeRef.current !== 'training') return
      const updated = { ...active, phase: nextPhase, phaseStartedAt: performance.now() }
      gameRef.current = updated
      setGame(updated)
      setToast(null)
      engineRef.current.reset(MISSION[nextPhase].gesture)
      laser.reset()
    }, TRAINING_NEXT_MS)
  }, [armHandsUp, laser, play])

  const resolveMotion = useCallback((motionSignal: GestureSignal) => {
    const activeGame = gameRef.current
    if (!activeGame) return
    const now = performance.now()
    const phaseElapsed = now - activeGame.phaseStartedAt
    const grade = storyGrade(phaseElapsed, correctionStartedRef.current !== null)
    setJudge({ id: now, grade })
    play(grade === 'PERFECT' ? 'perfect' : 'success')
    if (grade === 'PERFECT') announce('voice.perfect')
    if (motionSignal.gesture === 'VAULT_BREACH') {
      storyPhotoRef.current = captureFrame(videoRef.current)
      announce('voice.vault', undefined, true)
    }

    if (modeRef.current === 'training') {
      advanceTraining(activeGame)
      return
    }

    const scored = scoreSuccess(activeGame.score, activeGame.stats, motionSignal, phaseElapsed)
    const overtime = Date.now() - activeGame.startedAt > activeGame.durationMs
    const earned = overtime ? Math.round(scored.earned * OVERTIME_SCORE_FACTOR) : scored.earned
    const correctedFor = correctionStartedRef.current ? Math.max(0, now - correctionStartedRef.current) : 0
    const nextStats = correctionStartedRef.current
      ? { ...scored.stats, corrections: scored.stats.corrections + 1, correctionMs: scored.stats.correctionMs + correctedFor }
      : scored.stats
    const bonus = correctionStartedRef.current ? recoveryBonus(correctedFor) : 0
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
    if (nextPhase < MISSION.length && MISSION[nextPhase].act !== MISSION[activeGame.phase].act) showAct(MISSION[nextPhase].act)
    window.setTimeout(() => setToast(null), 1600)
    if (nextPhase >= MISSION.length) window.setTimeout(() => finishMission(updated), VAULT_OUTRO_MS)
  }, [advanceTraining, finishMission, play, showAct])
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
      // Training starts right away: no clock is ticking, so no countdown is needed.
      if (modeRef.current === 'training') beginMissionRef.current()
      else setScreen('briefing')
    }
  }, [play])
  calibrateFrameRef.current = handleCalibrationFrame

  const beginMission = useCallback(() => {
    const baseline = baselineRef.current
    if (!baseline) return
    const training = modeRef.current === 'training'
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
    trainingDoneRef.current = false
    setTrainingDone(false)
    storyPhotoRef.current = null
    penalizedRef.current.clear()
    correctionStartedRef.current = null
    engineRef.current.reset(MISSION[0].gesture)
    if (!training) {
      recorderRef.current.start(session.playerName, session.phaseStartedAt, session.durationMs)
      recorderRef.current.beginPhase(0, MISSION[0], session.phaseStartedAt)
    }
    vaultFeedRef.current = null
    laser.reset()
    gameRef.current = session
    setGame(session)
    setRemainingMs(session.durationMs)
    setSignal(initialSignal)
    setMovementError(null)
    setWarning(null)
    setToast(training ? null : t('toast.infiltration'))
    setScreen('playing')
    play('scan')
    startSoundtrack(training ? 86 : 98, training ? 0.12 : 0.3)
    if (!training) showAct(1)
    window.setTimeout(() => setToast(null), 1400)
  }, [demoMode, laser, play, playerName, showAct, startSoundtrack])
  const beginMissionRef = useRef(beginMission)
  beginMissionRef.current = beginMission

  const beginArcade = useCallback(() => {
    setArcadeRun((run) => run + 1)
    setScreen('arcade')
    play('scan')
    startSoundtrack(112, 0.35)
  }, [play, startSoundtrack])

  const onArcadeFinish = useCallback((result: ArcadeResult) => {
    stopSoundtrack()
    armHandsUp()
    if (modeRef.current === 'duel') {
      const results = [...duelResultsRef.current, result]
      duelResultsRef.current = results
      setDuelResults(results)
      setScreen(results.length >= 2 ? 'duelResult' : 'duelSwap')
      return
    }
    setArcadeResult(result)
    setScreen('arcadeResults')
  }, [armHandsUp, stopSoundtrack])

  useEffect(() => {
    if (screen !== 'briefing') return
    setCountdown(3)
    let value = 3
    const interval = window.setInterval(() => {
      play('countdown')
      value -= 1
      if (value <= 0) {
        window.clearInterval(interval)
        if (modeRef.current === 'arcade' || modeRef.current === 'duel') beginArcade()
        else beginMission()
      } else setCountdown(value)
    }, 900)
    return () => window.clearInterval(interval)
  }, [beginArcade, beginMission, play, screen])

  useEffect(() => {
    if (screen !== 'playing' || mode === 'training') return
    const timer = window.setInterval(() => {
      const session = gameRef.current
      if (!session) return
      const elapsed = Date.now() - session.startedAt
      const remaining = session.durationMs - elapsed
      setRemainingMs(remaining)
      const phaseElapsed = performance.now() - session.phaseStartedAt
      if (remaining < 0) {
        setWarning(t('warn.overtime'))
        tuneSoundtrack(126, 0.85)
      } else if (phaseElapsed > 12_000 && Math.floor(phaseElapsed / 4000) > 2) {
        setWarning(t('warn.slow'))
      }
      // Only an abandoned session ends without the vault.
      if (-remaining > OVERTIME_LIMIT_MS && session.phase < MISSION.length) finishMission(session)
    }, 200)
    return () => window.clearInterval(timer)
  }, [finishMission, mode, screen, tuneSoundtrack])

  const exitToLobby = useCallback(() => {
    stopCamera()
    stopSoundtrack()
    setDossier(null)
    trainingDoneRef.current = false
    setTrainingDone(false)
    setScreen('landing')
  }, [stopCamera, stopSoundtrack])

  const startHeistAfterTraining = useCallback(() => {
    modeRef.current = 'story'
    setMode('story')
    trainingDoneRef.current = false
    setTrainingDone(false)
    stopSoundtrack()
    setScreen('briefing')
  }, [stopSoundtrack])

  /** What "both hands up for 1.2 s" does on the current screen. */
  const handsUpAction = useCallback(() => {
    const current = screenRef.current
    if (current === 'results') launch('story')
    else if (current === 'arcadeResults') launch('arcade')
    else if (current === 'duelSwap') void startCalibration()
    else if (current === 'duelResult') launch('duel')
    else if (current === 'playing' && trainingDoneRef.current) startHeistAfterTraining()
  }, [launch, startCalibration, startHeistAfterTraining])

  handsUpFrameRef.current = (frame) => {
    const now = performance.now()
    const raised = frame !== null && now - handsUpArmedAtRef.current > REPLAY_ARM_DELAY_MS && bothHandsRaised(frame)
    if (!raised) {
      if (handsUpSinceRef.current !== null) {
        handsUpSinceRef.current = null
        setHandsUpProgress(0)
      }
      return
    }
    handsUpSinceRef.current ??= now
    const progress = Math.min(1, (now - handsUpSinceRef.current) / REPLAY_HOLD_MS)
    setHandsUpProgress(progress)
    if (progress >= 1) {
      handsUpSinceRef.current = null
      setHandsUpProgress(0)
      handsUpAction()
    }
  }

  // Leaving the mission/debrief flow releases the camera (and its indicator light).
  useEffect(() => {
    if (screen === 'landing' || screen === 'leaderboard') stopCamera()
  }, [screen, stopCamera])

  const coins = useMemo(() => Array.from({ length: 26 }, (_, index) => ({
    id: index,
    x: Math.round((Math.random() - 0.5) * 90),
    delay: Math.round(Math.random() * 500),
    spin: Math.round(Math.random() * 720 - 360),
  })), [])

  const training = mode === 'training'
  const duelPlayer = Math.min(2, duelResults.length + 1)
  const currentAction = game && game.phase < MISSION.length ? MISSION[game.phase] : MISSION[MISSION.length - 1]
  const accuracy = game ? scoreAccuracy(game) : 0
  const cameraTag = camera.status === 'tracking' && frameRef.current ? t('camera.bodyDetected') : camera.status === 'tracking' ? t('camera.moveIntoFrame') : t(camera.message)
  const motionProgress = Math.round(signal.progress * 100)
  const leaderboard = useMemo(() => (screen === 'leaderboard' ? getLeaderboard(boardMode) : []), [boardMode, screen])
  const cameraVisible = screen === 'calibrating' || screen === 'briefing' || screen === 'playing' || screen === 'arcade'
    || (CCTV_SCREENS.includes(screen) && camera.status === 'tracking')
  const arcadeLike = mode === 'arcade' || mode === 'duel'
  const vaultBreached = screen === 'playing' && !!game && game.phase >= MISSION.length

  return (
    <main className={`app screen-${screen} ${shake ? 'shake' : ''}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grid-surface" aria-hidden="true" />

      {screen === 'landing' && (
        <section className="landing panel-frame">
          <div className="landing-corner">
            <LangToggle />
            <SoundToggle />
            <button className="quiet-button" onClick={() => setScreen('leaderboard')}>{t('landing.leaderboard')}</button>
          </div>
          <div className="eyebrow"><span className="live-dot" /> {t('landing.eyebrow')}</div>
          <div className="landing-copy">
            <p className="serial">{t('landing.serial')}</p>
            <h1>MOTION<span>:</span> HEIST</h1>
            <p className="tagline">{t('landing.tagline')}</p>
            <p className="intro">{t('landing.intro')}</p>
          </div>
          <div className="landing-grid">
            <div className="landing-controls">
              <label className="name-field">{t('landing.name')}
                <input maxLength={16} value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder={t('landing.namePlaceholder')} aria-label={t('landing.name')} />
              </label>
              <button className={`demo-toggle ${demoMode ? 'enabled' : ''}`} onClick={() => setDemoMode((enabled) => !enabled)} aria-pressed={demoMode}>
                <span>{t('landing.demo')}</span><b>{demoMode ? t('landing.demoOn') : t('landing.demoOff')}</b>
              </button>
              <button className="moves-button" onClick={() => setShowMoves(true)}>
                <PoseGlyph gesture="LEAN_LEFT" size={30} /><span>{t('landing.moveList')}</span><b>?</b>
              </button>
              <p className="button-note">{t('landing.note')}</p>
            </div>
            <div className="mode-select" role="group" aria-label={t('landing.chooseMode')}>
              <p className="mode-select-title">{t('landing.chooseMode')}</p>
              {MODES.map((item) => (
                <button key={item.id} className={`mode-tile mode-${item.id}`} onClick={() => launch(item.id)}>
                  <i aria-hidden="true">{item.icon}</i>
                  <span><b>{t(`mode.${item.id}`)}</b><small>{t(`mode.${item.id}.desc`)}</small></span>
                  <em aria-hidden="true">→</em>
                </button>
              ))}
            </div>
          </div>
          <div className="landing-meta">
            <span>{t('landing.noKeyboard')}</span><i /> <span>{t('landing.noMouse')}</span><i /> <span>{t('landing.justMove')}</span>
          </div>
        </section>
      )}

      {showMoves && <MoveListPanel onClose={() => setShowMoves(false)} onTraining={() => launch('training')} />}

      {/* One persistent stage: the same <video> survives from calibration into the debrief (CCTV). */}
      {cameraVisible && (
        <div className={`camera-stage ${CCTV_SCREENS.includes(screen) ? 'cctv' : ''}`}>
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
          {screen === 'playing' && !trainingDone && (currentAction.gesture === 'LEAN_LEFT' || currentAction.gesture === 'LEAN_RIGHT' || currentAction.gesture === 'RIGHT_HAND_UP') && <div className="laser" />}
          {screen === 'playing' && !trainingDone && currentAction.gesture === 'FREEZE' && <div className={`searchlight ${movementError ? 'spotted' : ''}`} aria-hidden="true"><span>{t('searchlight.label')}</span></div>}
          {screen === 'results' && (
            <div className="cctv-overlay" aria-live="polite">
              <span className="cctv-tag"><i /> {t('dossier.cctv')}</span>
              <span className="cctv-replay">{handsUpProgress > 0 ? t('common.replayProgress', { n: Math.round(handsUpProgress * 100) }) : t('common.replayGesture')}</span>
              <span className="cctv-meter"><b style={{ width: `${handsUpProgress * 100}%` }} /></span>
            </div>
          )}
        </div>
      )}

      {(screen === 'calibrating' || screen === 'briefing' || screen === 'playing' || screen === 'arcade') && (
        <section className={`mission-view ${vaultBreached && !training ? 'vault-exit' : ''}`}>
          {screen === 'calibrating' && (
            <div className="calibration-overlay">
              <p className="eyebrow"><span className="live-dot" /> {mode === 'duel' ? t('calib.player', { player: t('common.player', { n: duelPlayer }) }) : t('calib.eyebrow')}</p>
              <h2>{camera.status === 'tracking' ? calibrationProgress < .2 ? t('camera.moveIntoFrame') : t('calib.hold') : t('calib.init')}</h2>
              <p>{camera.status !== 'tracking' ? t(camera.message) : camera.trackingMode === 'desk' ? t('calib.desk') : t('calib.full')}</p>
              <div className="calibration-bar"><span style={{ width: `${calibrationProgress * 100}%` }} /></div>
              <div className="calibration-readout"><span>{t('calib.bodyMap', { n: Math.round(calibrationProgress * 100) })}</span><span>{camera.fps ? `${camera.fps} FPS` : t('calib.linking')}</span></div>
              {(camera.status === 'denied' || camera.status === 'error' || camera.status === 'unsupported') && <button className="primary-button compact" onClick={() => void startCalibration()}>{t('camera.retry')}</button>}
            </div>
          )}

          {screen === 'briefing' && (
            <div className="briefing-overlay">
              <p className="eyebrow"><span className="live-dot" /> {mode === 'duel' ? `${t('mode.duel')} · ${t('common.player', { n: duelPlayer })}` : t('brief.eyebrow')}</p>
              {arcadeLike ? (
                <>
                  <h2>{t('brief.arcadeTitle1')}<br /><em>{t('brief.arcadeTitle2')}</em></h2>
                  <div className="briefing-data"><span>{t('brief.limit')} <b>{t('common.sec', { n: 60 })}</b></span><span>{t('brief.lives')} <b>♥ ♥ ♥</b></span><span>{t('brief.objective')} <b>{t('brief.arcadeObjective')}</b></span></div>
                  <div className="briefing-glyphs">
                    <PoseGlyph gesture="SQUAT" decor="beam" size={54} />
                    <PoseGlyph gesture="LEAN_RIGHT" decor="wallLeft" size={54} />
                    <PoseGlyph gesture="RIGHT_HAND_UP" decor="diamond" size={54} />
                    <PoseGlyph gesture="FREEZE" decor="light" size={54} />
                  </div>
                </>
              ) : (
                <>
                  <h2>{t('brief.title1')}<br /><em>{t('brief.title2')}</em></h2>
                  <div className="briefing-data"><span>{t('brief.limit')} <b>{t('common.sec', { n: (demoMode ? DEMO_DURATION_MS : MISSION_DURATION_MS) / 1000 })}</b></span><span>{t('brief.objective')} <b>{t('brief.objectiveValue')}</b></span></div>
                </>
              )}
              <p className="get-ready">{t('brief.ready')}</p>
              <strong className="countdown">{countdown}</strong>
            </div>
          )}

          {screen === 'arcade' && (
            <ArcadeStage
              key={arcadeRun}
              videoRef={videoRef}
              sinkRef={arcadeSinkRef}
              seed={arcadeSeed}
              playerLabel={mode === 'duel' ? t('common.player', { n: duelPlayer }) : undefined}
              play={play}
              onTune={tuneSoundtrack}
              onShake={triggerShake}
              onFinish={onArcadeFinish}
            />
          )}

          {screen === 'playing' && game && (
            <>
              <header className="hud-top">
                {training ? (
                  <>
                    <div><span>{t('mode.training')}</span><b>{t('train.step', { n: Math.min(game.phase + 1, MISSION.length), total: MISSION.length })}</b></div>
                    <div className="time-readout training-readout"><span>{t('train.eyebrow')}</span></div>
                    <div className="score-readout"><SoundToggle /></div>
                  </>
                ) : (
                  <>
                    <div><span>{t('hud.mission')}</span><b>{t('hud.missionName')}</b></div>
                    <div className="time-readout"><span>{remainingMs < 0 ? t('hud.overtime') : t('common.time')}</span><b className={remainingMs < 20_000 ? 'urgent' : ''}>{formatTime(remainingMs)}</b></div>
                    <div className="score-readout"><span>{t('common.score')}</span><b>{game.score.toLocaleString()}</b></div>
                  </>
                )}
              </header>
              <aside className="camera-status"><span className={frameRef.current ? 'live-dot' : 'warning-dot'} /> <b>{t('camera.label')}</b> {cameraTag}<small>{camera.fps || '--'} FPS</small></aside>
              {currentAction.gesture === 'VAULT_BREACH' && !trainingDone && <VaultStage key={`${mode}-${game.startedAt}`} videoRef={videoRef} feedRef={vaultFeedRef} getAudioContext={getAudioContext} />}
              {!trainingDone && (
                <section className={`objective-card ${currentAction.gesture === 'VAULT_BREACH' ? 'vault-docked' : ''} ${training ? 'with-glyph' : ''}`}>
                  {training && currentAction.gesture !== 'VAULT_BREACH' && <PoseGlyph gesture={currentAction.gesture} size={76} className="objective-glyph" />}
                  <span className="phase">{training ? t('train.step', { n: game.phase + 1, total: MISSION.length }) : `${t('act.label', { n: ROMAN[currentAction.act - 1] })} · ${t(`move.${currentAction.gesture}.scene`)} / ${String(game.phase + 1).padStart(2, '0')}`}</span>
                  <h2>{t(`move.${currentAction.gesture}.name`)}</h2>
                  <p>{camera.trackingMode === 'desk' && currentAction.gesture === 'SQUAT' ? t('move.SQUAT.deskHint') : t(`move.${currentAction.gesture}.hint`)}</p>
                  {training && <p className="objective-tip">💡 {t(`move.${currentAction.gesture}.tip`)}</p>}
                  <div className="hold-meter"><span style={{ width: `${motionProgress}%` }} /></div>
                  <div className="meter-label"><span>{signal.recalibrating ? t('hud.relocking') : signal.valid ? t('hud.validating') : signal.attempting ? t('hud.detected') : t('hud.waiting')}</span><b>{motionProgress}%</b></div>
                  {training && <button className="quiet-button train-skip" onClick={() => { const active = gameRef.current; if (active && !trainingPauseRef.current) advanceTraining(active) }}>{t('train.skip')}</button>}
                </section>
              )}
              {trainingDone && (
                <section className="training-done" role="status">
                  <p className="eyebrow"><span className="live-dot" /> {t('mode.training')} ✓</p>
                  <h2>{t('train.doneTitle')}</h2>
                  <p>{t('train.doneText')}</p>
                  <PoseGlyph gesture="FREEZE" decor="handsUp" size={80} />
                  <div className="gesture-hint"><span>{handsUpProgress > 0 ? t('common.holdProgress', { n: Math.round(handsUpProgress * 100) }) : t('common.replayGesture')}</span><i><b style={{ width: `${handsUpProgress * 100}%` }} /></i></div>
                  <button className="primary-button compact" onClick={startHeistAfterTraining}>{t('train.startHeist')}</button>
                  <button className="quiet-button" onClick={exitToLobby}>{t('common.lobby')}</button>
                </section>
              )}
              <aside className="mission-rail">
                {MISSION.map((action, index) => <div key={action.gesture} className={index < game.phase ? 'done' : index === game.phase ? 'active' : ''}><b>0{index + 1}</b><span>{t(`move.${action.gesture}.name`)}</span></div>)}
              </aside>
              {!training && <aside className="combo-card"><span>{t('common.combo')}</span><b>×{game.stats.combo}</b><small>{t('common.accuracy', { n: accuracy })}</small></aside>}
              {movementError && !trainingDone && <ErrorOverlay error={movementError} />}
              {warning && <div className="warning-banner">⚠ {warning}</div>}
              {toast && <div className="success-toast">✓ {toast}</div>}
              {judge && <div key={judge.id} className={`judge-pop story-judge tone-${judge.grade.toLowerCase()}`} onAnimationEnd={() => setJudge(null)}><b>{t(`judge.${judge.grade}`)}</b></div>}
              {actCard && <div key={actCard.id} className="act-card" onAnimationEnd={() => setActCard(null)}><span>{t('act.label', { n: ROMAN[actCard.act - 1] })}</span><b>{t(actCard.act === 1 ? 'act.1' : actCard.act === 2 ? 'act.2' : 'act.3')}</b></div>}
              {vaultBreached && !training && (
                <div className="coin-burst" aria-hidden="true">
                  {coins.map((coin) => <i key={coin.id} style={{ '--x': `${coin.x}vw`, '--delay': `${coin.delay}ms`, '--spin': `${coin.spin}deg` } as CSSProperties} />)}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {screen === 'results' && dossier && (
        <SecurityDossierScreen
          report={dossier}
          defaultCallsign={playerName}
          onReplay={() => launch('story')}
          replayHint={camera.status === 'tracking' ? t('common.orRaiseHands') : undefined}
          onExit={exitToLobby}
          onBoot={playBoot}
          onConfirm={playConfirm}
          photo={<PhotoFinish snapshot={storyPhoto} name={dossier.telemetry.operative} score={dossier.score} crime="story" caption={t(`rank.${dossier.rank}`)} />}
        />
      )}

      {screen === 'arcadeResults' && arcadeResult && (
        <ArcadeResultsScreen
          result={arcadeResult}
          name={playerName.trim().toUpperCase() || t('landing.namePlaceholder')}
          replayProgress={handsUpProgress}
          onReplay={() => launch('arcade')}
          onExit={exitToLobby}
          onConfirm={playConfirm}
        />
      )}

      {screen === 'duelSwap' && duelResults[0] && (
        <DuelSwapScreen first={duelResults[0]} progress={handsUpProgress} onStart={() => void startCalibration()} onExit={exitToLobby} />
      )}

      {screen === 'duelResult' && duelResults.length >= 2 && (
        <DuelResultScreen results={[duelResults[0], duelResults[1]]} progress={handsUpProgress} onRematch={() => launch('duel')} onExit={exitToLobby} />
      )}

      {screen === 'leaderboard' && (
        <section className="leaderboard-screen panel-frame">
          <button className="back-button" onClick={() => setScreen('landing')}>{t('common.back')}</button>
          <p className="eyebrow"><span className="live-dot" /> {t('board.eyebrow')}</p>
          <h1>{t('board.title1')}<span>{t('board.title2')}</span></h1>
          <p className="board-note">{t('board.note')}</p>
          <div className="board-tabs" role="tablist">
            {(['story', 'arcade'] as const).map((tab) => (
              <button key={tab} role="tab" aria-selected={boardMode === tab} className={boardMode === tab ? 'active' : ''} onClick={() => setBoardMode(tab)}>{t(`mode.${tab}`)}</button>
            ))}
          </div>
          <div className="score-table">
            <div className="table-head"><span>{t('board.rank')}</span><span>{t('board.operative')}</span><span>{t('board.style')}</span><span>{t('board.accuracy')}</span><span>{t('common.score')}</span></div>
            {leaderboard.length ? leaderboard.map((entry, index) => <div className="table-row" key={entry.id}><span>{String(index + 1).padStart(2, '0')}</span><b>{entry.nickname}</b><span>{styleLabel(entry.style)}</span><span>{entry.accuracy}%</span><strong>{entry.score.toLocaleString()}</strong></div>) : <p className="empty-board">{t('board.empty')}</p>}
          </div>
          <button className="primary-button compact" onClick={() => setScreen('landing')}>{t('board.start')}</button>
        </section>
      )}
    </main>
  )
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
