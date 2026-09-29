/** Part of a canvas that `object-fit: cover` leaves on screen, in canvas pixels. */
export interface ViewBounds {
  left: number
  right: number
  top: number
  bottom: number
}

export interface CoverViewport {
  /** Canvas pixels per CSS pixel: multiply CSS sizes by this to draw them at a fixed on-screen size. */
  px: number
  bounds: ViewBounds
}

export const createCoverViewport = (): CoverViewport => ({ px: 1, bounds: { left: 0, right: 0, top: 0, bottom: 0 } })

/** Mutates `viewport` in place so render loops can hold one object for their lifetime. */
export const measureCoverViewport = (canvas: HTMLCanvasElement, viewport: CoverViewport) => {
  const { clientWidth, clientHeight, width, height } = canvas
  if (!clientWidth || !clientHeight || !width || !height) return
  const scale = Math.max(clientWidth / width, clientHeight / height)
  const visibleWidth = clientWidth / scale
  const visibleHeight = clientHeight / scale
  viewport.px = 1 / scale
  viewport.bounds.left = (width - visibleWidth) / 2
  viewport.bounds.right = viewport.bounds.left + visibleWidth
  viewport.bounds.top = (height - visibleHeight) / 2
  viewport.bounds.bottom = viewport.bounds.top + visibleHeight
}

/** Keeps the overlay's backing store at the video's native size so landmarks map 1:1. Returns true on resize. */
export const syncCanvasToVideo = (canvas: HTMLCanvasElement, video: HTMLVideoElement | null) => {
  if (!video?.videoWidth || (canvas.width === video.videoWidth && canvas.height === video.videoHeight)) return false
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  return true
}
