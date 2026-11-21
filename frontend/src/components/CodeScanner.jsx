import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Slider } from 'antd'
import { CameraOutlined, CloseOutlined, PlayCircleOutlined, ReloadOutlined, ThunderboltFilled, ThunderboltOutlined } from '@ant-design/icons'
import { useLang } from '../i18n'
import { canUseLiveCamera, centerSquare, decodeFile, decodeRegion } from '../barcode'

/** Pause after a code is read, so the same code is not sent again at once. */
const PAUSE_MS = 1200
/** The same text read again within this time is ignored. */
const SAME_CODE_MS = 3000
/** Camera settings: the sharpest picture first, plain settings if the phone refuses or shows black. */
const CONSTRAINTS = {
  high: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  basic: { facingMode: { ideal: 'environment' } },
}
/** Size of the aiming square, as a part of the shorter side of the picture. */
const AIM = 0.6

/**
 * Full-screen camera that reads QR and Data Matrix codes again and again.
 * `onCode(text)` is called for each new code and may return a promise of { type, text } to show
 * (type: success | warning | error). On plain http the live camera is not allowed, so a
 * "take a photo" button opens the phone's own camera instead.
 */
export default function CodeScanner({ open, onClose, onCode, title }) {
  const { t } = useLang()
  const video = useRef(null)
  const canvas = useRef(null)
  const photo = useRef(null)
  const track = useRef(null)
  const busy = useRef(false)
  const last = useRef({ text: '', at: 0 })
  const [live] = useState(canUseLiveCamera)
  const [error, setError] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [zoom, setZoom] = useState(null) // { min, max, step, value, hardware }
  const [torch, setTorch] = useState(null) // null = not available
  const [reading, setReading] = useState(false)
  const [status, setStatus] = useState('starting') // starting | tap | running
  const [attempt, setAttempt] = useState(0) // bumped by "try again" to restart the camera
  // Read inside the camera loop without restarting the camera
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const onCodeRef = useRef(onCode)
  onCodeRef.current = onCode

  const handleText = useCallback(
    async (text) => {
      const now = Date.now()
      if (text === last.current.text && now - last.current.at < SAME_CODE_MS) return
      last.current = { text, at: now }
      busy.current = true
      try {
        navigator.vibrate?.(60)
        const result = await onCodeRef.current(text)
        if (result) {
          setFeedback(result)
          if (result.type !== 'success') navigator.vibrate?.([80, 60, 80])
        }
      } finally {
        setTimeout(() => {
          busy.current = false
        }, PAUSE_MS)
      }
    },
    [],
  )

  // Start the camera at the highest quality the phone gives, and read frames until closed
  useEffect(() => {
    if (!open || !live) return undefined
    let stopped = false
    let stream = null
    let frame = 0

    const stopStream = () => {
      stream?.getTracks().forEach((tr) => tr.stop())
      stream = null
      track.current = null
    }

    /** True once the video shows real frames; false if it stays black for `ms`. */
    const waitForFrames = async (el, ms) => {
      const until = Date.now() + ms
      while (!stopped && Date.now() < until) {
        if (el.readyState >= 2 && el.videoWidth > 0 && el.currentTime > 0) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return false
    }

    /** Opens the camera: the highest quality first, then plain settings if the phone can't (or shows black). */
    const start = async (quality = 'high') => {
      setError(null)
      setStatus('starting')
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: CONSTRAINTS[quality] })
      } catch (e) {
        if (stopped) return
        if (quality === 'high' && e?.name !== 'NotAllowedError' && e?.name !== 'SecurityError') return start('basic')
        setError({ key: e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'camera_denied' : 'camera_failed', detail: e?.name || String(e) })
        return
      }
      if (stopped) {
        stopStream()
        return
      }

      const el = video.current
      if (!el) {
        stopStream()
        return
      }
      // iPhone plays a camera video only when it is muted and inline
      el.muted = true
      el.setAttribute('muted', '')
      el.setAttribute('playsinline', '')
      el.srcObject = stream
      let playing = true
      try {
        await el.play()
      } catch {
        // The browser wants a tap before playing: show a button for it
        playing = false
        setStatus('tap')
      }
      const ok = await waitForFrames(el, playing ? 5000 : 120000)
      if (stopped) return
      if (!ok) {
        stopStream()
        if (quality === 'high') return start('basic')
        setError({ key: 'camera_black', detail: 'no frames' })
        return
      }
      setStatus('running')

      const [videoTrack] = stream.getVideoTracks()
      track.current = videoTrack
      const caps = videoTrack.getCapabilities?.() || {}
      try {
        if (caps.focusMode?.includes('continuous')) await videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
      } catch {
        /* the phone keeps its own focus */
      }
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        // Start a little zoomed in: holding the phone further away keeps small codes in focus
        const value = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2))
        try {
          await videoTrack.applyConstraints({ advanced: [{ zoom: value }] })
        } catch {
          /* keep 1x */
        }
        setZoom({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value, hardware: true })
      } else {
        // No camera zoom (e.g. iPhone): zoom the picture and read the middle part at full detail
        setZoom({ min: 1, max: 4, step: 0.1, value: 1.5, hardware: false })
      }
      setTorch(caps.torch ? false : null)
      loop()
    }

    const loop = async () => {
      while (!stopped) {
        const el = video.current
        if (!busy.current && el && el.readyState >= 2 && el.videoWidth) {
          const w = el.videoWidth
          const h = el.videoHeight
          const digital = zoomRef.current && !zoomRef.current.hardware ? zoomRef.current.value : 1
          // Mostly the aiming square at full detail (small engraved codes); sometimes the whole picture (big codes).
          // Codes almost the colour of their surface are boosted, half size and full size on alternate frames.
          const faint = frame % 2 ? 'full' : 'half'
          const attempt =
            frame % 3 === 2 && digital === 1
              ? { max: 1280, faint }
              : { crop: centerSquare(w, h, (frame % 3 === 1 ? AIM : AIM * 0.7) / digital), max: 1200, faint }
          frame += 1
          try {
            const text = await decodeRegion(el, w, h, canvas.current, attempt)
            if (text && !stopped) await handleText(text)
          } catch {
            /* a bad frame: try the next one */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }

    start()
    return () => {
      stopped = true
      stopStream()
      setTorch(null)
      setZoom(null)
      setFeedback(null)
      setStatus('starting')
    }
  }, [open, live, handleText, attempt])

  const changeZoom = async (value) => {
    setZoom((z) => ({ ...z, value }))
    if (zoom?.hardware) {
      try {
        await track.current?.applyConstraints({ advanced: [{ zoom: value }] })
      } catch {
        /* keep the previous zoom */
      }
    }
  }

  const toggleTorch = async () => {
    try {
      await track.current?.applyConstraints({ advanced: [{ torch: !torch }] })
      setTorch(!torch)
    } catch {
      setTorch(null)
    }
  }

  const onPhoto = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setReading(true)
    setFeedback(null)
    try {
      const text = await decodeFile(file)
      if (text) {
        last.current = { text: '', at: 0 } // a photo is always a deliberate scan
        await handleText(text)
      } else {
        navigator.vibrate?.([80, 60, 80])
        setFeedback({ type: 'error', text: t('scan_failed') })
      }
    } catch {
      setFeedback({ type: 'error', text: t('scan_failed') })
    } finally {
      setReading(false)
    }
  }

  if (!open) return null

  const digitalZoom = zoom && !zoom.hardware ? zoom.value : 1

  // On the page body, above everything (the phone layout's sliding pages would carry it along)
  return createPortal(
    <div className="code-scanner" role="dialog" aria-label={title || t('scan_title')}>
      <div className="code-scanner-top">
        <span className="code-scanner-title">{title || t('scan_title')}</span>
        <Button shape="circle" size="large" icon={<CloseOutlined />} onClick={onClose} aria-label={t('close')} />
      </div>

      {live && !error ? (
        <div className="code-scanner-view">
          <video ref={video} playsInline muted autoPlay style={{ transform: `scale(${digitalZoom})` }} />
          {status === 'running' && <div className="code-scanner-aim" />}
          {status === 'running' && <div className="code-scanner-hint">{t('scanner_hint')}</div>}
          {status === 'starting' && <div className="code-scanner-status">{t('camera_starting')}</div>}
          {status === 'tap' && (
            <div className="code-scanner-status">
              <Button type="primary" size="large" icon={<PlayCircleOutlined />} onClick={() => video.current?.play().catch(() => {})}>
                {t('camera_tap_start')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="code-scanner-view code-scanner-nolive">
          <p>{error ? t(error.key) : t('scanner_http_hint')}</p>
          {error?.detail && <p className="code-scanner-detail" dir="ltr">{error.detail}</p>}
          <Button type="primary" size="large" icon={<CameraOutlined />} loading={reading} onClick={() => photo.current?.click()}>
            {t('scan_photo')}
          </Button>
          {error && (
            <Button size="large" icon={<ReloadOutlined />} onClick={() => setAttempt((a) => a + 1)}>
              {t('try_again')}
            </Button>
          )}
        </div>
      )}
      <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
      <canvas ref={canvas} hidden />

      <div className="code-scanner-bottom">
        {feedback && <div className={`code-scanner-feedback is-${feedback.type}`}>{feedback.text}</div>}
        {live && !error && (
          <div className="code-scanner-controls">
            {zoom && (
              <div className="code-scanner-zoom">
                <span>{zoom.value.toFixed(1)}×</span>
                <Slider min={zoom.min} max={zoom.max} step={zoom.step} value={zoom.value} onChange={changeZoom} tooltip={{ open: false }} />
              </div>
            )}
            <Button shape="circle" size="large" icon={<CameraOutlined />} loading={reading} onClick={() => photo.current?.click()} aria-label={t('scan_photo')} />
            {torch !== null && (
              <Button shape="circle" size="large" icon={torch ? <ThunderboltFilled /> : <ThunderboltOutlined />} onClick={toggleTorch} aria-label={t('torch')} />
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
