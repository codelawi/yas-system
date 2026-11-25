import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { loadOcr, loadSerialIndex, readText } from '../ocr'
import { boxContains, capture, pixelsOf, visibleRegion } from '../ocr/capture'
import { apply, createTracker } from '../ocr/tracker'

/** Live reading: picture size handed to the reader, its detection size, and lines read (nearest the middle). */
const LIVE = { capture: 1280, detMax: 640, maxLines: 5 }
/** Frozen picture: read in full. */
const FROZEN = { capture: 2048, detMax: 960, maxLines: 40 }
/** Rest between two live readings (the phone stays cool and responsive). */
const LIVE_REST_MS = 120
/** A tap this close to a line (screen pixels, roughly) picks it. */
const TAP_MARGIN = 24

/** The SVG transform for a movement (see ocr/tracker). */
const matrix = (T) => `matrix(${T.a} ${T.b} ${-T.b} ${T.a} ${T.tx} ${T.ty})`

/**
 * The camera's text mode: reads the lines in the live picture again and again (boxes drawn over
 * the video), freezes the picture on a tap and reads it in full, and hands the chosen line on.
 *
 * Reading takes about a second, so the boxes are moved with the camera on every frame in between
 * (ocr/tracker): the boxes stay on the text, and the next reading corrects them. When the movement
 * can't be followed the boxes go until the next reading finds the text again.
 *
 * Live lines are in video pixels of the frame they were read from, drawn inside `liveGroup` (an
 * SVG <g>) whose transform moves them to the current frame; frozen lines are in the frozen
 * picture's pixels.
 */
export default function useTextReader({ active, video, running, zoom, onPick }) {
  const [engine, setEngine] = useState({ status: 'idle', progress: 0 }) // idle | loading | ready | failed
  const [liveLines, setLiveLines] = useState([])
  const [frozen, setFrozen] = useState(null) // { url, canvas, width, height, lines, reading }
  const [index, setIndex] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const frozenRef = useRef(frozen)
  frozenRef.current = frozen
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const tracker = useRef(null)
  tracker.current ||= createTracker()
  const live = useRef(null) // { lines, mark }: the lines shown, and the moment they were read
  const liveGroup = useRef(null)

  /** Moves the live boxes to the current frame; drops them when the movement was lost. */
  const place = useCallback(() => {
    if (!live.current) return
    const T = tracker.current.since(live.current.mark)
    if (!T) {
      live.current = null
      setLiveLines([])
      return
    }
    liveGroup.current?.setAttribute('transform', matrix(T))
  }, [])

  /** The live lines where they are now (video pixels). */
  const currentLines = useCallback(() => {
    const T = live.current && tracker.current.since(live.current.mark)
    if (!T) return []
    return live.current.lines.map((line) => ({ ...line, box: line.box.map((p) => apply(T, p)) }))
  }, [])

  // New lines: put them where the text is now, before they are painted
  useLayoutEffect(place, [liveLines, place])

  // Load the reader and the serial numbers once text mode is opened
  useEffect(() => {
    if (!active) return undefined
    let stopped = false
    setEngine((e) => (e.status === 'ready' ? e : { status: 'loading', progress: 0 }))
    loadOcr((progress) => !stopped && setEngine({ status: 'loading', progress }))
      .then(() => !stopped && setEngine({ status: 'ready', progress: 1 }))
      .catch((error) => !stopped && setEngine({ status: 'failed', progress: 0, error: String(error?.message || error) }))
    loadSerialIndex().then((found) => !stopped && setIndex(found))
    return () => {
      stopped = true
    }
  }, [active, attempt])

  // Live reading, and following the camera's movement on every frame
  useEffect(() => {
    const clear = () => {
      live.current = null
      setLiveLines([])
      tracker.current.reset()
    }
    if (!active || !running || engine.status !== 'ready') {
      clear()
      return undefined
    }
    let stopped = false
    const ready = (el) => !frozenRef.current && el && el.readyState >= 2 && el.videoWidth

    // Each new camera frame (or screen refresh where frame callbacks don't exist)
    let pending = null
    const follow = () => {
      if (stopped) return
      const el = video.current
      if (ready(el)) {
        try {
          tracker.current.step(el, visibleRegion(el, zoomRef.current))
          place()
        } catch {
          /* a bad frame: try the next one */
        }
      }
      next()
    }
    const next = () => {
      const el = video.current
      if (el?.requestVideoFrameCallback) pending = { el, id: el.requestVideoFrameCallback(follow) }
      else pending = { raf: requestAnimationFrame(follow) }
    }
    next()

    const loop = async () => {
      while (!stopped) {
        const el = video.current
        if (ready(el)) {
          try {
            const region = visibleRegion(el, zoomRef.current)
            // The movement up to this very frame, so the lines read can be moved on from it
            tracker.current.step(el, region)
            const mark = tracker.current.mark()
            const { canvas, scale } = capture(el, region, LIVE.capture)
            const lines = await readText(pixelsOf(canvas), { detMax: LIVE.detMax, maxLines: LIVE.maxLines })
            if (stopped || frozenRef.current) continue
            // Lost while reading: wait for the next reading
            if (!tracker.current.since(mark)) continue
            // Into video pixels (of the frame read)
            const read = lines.map((line) => ({ ...line, box: line.box.map(([x, y]) => [region.x + x / scale, region.y + y / scale]) }))
            live.current = read.length ? { lines: read, mark } : null
            setLiveLines(read)
            // Follow the text itself most closely (not the background)
            const T = tracker.current.since(mark)
            const corners = read.flatMap((line) => line.box).map((p) => apply(T, p))
            if (corners.length) {
              const xs = corners.map((p) => p[0])
              const ys = corners.map((p) => p[1])
              const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
              tracker.current.focus([
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
              ])
            } else tracker.current.focus(null)
          } catch {
            /* a bad frame: try the next one */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, LIVE_REST_MS))
      }
    }
    loop()
    return () => {
      stopped = true
      if (pending?.raf) cancelAnimationFrame(pending.raf)
      else if (pending?.el) pending.el.cancelVideoFrameCallback?.(pending.id)
    }
  }, [active, running, engine.status, video, place])

  /** Shows a picture frozen, reads it in full; a line under `point` (picture pixels) is picked at once. */
  const freezeCanvas = useCallback(async (canvas, preview, point) => {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    const url = URL.createObjectURL(blob)
    setFrozen({ url, canvas, width: canvas.width, height: canvas.height, lines: preview, reading: true })
    let lines = preview
    try {
      lines = await readText(pixelsOf(canvas), { detMax: FROZEN.detMax, maxLines: FROZEN.maxLines })
    } catch {
      /* keep the live boxes */
    }
    // Still the same frozen picture (not closed meanwhile)?
    if (frozenRef.current?.url !== url) return
    setFrozen((f) => ({ ...f, lines, reading: false }))
    if (point) {
      const margin = TAP_MARGIN * (canvas.width / (video.current?.parentElement?.clientWidth || canvas.width))
      // The line under the finger, otherwise the nearest one within reach
      const near = lines.filter((line) => boxContains(line.box, point, margin))
      const under = near.filter((line) => boxContains(line.box, point, 0))
      const pool = under.length ? under : near
      const byDistance = (line) => Math.hypot((line.box[0][0] + line.box[2][0]) / 2 - point[0], (line.box[0][1] + line.box[2][1]) / 2 - point[1])
      const hit = pool.sort((a, b) => byDistance(a) - byDistance(b))[0]
      if (hit) onPickRef.current(hit, canvas)
    }
  }, [video])

  /** Freezes the live picture; `tap` is the tapped point in video pixels (or null). */
  const freeze = useCallback(
    (tap) => {
      const el = video.current
      if (!el || frozenRef.current || !el.videoWidth) return
      const region = visibleRegion(el, zoomRef.current)
      const { canvas, scale } = capture(el, region, FROZEN.capture)
      const toFrozen = ([x, y]) => [(x - region.x) * scale, (y - region.y) * scale]
      el.pause()
      const preview = currentLines().map((line) => ({ ...line, box: line.box.map(toFrozen) }))
      freezeCanvas(canvas, preview, tap ? toFrozen(tap) : null)
    },
    [video, currentLines, freezeCanvas],
  )

  /** Reads a photo (plain http, or the photo button). */
  const readPhoto = useCallback(
    async (file) => {
      const bitmap = await createImageBitmap(file)
      const { canvas } = capture(bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, FROZEN.capture)
      video.current?.pause()
      await freezeCanvas(canvas, [], null)
    },
    [video, freezeCanvas],
  )

  const unfreeze = useCallback(() => {
    if (frozenRef.current?.url) URL.revokeObjectURL(frozenRef.current.url)
    setFrozen(null)
    live.current = null
    setLiveLines([])
    tracker.current.reset()
    video.current?.play().catch(() => {})
  }, [video])

  // Leaving text mode or closing the camera
  useEffect(() => {
    if (!active && frozenRef.current) unfreeze()
  }, [active, unfreeze])

  return {
    engine,
    retry: () => setAttempt((a) => a + 1),
    liveLines,
    liveGroup,
    frozen,
    index,
    freeze,
    readPhoto,
    unfreeze,
  }
}
