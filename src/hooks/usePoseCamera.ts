import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Landmark, PoseFrame } from '../types/pose'

export type CameraStatus = 'idle' | 'requesting' | 'initializing' | 'tracking' | 'denied' | 'unsupported' | 'error'

interface CameraState {
  status: CameraStatus
  message: string
  fps: number
}

interface UsePoseCameraOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  onFrame: (frame: PoseFrame | null) => void
  focusPoints?: number[]
}

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task'

const CONNECTIONS: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [15, 17], [15, 19], [15, 21], [16, 18], [16, 20], [16, 22],
]

const drawPose = (canvas: HTMLCanvasElement, landmarks: Landmark[] | undefined, focus: number[]) => {
  const context = canvas.getContext('2d')
  if (!context) return
  const width = canvas.width
  const height = canvas.height
  context.clearRect(0, 0, width, height)
  if (!landmarks?.length) return

  context.lineCap = 'round'
  for (const [from, to] of CONNECTIONS) {
    const a = landmarks[from]
    const b = landmarks[to]
    if (!a || !b || (a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue
    const highlighted = focus.includes(from) || focus.includes(to)
    context.beginPath()
    context.strokeStyle = highlighted ? 'rgba(255, 92, 92, .96)' : 'rgba(64, 232, 255, .72)'
    context.lineWidth = highlighted ? 4 : 2.4
    context.moveTo(a.x * width, a.y * height)
    context.lineTo(b.x * width, b.y * height)
    context.stroke()
  }
  landmarks.forEach((point, index) => {
    if ((point.visibility ?? 1) < 0.35) return
    const highlighted = focus.includes(index)
    context.beginPath()
    context.fillStyle = highlighted ? '#ff6969' : '#d9fbff'
    context.shadowColor = highlighted ? '#ff3434' : '#00d9ff'
    context.shadowBlur = highlighted ? 16 : 8
    context.arc(point.x * width, point.y * height, highlighted ? 5.5 : 3.2, 0, Math.PI * 2)
    context.fill()
  })
  context.shadowBlur = 0
}

const snapshot = (landmarks: Landmark[], worldLandmarks: Landmark[] | undefined, timestamp: number): PoseFrame => ({
  landmarks: landmarks.map((point) => ({ ...point })),
  worldLandmarks: worldLandmarks?.map((point) => ({ ...point })),
  timestamp,
})

export const usePoseCamera = ({ videoRef, canvasRef, onFrame, focusPoints = [] }: UsePoseCameraOptions) => {
  const [state, setState] = useState<CameraState>({ status: 'idle', message: 'Camera standing by.', fps: 0 })
  const detectorRef = useRef<PoseLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animationRef = useRef<number | null>(null)
  const lastInferenceRef = useRef(0)
  const onFrameRef = useRef(onFrame)
  const focusRef = useRef(focusPoints)
  const mountedRef = useRef(true)
  const fpsFramesRef = useRef(0)
  const fpsStartedRef = useRef(0)

  useEffect(() => { onFrameRef.current = onFrame }, [onFrame])
  useEffect(() => { focusRef.current = focusPoints }, [focusPoints])

  const stop = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
    detectorRef.current?.close()
    detectorRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    const video = videoRef.current
    if (video) video.srcObject = null
    onFrameRef.current(null)
    if (mountedRef.current) setState({ status: 'idle', message: 'Camera paused.', fps: 0 })
  }, [videoRef])

  const start = useCallback(async () => {
    if (detectorRef.current || streamRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({ status: 'unsupported', message: 'This browser cannot access a camera.', fps: 0 })
      return
    }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      setState({ status: 'unsupported', message: 'Camera requires HTTPS. Open the secure deployment.', fps: 0 })
      return
    }

    try {
      setState({ status: 'requesting', message: 'Requesting camera access…', fps: 0 })
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: false,
      })
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const video = videoRef.current
      if (!video) throw new Error('Camera preview is unavailable.')
      video.srcObject = stream
      await new Promise<void>((resolve) => { video.onloadedmetadata = () => resolve() })
      await video.play()

      setState({ status: 'initializing', message: 'Loading motion intelligence…', fps: 0 })
      const vision = await FilesetResolver.forVisionTasks(WASM_URL)
      try {
        detectorRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
        })
      } catch {
        detectorRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
        })
      }
      if (!mountedRef.current) return
      fpsStartedRef.current = performance.now()
      setState({ status: 'tracking', message: 'Motion system online.', fps: 0 })

      const process = (now: number) => {
        const activeVideo = videoRef.current
        const activeCanvas = canvasRef.current
        const detector = detectorRef.current
        if (!activeVideo || !detector || !streamRef.current) return
        if (activeVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && now - lastInferenceRef.current > 31) {
          lastInferenceRef.current = now
          detector.detectForVideo(activeVideo, now, (result) => {
            const landmarks = result.landmarks[0] as Landmark[] | undefined
            if (activeCanvas && activeVideo.videoWidth && activeVideo.videoHeight) {
              if (activeCanvas.width !== activeVideo.videoWidth || activeCanvas.height !== activeVideo.videoHeight) {
                activeCanvas.width = activeVideo.videoWidth
                activeCanvas.height = activeVideo.videoHeight
              }
              drawPose(activeCanvas, landmarks, focusRef.current)
            }
            onFrameRef.current(landmarks ? snapshot(landmarks, result.worldLandmarks[0] as Landmark[] | undefined, now) : null)
            fpsFramesRef.current += 1
            if (now - fpsStartedRef.current > 1000) {
              const fps = Math.round((fpsFramesRef.current * 1000) / (now - fpsStartedRef.current))
              fpsFramesRef.current = 0
              fpsStartedRef.current = now
              if (mountedRef.current) setState((current) => ({ ...current, fps }))
            }
          })
        }
        animationRef.current = requestAnimationFrame(process)
      }
      animationRef.current = requestAnimationFrame(process)
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      const name = error instanceof DOMException ? error.name : ''
      const message = name === 'NotAllowedError'
        ? 'Camera access was denied. Allow it in your browser, then retry.'
        : name === 'NotFoundError'
          ? 'No camera was found. Connect a camera and retry.'
          : 'The motion system could not start. Check your connection and retry.'
      if (mountedRef.current) setState({ status: name === 'NotAllowedError' ? 'denied' : 'error', message, fps: 0 })
    }
  }, [canvasRef, videoRef])

  useEffect(() => () => {
    mountedRef.current = false
    stop()
  }, [stop])

  return { ...state, start, stop }
}
