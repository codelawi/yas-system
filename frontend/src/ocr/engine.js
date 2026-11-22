/**
 * Reads text in a picture, as PaddleOCR does: a detection model finds the text lines (any angle),
 * a small model tells upside-down lines, and the English recognition model reads each line.
 * Runs the models with ONNX Runtime; `ort` is passed in so the same code runs in the browser's
 * worker and in Node (tests).
 *
 * Models (PaddleOCR, Apache-2.0): PP-OCRv4 detection, PP-OCRv3 English recognition, text
 * direction classifier (mobile v2.0).
 *
 * An image is { data: RGBA bytes, width, height } (like ImageData). A line is
 * { text, score, box: [[x, y] × 4] } with the corners top-left, top-right, bottom-right,
 * bottom-left in the image's pixels, in reading order.
 */

/**
 * Characters of the English model (index 0 of its output is "blank"): its dictionary, which
 * ends with a space, then the space PaddleOCR adds after any dictionary.
 */
const EN_CHARS = [..."0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~!\"#$%&'()*+,-./ ", ' ']

/** Detection: picture scaled so its longer side is at most this (a multiple of 32 on each side). */
const DET_MAX = 960
/** A pixel is text when the model is this sure, and a line is kept when it is this sure on average. */
const DET_PIXEL = 0.3
const DET_BOX = 0.5
/** Lines are grown by this much around the found pixels (the model finds a narrower core). */
const UNCLIP = 1.6
/** Lines thinner than this (pixels of the scaled picture) are noise. */
const MIN_SIZE = 3
/** Recognition reads lines at this height. */
const REC_HEIGHT = 48
/** Shorter lines are padded to this width (the model was trained on 320-wide lines). */
const REC_MIN_WIDTH = 320
/** Longest line read (width at REC_HEIGHT): longer lines are squeezed. */
const REC_MAX_WIDTH = 1600
/** Lines read with less confidence than this are dropped. */
const REC_MIN_SCORE = 0.5
/** Classifier input size, and how sure it must be to turn a line upside down. */
const CLS_HEIGHT = 48
const CLS_WIDTH = 192
const CLS_SURE = 0.9
/** Lines this much taller than wide are read turned a quarter (vertical text). */
const VERTICAL = 1.5

/** ImageNet mean / std, applied to blue, green, red in that order (the models were trained on BGR pictures). */
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

/**
 * @param ort   onnxruntime-web (or onnxruntime-node)
 * @param files { det, rec, cls }: the model files (ArrayBuffer / Uint8Array)
 */
export async function createEngine(ort, files, options = {}) {
  const sessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...options.session }
  const [det, rec, cls] = await Promise.all([
    ort.InferenceSession.create(toBytes(files.det), sessionOptions),
    ort.InferenceSession.create(toBytes(files.rec), sessionOptions),
    ort.InferenceSession.create(toBytes(files.cls), sessionOptions),
  ])

  const run = async (session, data, dims) => {
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', data, dims) }
    const result = await session.run(feeds)
    const output = result[session.outputNames[0]]
    return { data: output.data, dims: output.dims }
  }

  /**
   * The text lines in the image.
   * @param opts.detMax   longer side for detection (smaller is faster, bigger finds smaller text)
   * @param opts.maxLines read at most this many lines, those nearest the middle first
   */
  async function recognize(image, opts = {}) {
    const boxes = await detect(image, opts.detMax || DET_MAX)
    let chosen = boxes
    if (opts.maxLines && boxes.length > opts.maxLines) {
      const cx = image.width / 2
      const cy = image.height / 2
      chosen = [...boxes].sort((a, b) => distance(centerOf(a), [cx, cy]) - distance(centerOf(b), [cx, cy])).slice(0, opts.maxLines)
    }
    const lines = []
    for (const box of chosen) {
      const line = await read(image, box)
      if (line) lines.push(line)
    }
    return sortReading(lines)
  }

  async function detect(image, detMax) {
    const scale = Math.min(1, detMax / Math.max(image.width, image.height))
    const w = Math.max(32, Math.round((image.width * scale) / 32) * 32)
    const h = Math.max(32, Math.round((image.height * scale) / 32) * 32)
    const input = new Float32Array(3 * w * h)
    const plane = w * h
    const sx = image.width / w
    const sy = image.height / h
    const pixel = new Float32Array(3)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        bilinear(image, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, pixel)
        const i = y * w + x
        // pixel is R, G, B; the model wants B, G, R
        input[i] = (pixel[2] / 255 - DET_MEAN[0]) / DET_STD[0]
        input[plane + i] = (pixel[1] / 255 - DET_MEAN[1]) / DET_STD[1]
        input[2 * plane + i] = (pixel[0] / 255 - DET_MEAN[2]) / DET_STD[2]
      }
    }
    const out = await run(det, input, [1, 3, h, w])
    return findBoxes(out.data, out.dims[3], out.dims[2]).map((corners) => corners.map(([x, y]) => [x * sx, y * sy]))
  }

  /** Reads one line, or null when it reads as nothing sure. */
  async function read(image, box) {
    let [tl, tr, br, bl] = box
    const width = Math.max(distance(tl, tr), distance(bl, br))
    const height = Math.max(distance(tl, bl), distance(tr, br))
    let lineW = width
    let lineH = height
    // Vertical text: read it turned a quarter to the left, as PaddleOCR does
    if (height / width >= VERTICAL) {
      ;[tl, tr, br, bl] = [tr, br, bl, tl]
      ;[lineW, lineH] = [height, width]
    }
    if (lineW < 2 || lineH < 2) return null

    // Upside down?
    const clsW = Math.min(CLS_WIDTH, Math.max(1, Math.ceil((CLS_HEIGHT * lineW) / lineH)))
    const clsInput = sampleLine(image, tl, tr, bl, clsW, CLS_HEIGHT, CLS_WIDTH)
    const turn = await run(cls, clsInput, [1, 3, CLS_HEIGHT, CLS_WIDTH])
    if (turn.data[1] > turn.data[0] && turn.data[1] >= CLS_SURE) [tl, tr, br, bl] = [br, bl, tl, tr]

    const recW = Math.min(REC_MAX_WIDTH, Math.max(REC_HEIGHT / 2, Math.ceil((REC_HEIGHT * lineW) / lineH)))
    const padW = Math.max(REC_MIN_WIDTH, recW)
    const recInput = sampleLine(image, tl, tr, bl, recW, REC_HEIGHT, padW)
    const out = await run(rec, recInput, [1, 3, REC_HEIGHT, padW])
    const { text, score } = decode(out.data, out.dims[1], out.dims[2])
    const clean = text.trim()
    if (!clean || score < REC_MIN_SCORE) return null
    return { text: clean, score, box: [tl, tr, br, bl] }
  }

  return { recognize }
}

const toBytes = (file) => (file instanceof Uint8Array ? file : new Uint8Array(file))

/**
 * The line between p0 (top-left), p1 (top-right) and p3 (bottom-left), sampled to w × h and
 * placed at the left of a padW-wide tensor (the rest is 0), normalised to -1..1, as B, G, R.
 */
function sampleLine(image, p0, p1, p3, w, h, padW) {
  const out = new Float32Array(3 * h * padW)
  const plane = h * padW
  const ux = (p1[0] - p0[0]) / w
  const uy = (p1[1] - p0[1]) / w
  const vx = (p3[0] - p0[0]) / h
  const vy = (p3[1] - p0[1]) / h
  // Shrinking a lot skips pixels: average n × n samples per output pixel instead
  const n = Math.max(1, Math.min(4, Math.ceil(Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy)))))
  const pixel = new Float32Array(3)
  const sum = new Float32Array(3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sum.fill(0)
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const ox = x + (sx + 0.5) / n
          const oy = y + (sy + 0.5) / n
          bilinear(image, p0[0] + ux * ox + vx * oy - 0.5, p0[1] + uy * ox + vy * oy - 0.5, pixel)
          sum[0] += pixel[0]
          sum[1] += pixel[1]
          sum[2] += pixel[2]
        }
      }
      const k = 1 / (n * n)
      const i = y * padW + x
      out[i] = (sum[2] * k) / 127.5 - 1
      out[plane + i] = (sum[1] * k) / 127.5 - 1
      out[2 * plane + i] = (sum[0] * k) / 127.5 - 1
    }
  }
  return out
}

/** The colour at a point between pixels (edges repeat). */
function bilinear(image, fx, fy, out) {
  const { data, width, height } = image
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)))
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const ax = Math.max(0, Math.min(1, fx - x0))
  const ay = Math.max(0, Math.min(1, fy - y0))
  const i00 = (y0 * width + x0) * 4
  const i10 = (y0 * width + x1) * 4
  const i01 = (y1 * width + x0) * 4
  const i11 = (y1 * width + x1) * 4
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * ax
    const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * ax
    out[c] = top + (bottom - top) * ay
  }
}

/** Greedy CTC: the most likely character at each step, repeats and blanks dropped. */
function decode(probs, steps, classes) {
  let text = ''
  let total = 0
  let count = 0
  let previous = 0
  for (let t = 0; t < steps; t++) {
    let best = 0
    let bestP = probs[t * classes]
    for (let c = 1; c < classes; c++) {
      const p = probs[t * classes + c]
      if (p > bestP) {
        bestP = p
        best = c
      }
    }
    if (best !== 0 && best !== previous && best - 1 < EN_CHARS.length) {
      text += EN_CHARS[best - 1]
      total += bestP
      count += 1
    }
    previous = best
  }
  return { text, score: count ? total / count : 0 }
}

/**
 * Text lines in the detection map: each group of touching sure pixels becomes the smallest
 * rectangle around it (at any angle), grown a little. Returns corners in map pixels.
 */
export function findBoxes(prob, w, h) {
  const seen = new Uint8Array(w * h)
  const boxes = []
  const stack = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= DET_PIXEL) continue
    // Flood fill one group, keeping its edge pixels (enough for the rectangle) and its average score
    seen[start] = 1
    stack.push(start)
    const edge = []
    let sum = 0
    let count = 0
    while (stack.length) {
      const i = stack.pop()
      const x = i % w
      const y = (i - x) / w
      sum += prob[i]
      count += 1
      let isEdge = false
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          isEdge = true
          continue
        }
        const n = ny * w + nx
        if (prob[n] <= DET_PIXEL) {
          isEdge = true
          continue
        }
        if (!seen[n]) {
          seen[n] = 1
          stack.push(n)
        }
      }
      if (isEdge) edge.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1])
    }
    if (count < MIN_SIZE * MIN_SIZE || sum / count < DET_BOX) continue
    const rect = minAreaRect(convexHull(edge))
    if (!rect || Math.min(rect.w, rect.h) < MIN_SIZE) continue
    // Grow by area × ratio / perimeter on every side (PaddleOCR's "unclip")
    const grow = (rect.w * rect.h * UNCLIP) / (2 * (rect.w + rect.h))
    rect.w += 2 * grow
    rect.h += 2 * grow
    if (Math.min(rect.w, rect.h) < MIN_SIZE + 2) continue
    boxes.push(corners(rect, w, h))
  }
  return boxes
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** Andrew's monotone chain. */
function convexHull(points) {
  if (points.length < 3) return points
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** The smallest rectangle around a convex hull: one of its sides lies on a hull edge. */
function minAreaRect(hull) {
  if (hull.length < 3) return null
  let best = null
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (!len) continue
    const ex = (b[0] - a[0]) / len
    const ey = (b[1] - a[1]) / len
    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const p of hull) {
      const u = p[0] * ex + p[1] * ey
      const v = -p[0] * ey + p[1] * ex
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2
      const cv = (minV + maxV) / 2
      best = { area, cx: cu * ex - cv * ey, cy: cu * ey + cv * ex, w: maxU - minU, h: maxV - minV, ex, ey }
    }
  }
  return best
}

/**
 * Corners top-left, top-right, bottom-right, bottom-left: "right" is the rectangle's side
 * nearest to horizontal, pointing right, and "down" points down.
 */
function corners(rect, mapW, mapH) {
  let { w, h, ex, ey } = rect
  // The axis nearest horizontal is the reading direction
  if (Math.abs(ex) < Math.abs(ey)) {
    ;[ex, ey] = [ey, -ex]
    ;[w, h] = [h, w]
  }
  if (ex < 0) {
    ex = -ex
    ey = -ey
  }
  // Down = the reading direction turned a quarter clockwise (y grows downwards)
  const dx = -ey
  const dy = ex
  const clamp = ([x, y]) => [Math.max(0, Math.min(mapW, x)), Math.max(0, Math.min(mapH, y))]
  const at = (u, v) => clamp([rect.cx + ex * u + dx * v, rect.cy + ey * u + dy * v])
  return [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)]
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const centerOf = (box) => [(box[0][0] + box[2][0]) / 2, (box[0][1] + box[2][1]) / 2]

/** Top to bottom; lines at about the same height left to right. */
function sortReading(lines) {
  return lines.sort((a, b) => {
    const ca = centerOf(a.box)
    const cb = centerOf(b.box)
    const lineH = Math.min(distance(a.box[0], a.box[3]), distance(b.box[0], b.box[3]))
    return Math.abs(ca[1] - cb[1]) < lineH / 2 ? ca[0] - cb[0] : ca[1] - cb[1]
  })
}
