// Reads QR codes and Data Matrix codes (the small square codes engraved on equipment such as Petzl gear).
// zxing-wasm runs on every phone, iPhone included. Its .wasm file is part of the build, so it works with
// no internet connection (by default the library would download it from a CDN).
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
  },
})

const OPTIONS = {
  formats: ['QRCode', 'MicroQRCode', 'DataMatrix'],
  // Engraved codes are light marks on dark metal (inverted), often small, blurred or tilted
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
}

/** The text of the first code found in the picture, or null. */
export async function decodeImageData(imageData) {
  const results = await readBarcodes(imageData, OPTIONS)
  const found = results.find((r) => r.isValid && r.text)
  return found ? found.text : null
}

/**
 * Draws part of a picture (video frame, photo) into the canvas and reads it.
 * `crop` is the part to read, as fractions of the picture; `max` limits the longest side in pixels.
 */
export async function decodeRegion(source, width, height, canvas, { crop = [0, 0, 1, 1], max = 1600 } = {}) {
  const [cx, cy, cw, ch] = crop
  const sx = Math.round(cx * width)
  const sy = Math.round(cy * height)
  const sw = Math.round(cw * width)
  const sh = Math.round(ch * height)
  const scale = Math.min(1, max / Math.max(sw, sh))
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return decodeImageData(ctx.getImageData(0, 0, canvas.width, canvas.height))
}

/** The square in the middle of a picture, as fractions (the scanner's aiming frame). */
export function centerSquare(width, height, part = 0.6) {
  const side = Math.min(width, height) * part
  return [(width - side) / 2 / width, (height - side) / 2 / height, side / width, side / height]
}

/** Reads a code from a photo: the whole photo first, then the middle at full detail (small codes). */
export async function decodeFile(file) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  const { width, height } = bitmap
  try {
    const attempts = [
      { max: 1600 },
      { crop: centerSquare(width, height, 0.5), max: 2400 },
      { crop: centerSquare(width, height, 0.25), max: 2400 },
      { max: 3000 },
    ]
    for (const attempt of attempts) {
      const text = await decodeRegion(bitmap, width, height, canvas, attempt)
      if (text) return text
    }
    return null
  } finally {
    bitmap.close?.()
  }
}

/** Live camera needs https (or localhost): phones refuse it on plain http. */
export const canUseLiveCamera = () => !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia)
