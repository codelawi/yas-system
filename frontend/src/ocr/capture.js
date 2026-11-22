/**
 * Pictures for the text reader: the part of the camera picture the user sees, a copy of it to
 * freeze on screen, and a small photo of the chosen line.
 */

/**
 * The part of the video frame shown on screen (the video fills its box, cut at the sides, and may
 * be zoomed in from the middle), in video pixels.
 */
export function visibleRegion(video, zoom = 1) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const box = video.parentElement.getBoundingClientRect()
  const cover = Math.max(box.width / vw, box.height / vh) * zoom
  const w = Math.min(vw, box.width / cover)
  const h = Math.min(vh, box.height / cover)
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h }
}

/**
 * Draws a part of a picture (video, photo) into a new canvas, its longer side at most `max`.
 * Returns { canvas, scale } where scale = canvas pixels per picture pixel.
 */
export function capture(source, region, max) {
  const scale = Math.min(1, max / Math.max(region.w, region.h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(region.w * scale))
  canvas.height = Math.max(1, Math.round(region.h * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height)
  return { canvas, scale }
}

export const pixelsOf = (canvas) => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height)

/** Longest side of the photo kept with a row. */
const CROP_MAX = 800

/** A JPEG of the line's box (with a margin), as proof of what was read. */
export function cropLine(canvas, box) {
  const xs = box.map((p) => p[0])
  const ys = box.map((p) => p[1])
  const height = Math.max(...ys) - Math.min(...ys)
  const margin = Math.max(8, height * 0.6)
  const x = Math.max(0, Math.min(...xs) - margin)
  const y = Math.max(0, Math.min(...ys) - margin)
  const w = Math.min(canvas.width, Math.max(...xs) + margin) - x
  const h = Math.min(canvas.height, Math.max(...ys) + margin) - y
  const { canvas: out } = capture(canvas, { x, y, w, h }, CROP_MAX)
  return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.85))
}

/** Is the point inside the line's box (grown by `margin` pixels)? */
export function boxContains(box, [px, py], margin = 0) {
  // The box is a rectangle (any angle): check the point against each side
  const center = [(box[0][0] + box[2][0]) / 2, (box[0][1] + box[2][1]) / 2]
  for (let i = 0; i < 4; i++) {
    const a = box[i]
    const b = box[(i + 1) % 4]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const side = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) / len
    const inner = ((b[0] - a[0]) * (center[1] - a[1]) - (b[1] - a[1]) * (center[0] - a[0])) / len
    if (Math.sign(side) !== Math.sign(inner) && Math.abs(side) > margin) return false
  }
  return true
}
