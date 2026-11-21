import api from './api'

/** Downloads a file from the API (with the PIN token) and saves it. */
export async function downloadFile(url, params, fallbackName) {
  const res = await api.get(url, { params, responseType: 'blob' })
  const disposition = res.headers['content-disposition'] || ''
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  const name = match ? decodeURIComponent(match[1]) : fallbackName
  const href = URL.createObjectURL(res.data)
  const a = Object.assign(document.createElement('a'), { href, download: name })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

/* ---------- Scanning beep, loud enough to hear in a warehouse from a phone speaker */

/**
 * Square waves (much louder than a soft sine) at pitches a phone speaker plays loudly:
 * one high beep when a code is found, two low buzzes when it is not.
 */
const TONES = {
  good: [{ pitch: 2400, at: 0, length: 0.12 }],
  bad: [
    { pitch: 520, at: 0, length: 0.14 },
    { pitch: 520, at: 0.2, length: 0.14 },
  ],
}
/** Just under the loudest a page can play (1, where some phones crackle). The phone's media volume still applies. */
const VOLUME = 0.9

/** One sound output for every beep (a new one each time may stay silent on phones). */
let audio = null

function audioContext() {
  const Context = window.AudioContext || window.webkitAudioContext
  if (!Context) return null
  if (!audio || audio.state === 'closed') audio = new Context()
  if (audio.state !== 'running') audio.resume().catch(() => {})
  return audio
}

// Phones only let a page play sound after a touch: the first touch (and any after the sound
// was stopped, e.g. by a call) turns it on, so the beeps after a scan are heard
if (typeof window !== 'undefined') {
  const unlock = () => {
    if (audio?.state === 'running') return
    const ctx = audioContext()
    if (!ctx) return
    const silence = ctx.createBufferSource()
    silence.buffer = ctx.createBuffer(1, 1, 22050)
    silence.connect(ctx.destination)
    silence.start()
  }
  for (const type of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(type, unlock, { capture: true, passive: true })
}

/** A short, loud beep (scanning feedback). Good = one high beep, otherwise two low buzzes. */
export function beep(good = true) {
  try {
    const ctx = audioContext()
    if (!ctx) return
    const start = ctx.currentTime + 0.01
    for (const tone of good ? TONES.good : TONES.bad) {
      const from = start + tone.at
      const to = from + tone.length
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = tone.pitch
      // A few milliseconds up and down, so the speaker does not click
      gain.gain.setValueAtTime(0, from)
      gain.gain.linearRampToValueAtTime(VOLUME, from + 0.005)
      gain.gain.setValueAtTime(VOLUME, to - 0.01)
      gain.gain.linearRampToValueAtTime(0, to)
      osc.connect(gain).connect(ctx.destination)
      osc.start(from)
      osc.stop(to + 0.01)
    }
  } catch {
    /* no sound available */
  }
}
