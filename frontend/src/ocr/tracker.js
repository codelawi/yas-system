/**
 * Follows the camera's movement from frame to frame, so the boxes drawn over text lines stay on
 * the text while the (much slower) text reader works in the background.
 *
 * Each frame is shrunk to a small grey picture. Points with texture (corners, letters) are picked
 * in a key frame and found again in each new frame (coarse to fine, sub-pixel), and one movement
 * (shift, zoom and turn) is fitted to them, ignoring the points that disagree. Points are searched
 * for from the key frame, not the previous frame, so small errors don't add up while the camera is
 * held still. A new key frame is taken when the view has changed enough.
 *
 * When the movement can't be followed (too fast, covered, blurred), the tracker is "lost": its
 * epoch changes, and anything placed before that is no longer valid.
 *
 * Movements are similarities { a, b, tx, ty }: x' = a·x − b·y + tx, y' = b·x + a·y + ty.
 */

/** Width of the grey picture followed (its height keeps the picture's shape). */
const SMALL = 192
/** Points are picked one per cell of this grid. */
const GRID_X = 8
const GRID_Y = 6
/** Patch radius on the full and half-size pictures. */
const R0 = 4
const R1 = 2
/** Search radius (pixels) on the half-size picture, then on the full one. */
const SEARCH1 = 6
const SEARCH0 = 2
/** Fewest points agreeing on a movement. */
const MIN_POINTS = 6
/** Mean difference per pixel (0–255, brightness removed) above which a point is not found. */
const MAX_ERR = 20
/** Weakest texture a point may have. */
const MIN_TEXTURE = 250

export const IDENT = Object.freeze({ a: 1, b: 0, tx: 0, ty: 0 })

/** A then B applied first: compose(A, B)(p) = A(B(p)). */
export function compose(A, B) {
  return {
    a: A.a * B.a - A.b * B.b,
    b: A.a * B.b + A.b * B.a,
    tx: A.a * B.tx - A.b * B.ty + A.tx,
    ty: A.b * B.tx + A.a * B.ty + A.ty,
  }
}

export function invert(T) {
  const d = T.a * T.a + T.b * T.b || 1
  const a = T.a / d
  const b = -T.b / d
  return { a, b, tx: -(a * T.tx - b * T.ty), ty: -(b * T.tx + a * T.ty) }
}

export const apply = (T, [x, y]) => [T.a * x - T.b * y + T.tx, T.b * x + T.a * y + T.ty]

/** The movement that takes points P to Q best (least squares). */
export function fitSimilarity(P, Q) {
  const n = P.length
  let pmx = 0
  let pmy = 0
  let qmx = 0
  let qmy = 0
  for (let i = 0; i < n; i++) {
    pmx += P[i][0]
    pmy += P[i][1]
    qmx += Q[i][0]
    qmy += Q[i][1]
  }
  pmx /= n
  pmy /= n
  qmx /= n
  qmy /= n
  let s = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    const px = P[i][0] - pmx
    const py = P[i][1] - pmy
    const qx = Q[i][0] - qmx
    const qy = Q[i][1] - qmy
    s += px * px + py * py
    sa += px * qx + py * qy
    sb += px * qy - py * qx
  }
  const a = s ? sa / s : 1
  const b = s ? sb / s : 0
  return { a, b, tx: qmx - (a * pmx - b * pmy), ty: qmy - (b * pmx + a * pmy) }
}

/** Fits a movement, then again without the points far from it. Null when too few agree. */
export function robustFit(P, Q) {
  if (P.length < MIN_POINTS) return null
  let keep = P.map((_, i) => i)
  let T = fitSimilarity(P, Q)
  for (let round = 0; round < 3; round++) {
    const errors = P.map((p, i) => {
      const [x, y] = apply(T, p)
      return Math.hypot(x - Q[i][0], y - Q[i][1])
    })
    const sorted = [...errors].sort((x, y) => x - y)
    const limit = Math.max(0.75, 3 * sorted[sorted.length >> 1])
    keep = errors.map((e, i) => (e <= limit ? i : -1)).filter((i) => i >= 0)
    if (keep.length < MIN_POINTS) return null
    T = fitSimilarity(
      keep.map((i) => P[i]),
      keep.map((i) => Q[i]),
    )
  }
  return { T, inliers: keep.length }
}

// ---------------------------------------------------------------- pictures

function integral(data, w, h) {
  const W = w + 1
  const sum = new Float64Array(W * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += data[y * w + x]
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row
    }
  }
  return sum
}

const image = (w, h, data) => ({ w, h, data, sum: integral(data, w, h) })

/** Sum over [x0..x1] × [y0..y1] (inclusive). */
function boxSum(sum, w, x0, y0, x1, y1) {
  const W = w + 1
  return sum[(y1 + 1) * W + x1 + 1] - sum[y0 * W + x1 + 1] - sum[(y1 + 1) * W + x0] + sum[y0 * W + x0]
}

function half(img) {
  const w = img.w >> 1
  const h = img.h >> 1
  const out = new Float32Array(w * h)
  const d = img.data
  for (let y = 0; y < h; y++) {
    const i = 2 * y * img.w
    for (let x = 0; x < w; x++) {
      const j = i + 2 * x
      out[y * w + x] = (d[j] + d[j + 1] + d[j + img.w] + d[j + img.w + 1]) / 4
    }
  }
  return image(w, h, out)
}

/** The patch around (x, y) with its mean taken off (brightness changes don't matter). */
function patch(img, x, y, r) {
  const size = 2 * r + 1
  const out = new Float32Array(size * size)
  const mean = boxSum(img.sum, img.w, x - r, y - r, x + r, y + r) / (size * size)
  let k = 0
  for (let dy = -r; dy <= r; dy++) {
    let i = (y + dy) * img.w + x - r
    for (let dx = -r; dx <= r; dx++) out[k++] = img.data[i++] - mean
  }
  return out
}

/** How different the patch at (x, y) is from tpl; stops counting past `limit`. */
function difference(img, tpl, r, x, y, limit) {
  const size = 2 * r + 1
  const mean = boxSum(img.sum, img.w, x - r, y - r, x + r, y + r) / (size * size)
  const d = img.data
  let s = 0
  let k = 0
  for (let dy = -r; dy <= r; dy++) {
    let i = (y + dy) * img.w + x - r
    for (let dx = -r; dx <= r; dx++) s += Math.abs(d[i++] - mean - tpl[k++])
    if (s >= limit) return s
  }
  return s
}

const inside = (img, x, y, r) => x - r >= 0 && y - r >= 0 && x + r < img.w && y + r < img.h

/** Best place for tpl within `radius` of (cx, cy): { x, y, err, scores } (scores: the search grid). */
function search(img, tpl, r, cx, cy, radius, keepScores) {
  const size = 2 * radius + 1
  const scores = keepScores ? new Float32Array(size * size).fill(Infinity) : null
  let best = Infinity
  let bx = 0
  let by = 0
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (!inside(img, x, y, r)) continue
      const s = difference(img, tpl, r, x, y, keepScores ? Infinity : best)
      if (scores) scores[(y - cy + radius) * size + x - cx + radius] = s
      if (s < best) {
        best = s
        bx = x
        by = y
      }
    }
  }
  return { x: bx, y: by, err: best, scores }
}

/** Sub-pixel offset of a minimum from its two neighbours (−0.5 … 0.5). */
function parabola(left, mid, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0
  const den = left - 2 * mid + right
  return den > 0 ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * den))) : 0
}

/**
 * Points worth following in a picture: the strongest corner-like texture in each grid cell,
 * within `rect` ({ x0, y0, x1, y1 }, picture pixels) when given.
 */
function selectPoints(img, l1, rect) {
  const { w, h, data } = img
  const n = w * h
  const xx = new Float32Array(n)
  const yy = new Float32Array(n)
  const xy = new Float32Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = (data[i + 1] - data[i - 1]) / 2
      const gy = (data[i + w] - data[i - w]) / 2
      xx[i] = gx * gx
      yy[i] = gy * gy
      xy[i] = gx * gy
    }
  }
  const sxx = integral(xx, w, h)
  const syy = integral(yy, w, h)
  const sxy = integral(xy, w, h)

  // Room for both patches (the half-size one is centred on x >> 1)
  const margin = Math.max(R0, 2 * R1 + 1) + 1
  let x0 = margin
  let y0 = margin
  let x1 = w - 1 - margin
  let y1 = h - 1 - margin
  if (rect) {
    const rx0 = Math.max(x0, Math.floor(rect.x0))
    const ry0 = Math.max(y0, Math.floor(rect.y0))
    const rx1 = Math.min(x1, Math.ceil(rect.x1))
    const ry1 = Math.min(y1, Math.ceil(rect.y1))
    // Too small (or off the picture): use the whole picture
    if (rx1 - rx0 >= 32 && ry1 - ry0 >= 20) [x0, y0, x1, y1] = [rx0, ry0, rx1, ry1]
  }
  const cw = (x1 - x0 + 1) / GRID_X
  const ch = (y1 - y0 + 1) / GRID_Y
  const best = new Float32Array(GRID_X * GRID_Y)
  const at = new Int32Array(GRID_X * GRID_Y).fill(-1)
  const r = R0
  for (let y = y0; y <= y1; y++) {
    const cy = Math.min(GRID_Y - 1, Math.floor((y - y0) / ch))
    for (let x = x0; x <= x1; x++) {
      const a = boxSum(sxx, w, x - r, y - r, x + r, y + r)
      const c = boxSum(syy, w, x - r, y - r, x + r, y + r)
      const b = boxSum(sxy, w, x - r, y - r, x + r, y + r)
      // The weaker of the two directions: high only at corners, not along a single edge
      const score = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b)
      const cell = cy * GRID_X + Math.min(GRID_X - 1, Math.floor((x - x0) / cw))
      if (score > best[cell]) {
        best[cell] = score
        at[cell] = y * w + x
      }
    }
  }
  const strongest = Math.max(...best)
  const points = []
  for (let cell = 0; cell < at.length; cell++) {
    if (at[cell] < 0 || best[cell] < Math.max(MIN_TEXTURE, strongest * 0.02)) continue
    const x = at[cell] % w
    const y = Math.floor(at[cell] / w)
    if (!inside(l1, x >> 1, y >> 1, R1)) continue
    points.push({ x, y, tpl0: patch(img, x, y, R0), tpl1: patch(l1, x >> 1, y >> 1, R1) })
  }
  return points
}

/** Where `point` (from the key frame) is in `frame`, looking near `guess`. Null if not found. */
function find(point, frame, guess) {
  const c = search(frame.l1, point.tpl1, R1, Math.round(guess[0] / 2), Math.round(guess[1] / 2), SEARCH1, false)
  if (!Number.isFinite(c.err)) return null
  const cx = point.x + 2 * (c.x - (point.x >> 1))
  const cy = point.y + 2 * (c.y - (point.y >> 1))
  const f = search(frame.l0, point.tpl0, R0, cx, cy, SEARCH0, true)
  if (!Number.isFinite(f.err) || f.err / ((2 * R0 + 1) ** 2) > MAX_ERR) return null
  const size = 2 * SEARCH0 + 1
  const gx = f.x - cx + SEARCH0
  const gy = f.y - cy + SEARCH0
  const score = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? Infinity : f.scores[y * size + x])
  return [f.x + parabola(score(gx - 1, gy), f.err, score(gx + 1, gy)), f.y + parabola(score(gx, gy - 1), f.err, score(gx, gy + 1))]
}

// ---------------------------------------------------------------- tracker

/**
 * @param options.pixels (video, region, w, h) → grey Float32Array of w × h; by default drawn
 *        from the video through a canvas (tests pass their own pictures)
 */
export function createTracker({ pixels } = {}) {
  let canvas = null
  let ctx = null
  let key = null // the key frame: { l0, l1, region, k, points }
  let rel = IDENT // key frame → current frame (small-picture pixels)
  let last = IDENT // key frame → previous frame (for the speed)
  let base = IDENT // epoch start → key frame (video pixels)
  let epoch = 0
  let hint = null // corners of the area to follow (video pixels at the epoch start)
  let refocus = false

  /** The current frame as a small grey picture of the visible region. */
  function grab(video, region) {
    const w = SMALL
    const h = Math.max(24, Math.round((SMALL * region.h) / region.w))
    let grey
    if (pixels) grey = pixels(video, region, w, h)
    else {
      if (!canvas) canvas = document.createElement('canvas')
      if (canvas.width !== w || canvas.height !== h || !ctx) {
        canvas.width = w
        canvas.height = h
        ctx = canvas.getContext('2d', { willReadFrequently: true })
      }
      ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, w, h)
      const px = ctx.getImageData(0, 0, w, h).data
      grey = new Float32Array(w * h)
      for (let i = 0, j = 0; i < grey.length; i++, j += 4) grey[i] = px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114
    }
    const l0 = image(w, h, grey)
    return { l0, l1: half(l0), region, k: w / region.w }
  }

  /** A small-picture movement in video pixels. */
  function toVideo(T, frame) {
    const { k, region } = frame
    const S = { a: k, b: 0, tx: -k * region.x, ty: -k * region.y }
    const back = { a: 1 / k, b: 0, tx: region.x, ty: region.y }
    return compose(back, compose(T, S))
  }

  function makeKey(frame) {
    let rect = null
    if (hint) {
      // The area to follow, as it is now (base: epoch start → this frame), a little larger
      const pts = hint.map((p) => apply(base, p)).map(([x, y]) => [(x - frame.region.x) * frame.k, (y - frame.region.y) * frame.k])
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const grow = Math.max(12, 0.4 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)))
      rect = { x0: Math.min(...xs) - grow, y0: Math.min(...ys) - grow, x1: Math.max(...xs) + grow, y1: Math.max(...ys) + grow }
    }
    const points = selectPoints(frame.l0, frame.l1, rect)
    refocus = false
    return { ...frame, points }
  }

  /** Starts again from this frame: whatever was placed before no longer counts. */
  function lose(frame) {
    epoch++
    base = IDENT
    rel = IDENT
    last = IDENT
    hint = null
    key = frame ? makeKey(frame) : null
  }

  /** This frame becomes the key frame (the movement so far is kept). */
  function rekey(frame) {
    base = compose(toVideo(rel, key), base)
    last = compose(last, invert(rel))
    rel = IDENT
    key = makeKey(frame)
  }

  const sameRegion = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5

  return {
    /**
     * Follows the movement to the video's current frame. `region` is the visible part of the
     * video (video pixels). Returns false when the movement was lost.
     */
    step(video, region) {
      const frame = grab(video, region)
      if (!key) {
        key = makeKey(frame)
        return true
      }
      if (!sameRegion(key.region, region)) {
        // Zoomed: the picture is not comparable with the last one
        lose(frame)
        return false
      }
      if (key.points.length < MIN_POINTS) {
        // Nothing to follow (a plain surface): keep things where they are, look again
        rekey(frame)
        return true
      }
      const P = []
      const Q = []
      for (const point of key.points) {
        const p = [point.x, point.y]
        const now = apply(rel, p)
        const before = apply(last, p)
        // Carry on at the same speed
        const q = find(point, frame, [2 * now[0] - before[0], 2 * now[1] - before[1]])
        if (q) {
          P.push(p)
          Q.push(q)
        }
      }
      const fit = robustFit(P, Q)
      const scale = fit ? Math.hypot(fit.T.a, fit.T.b) : 0
      const turn = fit ? Math.atan2(fit.T.b, fit.T.a) : 0
      if (!fit || fit.inliers < Math.max(MIN_POINTS, 0.4 * key.points.length) || scale < 0.75 || scale > 1.33 || Math.abs(turn) > 0.3) {
        lose(frame)
        return false
      }
      last = rel
      rel = fit.T
      if (refocus || fit.inliers < 0.7 * key.points.length || Math.abs(scale - 1) > 0.1 || Math.abs(turn) > 0.1) rekey(frame)
      return true
    },

    /** Changes each time the movement is lost. */
    get epoch() {
      return epoch
    },

    /** Remembers this moment: { epoch, M } (M: epoch start → now, video pixels). */
    mark() {
      return { epoch, M: key ? compose(toVideo(rel, key), base) : IDENT }
    },

    /** The movement from a mark to now (video pixels), or null when lost since then. */
    since(mark) {
      if (!mark || mark.epoch !== epoch) return null
      const now = key ? compose(toVideo(rel, key), base) : IDENT
      return compose(now, invert(mark.M))
    },

    /** Points (video pixels, now) to follow most closely: the text lines. Null: the whole picture. */
    focus(points) {
      if (!points?.length) {
        hint = null
        return
      }
      const now = key ? compose(toVideo(rel, key), base) : IDENT
      const back = invert(now)
      hint = points.map((p) => apply(back, p))
      refocus = true
    },

    reset() {
      lose(null)
    },
  }
}
