import { useCallback, useEffect, useRef, useState } from 'react'
import { loadOcr, loadSerialIndex, readText } from '../ocr'
import { boxContains, capture, pixelsOf, visibleRegion } from '../ocr/capture'

/** Live reading: picture size handed to the reader, its detection size, and lines read (nearest the middle). */
const LIVE = { capture: 1280, detMax: 640, maxLines: 5 }
/** Frozen picture: read in full. */
const FROZEN = { capture: 2048, detMax: 960, maxLines: 40 }
/** Rest between two live readings (the phone stays cool and responsive). */
const LIVE_REST_MS = 120
/** A tap this close to a line (screen pixels, roughly) picks it. */
const TAP_MARGIN = 24

/**
 * The camera's text mode: reads the lines in the live picture again and again (boxes drawn over
 * the video), freezes the picture on a tap and reads it in full, and hands the chosen line on.
 *
 * Live lines are in video pixels; frozen lines are in the frozen picture's pixels.
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

  // Live reading
  useEffect(() => {
    if (!active || !running || engine.status !== 'ready') {
      setLiveLines([])
      return undefined
    }
    let stopped = false
    const loop = async () => {
      while (!stopped) {
        const el = video.current
        if (!frozenRef.current && el && el.readyState >= 2 && el.videoWidth) {
          try {
            const region = visibleRegion(el, zoomRef.current)
            const { canvas, scale } = capture(el, region, LIVE.capture)
            const lines = await readText(pixelsOf(canvas), { detMax: LIVE.detMax, maxLines: LIVE.maxLines })
            if (stopped || frozenRef.current) continue
            // Into video pixels
            setLiveLines(lines.map((line) => ({ ...line, box: line.box.map(([x, y]) => [region.x + x / scale, region.y + y / scale]) })))
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
    }
  }, [active, running, engine.status, video])

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
      const preview = liveLines.map((line) => ({ ...line, box: line.box.map(toFrozen) }))
      freezeCanvas(canvas, preview, tap ? toFrozen(tap) : null)
    },
    [video, liveLines, freezeCanvas],
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
    setLiveLines([])
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
    frozen,
    index,
    freeze,
    readPhoto,
    unfreeze,
  }
}
