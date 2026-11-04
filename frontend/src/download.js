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

/** A short beep (scanning feedback). Good = higher tone. */
export function beep(good = true) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = good ? 880 : 300
    gain.gain.value = 0.08
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + (good ? 0.09 : 0.25))
    osc.onended = () => ctx.close()
  } catch {
    /* no sound available */
  }
}
