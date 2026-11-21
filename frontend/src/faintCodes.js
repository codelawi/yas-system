// Faint codes: marks engraved in metal or plastic that are almost the same colour as the surface.
// The decoder treats differences smaller than about 24 grey levels as a plain surface, so a code that
// is only 10–15 levels darker (or lighter) than its surface is read only now and then, if at all.
// No imports, so it can be tested on its own with Node.

/** How many times larger the difference between a mark and its surroundings is made. */
const GAIN = 3

/**
 * A copy of the picture for faint codes: smoothed over 3×3 pixels (less camera noise), then each
 * pixel's difference from the average of its surroundings is made GAIN times larger. Uneven light
 * and reflections are removed with the average, the code's marks become clearly black and white,
 * and the plain surface stays plain.
 * `halfSize`: work on a half-size copy (averaging 4 pixels lowers the noise again, and it is faster);
 * best for medium and large codes. Small codes need the full size.
 * `image` is RGBA ({ data, width, height }, like ImageData); the result is RGBA too.
 */
export function boostFaint(image, { gain = GAIN, halfSize = true } = {}) {
  const src = image.data
  const srcW = image.width
  const W = halfSize ? srcW >> 1 : srcW
  const H = halfSize ? image.height >> 1 : image.height
  if (W < 16 || H < 16) return image
  const n = W * H

  // Grey ×4 (0..1020): the sum of 4 pixels at half size, one pixel ×4 at full size
  const grey = new Uint16Array(n)
  if (halfSize) {
    const row = srcW * 4
    for (let y = 0; y < H; y++) {
      let a = 2 * y * row
      let b = a + row
      const out = y * W
      for (let x = 0; x < W; x++, a += 8, b += 8) {
        grey[out + x] =
          (src[a] * 77 + src[a + 1] * 150 + src[a + 2] * 29 +
            src[a + 4] * 77 + src[a + 5] * 150 + src[a + 6] * 29 +
            src[b] * 77 + src[b + 1] * 150 + src[b + 2] * 29 +
            src[b + 4] * 77 + src[b + 5] * 150 + src[b + 6] * 29) >> 8
      }
    }
  } else {
    for (let i = 0, j = 0; i < n; i++, j += 4) grey[i] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 6
  }

  // 3×3 smoothing (×9 more: 0..9180)
  const across = new Uint16Array(n)
  for (let y = 0; y < H; y++) {
    const r = y * W
    across[r] = grey[r] * 2 + grey[r + 1]
    for (let x = 1; x < W - 1; x++) across[r + x] = grey[r + x - 1] + grey[r + x] + grey[r + x + 1]
    across[r + W - 1] = grey[r + W - 2] + grey[r + W - 1] * 2
  }
  const smooth = new Uint16Array(n)
  for (let y = 0; y < H; y++) {
    const up = (y > 0 ? y - 1 : y) * W
    const mid = y * W
    const down = (y < H - 1 ? y + 1 : y) * W
    for (let x = 0; x < W; x++) smooth[mid + x] = across[up + x] + across[mid + x] + across[down + x]
  }

  // Sums of every rectangle from the top left corner, for the average around each pixel
  const W1 = W + 1
  const sums = new Float64Array(W1 * (H + 1))
  for (let y = 0; y < H; y++) {
    let line = 0
    const r = y * W
    const k = (y + 1) * W1 + 1
    for (let x = 0; x < W; x++) {
      line += smooth[r + x]
      sums[k + x] = sums[k + x - W1] + line
    }
  }

  // The surroundings: a square a fifth of the picture wide (many modules of a small code, and
  // still more than one module of a code that fills the picture)
  const half = Math.max(4, Math.round(Math.min(W, H) / 10))
  const scale = gain / 36 // back to grey levels: ×4 ×9 (smoothing)
  const out = new Uint8ClampedArray(n * 4)
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - half) * W1
    const y1 = Math.min(H, y + half + 1) * W1
    const rows = Math.min(H, y + half + 1) - Math.max(0, y - half)
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - half)
      const x1 = Math.min(W, x + half + 1)
      const mean = (sums[y1 + x1] - sums[y0 + x1] - sums[y1 + x0] + sums[y0 + x0]) / (rows * (x1 - x0))
      const v = 128 + (smooth[y * W + x] - mean) * scale
      const j = (y * W + x) * 4
      out[j] = out[j + 1] = out[j + 2] = v
      out[j + 3] = 255
    }
  }
  return { data: out, width: W, height: H }
}
