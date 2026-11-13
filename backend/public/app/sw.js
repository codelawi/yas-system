/**
 * Service worker: lets a phone open scanned labels (/eq/<serial>, /box/<number>) with no
 * connection to the system, from the copy saved on the "Work offline" page (offline.js).
 *
 * Online nothing changes: pages and data come from the server. When the server cannot be
 * reached, the app comes from this worker's cache and the scan pages' data from the copy,
 * with an X-Repo-Offline header so the app shows a banner.
 *
 * Not part of the app bundle: vite.config.js copies it to /app/sw.js and fills in VERSION
 * and ASSETS. Laravel serves it at /sw.js so it can answer every page.
 */

const VERSION = "03bbcdfd2ad2"
const ASSETS = ["/app/assets/dist-BvmkWodH.js","/app/assets/es-BkxMLVLq.js","/app/assets/html2canvas-D94efmfd.js","/app/assets/ibm-plex-sans-arabic-arabic-400-normal-CyU-ddYS.woff2","/app/assets/ibm-plex-sans-arabic-arabic-500-normal-C4MQITzh.woff2","/app/assets/ibm-plex-sans-arabic-arabic-600-normal-0pRdybE_.woff2","/app/assets/ibm-plex-sans-arabic-arabic-700-normal-DrtBj6UE.woff2","/app/assets/index-BQ4yglKF.js","/app/assets/index-CnlUwWi4.css","/app/assets/index.es-7AVMHaTp.js","/app/assets/inter-cyrillic-ext-wght-normal-BOeWTOD4.woff2","/app/assets/inter-cyrillic-wght-normal-DqGufNeO.woff2","/app/assets/inter-greek-ext-wght-normal-DlzME5K_.woff2","/app/assets/inter-greek-wght-normal-CkhJZR-_.woff2","/app/assets/inter-latin-ext-wght-normal-DO1Apj_S.woff2","/app/assets/inter-latin-wght-normal-Dx4kXJAl.woff2","/app/assets/inter-vietnamese-wght-normal-CBcvBZtf.woff2","/app/assets/jetbrains-mono-cyrillic-wght-normal-D73BlboJ.woff2","/app/assets/jetbrains-mono-greek-wght-normal-Bw9x6K1M.woff2","/app/assets/jetbrains-mono-latin-ext-wght-normal-DBQx-q_a.woff2","/app/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2","/app/assets/jetbrains-mono-vietnamese-wght-normal-Bt-aOZkq.woff2","/app/assets/jspdf.es.min-D08h-kYV.js","/app/assets/pdf-Cut-V1Ez.js","/app/assets/pdf.worker.min-Bs4Efsjv.js","/app/assets/pdf.worker.min-h1J_HMyz.js","/app/assets/purify.es-Dqk5qvad.js","/app/favicon.svg"]

// Keep these names in sync with offline.js
const SHELL = `repo-shell-${VERSION}`
const DATA = 'repo-offline-data'
const PHOTOS = 'repo-offline-photos'
const SNAPSHOT_KEY = '/__offline__/snapshot.json'
const INDEX = '/app/index.html'

/** Waiting longer than this for the server means it cannot be reached (e.g. the phone is on another network). */
const TIMEOUT = 4000
/** After a failure, answer from the copy at once for this long instead of waiting again. */
const OFFLINE_FOR = 20000

let offlineUntil = 0
/** The parsed copy (a promise), read again when the page saves a new one. */
let snapshot = null

const isOffline = () => Date.now() < offlineUntil
const MATCH = { ignoreVary: true }

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll([INDEX, ...ASSETS].map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('repo-shell-') && key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'snapshot-changed') snapshot = null
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const path = url.pathname

  // Pages: the same ones Laravel answers with the app (routes/web.php)
  if (request.mode === 'navigate') {
    if (!/^\/(api|app|storage)\//.test(path)) event.respondWith(page(request))
    return
  }
  if (path.startsWith('/app/')) return event.respondWith(asset(request))
  if (/^\/api\/equipment\/\d+\/photo$/.test(path)) return event.respondWith(photo(request))
  if (path.startsWith('/api/')) {
    const answer = routeFor(path)
    if (answer) return event.respondWith(data(request, answer))
    // Anything else (history, custody, lists...) is not in the copy
    if (isOffline()) event.respondWith(json(503, { message: 'offline_no_edit' }))
  }
})

/** The server's answer, or a rejection when it fails or takes too long. */
function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offlineUntil = Date.now() + OFFLINE_FOR
      reject(new Error('timeout'))
    }, TIMEOUT)
    fetch(request).then(
      (response) => {
        clearTimeout(timer)
        offlineUntil = 0
        resolve(response)
      },
      (error) => {
        clearTimeout(timer)
        offlineUntil = Date.now() + OFFLINE_FOR
        reject(error)
      },
    )
  })
}

async function page(request) {
  if (!isOffline()) {
    try {
      return await fromNetwork(request)
    } catch {
      /* the server cannot be reached: open the saved app */
    }
  }
  const cache = await caches.open(SHELL)
  return (await cache.match(INDEX, MATCH)) || Response.error()
}

/** App files have a hash in their name, so the saved one is always right. */
async function asset(request) {
  const cache = await caches.open(SHELL)
  return (await cache.match(request, MATCH)) || fetch(request)
}

/** A photo's URL changes with every new photo, so a saved one never goes stale. */
async function photo(request) {
  const cache = await caches.open(PHOTOS)
  const saved = await cache.match(request, MATCH)
  if (saved) return saved
  if (!isOffline()) {
    try {
      return await fromNetwork(request)
    } catch {
      /* no photo without a connection */
    }
  }
  return new Response('', { status: 404 })
}

async function data(request, answer) {
  if (!isOffline()) {
    try {
      return await fromNetwork(request)
    } catch {
      /* answer from the saved copy */
    }
  }
  const copy = await loadSnapshot()
  if (!copy) return json(503, { message: 'offline_no_data' })
  const body = answer(copy)
  return body === undefined ? json(404, { message: 'not_found' }) : json(200, body)
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Repo-Offline': '1' },
  })
}

const decode = (part) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** The GET requests the scan pages make, answered from the copy (undefined = not found). */
const ROUTES = [
  [/^\/api\/settings$/, (copy) => copy.data.settings],
  [/^\/api\/equipment\/serial\/(.+)$/, (copy, serial) => copy.equipmentBySerial(decode(serial))],
  [/^\/api\/equipment\/(\d+)$/, (copy, id) => copy.equipment.get(Number(id))],
  [/^\/api\/equipment\/(\d+)\/maintenance$/, (copy, id) => (copy.equipment.has(Number(id)) ? copy.data.maintenance[id] || { schedules: [], records: [] } : undefined)],
  [/^\/api\/equipment\/(\d+)\/issues$/, (copy, id) => (copy.equipment.has(Number(id)) ? copy.data.issues[id] || [] : undefined)],
  [/^\/api\/boxes\/number\/(.+)$/, (copy, number) => copy.boxByNumber(decode(number))],
  [/^\/api\/boxes\/(\d+)$/, (copy, id) => copy.boxes.get(Number(id))],
]

function routeFor(path) {
  for (const [pattern, handler] of ROUTES) {
    const match = path.match(pattern)
    if (match) return (copy) => handler(copy, ...match.slice(1))
  }
  return null
}

function loadSnapshot() {
  snapshot ||= readSnapshot().then((copy) => {
    if (!copy) snapshot = null // nothing saved yet: look again next time
    return copy
  })
  return snapshot
}

/** Lookups as the server does them (MySQL compares case-insensitively and ignores trailing spaces). */
const loose = (text) => String(text).trimEnd().toLowerCase()

async function readSnapshot() {
  const cache = await caches.open(DATA)
  const response = await cache.match(SNAPSHOT_KEY)
  if (!response) return null
  const data = await response.json()

  const equipment = new Map(data.equipment.map((e) => [e.id, e]))
  const boxes = new Map(data.boxes.map((b) => [b.id, b]))
  const serials = new Map(Object.entries(data.serials))
  const looseSerials = new Map()
  for (const [serial, id] of serials) if (!looseSerials.has(loose(serial))) looseSerials.set(loose(serial), id)
  const boxNumbers = new Map()
  for (const box of data.boxes) if (!boxNumbers.has(loose(box.number))) boxNumbers.set(loose(box.number), box)

  return {
    data,
    equipment,
    boxes,
    equipmentBySerial: (serial) => equipment.get(serials.get(serial) ?? looseSerials.get(loose(serial))),
    boxByNumber: (number) => boxNumbers.get(loose(number)),
  }
}
