/**
 * Photo finish: a still of the player at their best moment, framed as a
 * WANTED poster. Everything happens in canvases on this device; nothing is
 * uploaded, matching the "video never leaves the browser" promise.
 */

const SNAPSHOT_WIDTH = 640

/** Grabs the current video frame, mirrored like the on-screen preview. Null if the video has no frame yet. */
export const captureFrame = (video: HTMLVideoElement | null): HTMLCanvasElement | null => {
  if (!video || !video.videoWidth || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SNAPSHOT_WIDTH
    canvas.height = Math.round((SNAPSHOT_WIDTH * video.videoHeight) / video.videoWidth)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.translate(canvas.width, 0)
    context.scale(-1, 1)
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas
  } catch {
    return null
  }
}

export interface PosterInfo {
  wanted: string
  name: string
  reward: string
  rewardValue: string
  crime: string
  footer: string
  accent?: string
}

const WIDTH = 600
const HEIGHT = 820
const SERIF = 'Georgia, "Times New Roman", serif'
const MONO = '"SFMono-Regular", Consolas, monospace'

/** Shrinks the font until the text fits the width. */
const fitText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, family: string, weight = '900') => {
  let current = size
  do {
    ctx.font = `${weight} ${current}px ${family}`
    current -= 2
  } while (ctx.measureText(text).width > maxWidth && current > 12)
}

export const renderWantedPoster = (snapshot: HTMLCanvasElement | null, info: PosterInfo): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  // Aged paper with a vignette.
  const paper = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 120, WIDTH / 2, HEIGHT / 2, 560)
  paper.addColorStop(0, '#f3e2bb')
  paper.addColorStop(1, '#c9a86b')
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.globalAlpha = 0.07
  for (let i = 0; i < 900; i += 1) {
    ctx.fillStyle = i % 2 ? '#4a3212' : '#fff6de'
    ctx.fillRect(Math.random() * WIDTH, Math.random() * HEIGHT, 2, 2)
  }
  ctx.globalAlpha = 1
  ctx.strokeStyle = '#3b2610'
  ctx.lineWidth = 6
  ctx.strokeRect(18, 18, WIDTH - 36, HEIGHT - 36)
  ctx.lineWidth = 1.5
  ctx.strokeRect(30, 30, WIDTH - 60, HEIGHT - 60)

  ctx.fillStyle = '#2b1a08'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  fitText(ctx, info.wanted, WIDTH - 90, 86, SERIF)
  ctx.fillText(info.wanted, WIDTH / 2, 118)

  // The photo, in sepia, with a neon accent frame: half saloon, half cyber-heist.
  const photoX = 60
  const photoY = 145
  const photoW = WIDTH - 120
  const photoH = 390
  ctx.fillStyle = '#1b1208'
  ctx.fillRect(photoX - 6, photoY - 6, photoW + 12, photoH + 12)
  if (snapshot) {
    const scale = Math.max(photoW / snapshot.width, photoH / snapshot.height)
    const sw = photoW / scale
    const sh = photoH / scale
    ctx.save()
    ctx.filter = 'sepia(0.85) contrast(1.15) brightness(1.05)'
    ctx.drawImage(snapshot, (snapshot.width - sw) / 2, (snapshot.height - sh) / 2, sw, sh, photoX, photoY, photoW, photoH)
    ctx.restore()
  } else {
    ctx.fillStyle = '#3a2a15'
    ctx.fillRect(photoX, photoY, photoW, photoH)
    ctx.fillStyle = '#c9a86b'
    ctx.font = `700 120px ${SERIF}`
    ctx.fillText('?', WIDTH / 2, photoY + photoH / 2 + 40)
  }
  ctx.strokeStyle = info.accent ?? '#42ead8'
  ctx.lineWidth = 3
  ctx.shadowColor = info.accent ?? '#42ead8'
  ctx.shadowBlur = 12
  ctx.strokeRect(photoX - 2, photoY - 2, photoW + 4, photoH + 4)
  ctx.shadowBlur = 0

  ctx.fillStyle = '#2b1a08'
  fitText(ctx, info.name, WIDTH - 110, 54, SERIF)
  ctx.fillText(info.name, WIDTH / 2, 600)

  ctx.font = `700 22px ${MONO}`
  ctx.fillText(info.crime, WIDTH / 2, 638)

  ctx.strokeStyle = '#3b2610'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(90, 662)
  ctx.lineTo(WIDTH - 90, 662)
  ctx.stroke()

  ctx.font = `700 24px ${SERIF}`
  ctx.fillText(info.reward, WIDTH / 2, 700)
  ctx.fillStyle = '#7a1010'
  fitText(ctx, info.rewardValue, WIDTH - 110, 52, SERIF)
  ctx.fillText(info.rewardValue, WIDTH / 2, 752)

  ctx.fillStyle = 'rgba(43, 26, 8, .7)'
  ctx.font = `700 13px ${MONO}`
  ctx.fillText(info.footer, WIDTH / 2, HEIGHT - 44)
  return canvas
}
