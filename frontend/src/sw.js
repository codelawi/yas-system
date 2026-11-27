/**
 * Service worker: lets a phone open the system's pages with no connection to it, from the copy
 * saved on the "Work offline" page (offline.js).
 *
 * Online nothing changes: pages and data come from the server. When the server cannot be
 * reached, the app comes from this worker's cache and the data from the copy (offlineData.js),
 * with an X-Repo-Offline header so the app shows a banner. A PIN is then checked on the phone.
 *
 * Not part of the app bundle: vite.config.js copies it to /app/sw.js, fills in VERSION and
 * ASSETS and puts offlineData.js in place of OFFLINE_DATA. Laravel serves it at /sw.js so it
 * can answer every page.
 */

const VERSION = '__VERSION__'
const ASSETS = /* ASSETS */ []
/** The text reader's files (about 30 MB): kept once used or saved for offline, not with every app update. */
const OCR_ASSETS = /* OCR_ASSETS */ []

// Keep these names in sync with offline.js
const SHELL = `repo-shell-${VERSION}`
const DATA = 'repo-offline-data'
const PHOTOS = 'repo-offline-photos'
const OCR = 'repo-ocr' // also in ocr/files.js
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
      .then(dropOldOcrFiles)
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'snapshot-changed') snapshot = null
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const path = url.pathname
  if (request.method === 'POST' && path === '/api/auth/login') return event.respondWith(login(request))
  if (request.method !== 'GET') return

  // Pages: the same ones Laravel answers with the app (routes/web.php)
  if (request.mode === 'navigate') {
    if (!/^\/(api|app|storage)\//.test(path)) event.respondWith(page(request))
    return
  }
  if (path.startsWith('/app/')) return event.respondWith(asset(request))
  if (/^\/api\/equipment\/\d+\/photo$/.test(path)) return event.respondWith(photo(request))
  if (path.startsWith('/api/')) {
    const route = findRoute(url)
    if (route) return event.respondWith(data(request, route))
    // Anything else (history, stocktakes, settings pages...) is not in the copy
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
  if (OCR_ASSETS.includes(new URL(request.url).pathname)) return ocrAsset(request)
  const cache = await caches.open(SHELL)
  return (await cache.match(request, MATCH)) || fetch(request)
}

/** The text reader's files: from the phone once saved, otherwise downloaded and saved. */
async function ocrAsset(request) {
  const cache = await caches.open(OCR)
  const saved = await cache.match(request, MATCH)
  if (saved) return saved
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone()).catch(() => {})
  return response
}

/** Files of an older version of the text reader. */
async function dropOldOcrFiles() {
  const cache = await caches.open(OCR)
  for (const request of await cache.keys()) {
    if (!OCR_ASSETS.includes(new URL(request.url).pathname)) await cache.delete(request)
  }
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

async function data(request, route) {
  if (!isOffline()) {
    try {
      return await fromNetwork(request)
    } catch {
      /* answer from the saved copy */
    }
  }
  const copy = await loadSnapshot()
  if (!copy) return json(503, { message: 'offline_no_data' })
  // The app only keeps a token it got by entering a PIN (online, or on this phone below)
  const { status, body } = route.answer(copy, request.headers.has('Authorization'))
  return json(status, body)
}

/** Wrong PINs in a row before the phone waits, and how long (as PinConfirmation on the server). */
const PIN_TRIES = 5
const PIN_WAIT = 60000
let wrongPins = 0
let pinsBlockedUntil = 0

/**
 * Unlocking with a PIN: by the server when it can be reached, otherwise on the phone against the
 * PIN hashes in the copy. The phone's token is not one the server knows: it only unlocks the copy.
 */
async function login(request) {
  const sent = request.clone()
  if (!isOffline()) {
    try {
      return await fromNetwork(request)
    } catch {
      /* check the PIN on the phone */
    }
  }
  const copy = await loadSnapshot()
  if (!copy?.data.users?.length) return json(503, { message: 'offline_no_login' })
  if (Date.now() < pinsBlockedUntil) return pinError('too_many_attempts')

  let pin = ''
  try {
    pin = String((await sent.json()).pin ?? '')
  } catch {
    /* no PIN sent */
  }
  const user = pin ? await findUserByPin(copy.data.users, pin) : null
  if (!user) {
    if (++wrongPins >= PIN_TRIES) {
      wrongPins = 0
      pinsBlockedUntil = Date.now() + PIN_WAIT
    }
    return pinError('wrong_pin')
  }
  wrongPins = 0
  return json(200, { token: `offline.${crypto.randomUUID()}`, user })
}

/** A validation error as Laravel sends it. */
const pinError = (message) => json(422, { message, errors: { pin: [message] } })

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Repo-Offline': '1' },
  })
}

function loadSnapshot() {
  snapshot ||= readSnapshot().then((copy) => {
    if (!copy) snapshot = null // nothing saved yet: look again next time
    return copy
  })
  return snapshot
}

async function readSnapshot() {
  const cache = await caches.open(DATA)
  const response = await cache.match(SNAPSHOT_KEY)
  return response ? openCopy(await response.json()) : null
}

/* OFFLINE_DATA */
