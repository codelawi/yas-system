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

const VERSION = '__VERSION__'
const ASSETS = /* ASSETS */ []

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
    const answer = routeFor(url)
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
  [/^\/api\/lookup$/, (copy, query) => copy.lookup(query.get('code') || '')],
]

/** Handlers get the parts of the path in brackets, then the query (?code=...). */
function routeFor(url) {
  for (const [pattern, handler] of ROUTES) {
    const match = url.pathname.match(pattern)
    if (match) return (copy) => handler(copy, ...match.slice(1), url.searchParams)
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

  // Main equipment before accessories, as a scanned label does
  const ordered = [...data.equipment].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0) || a.id - b.id)

  return {
    data,
    equipment,
    boxes,
    equipmentBySerial: (serial) => equipment.get(serials.get(serial) ?? looseSerials.get(loose(serial))),
    boxByNumber: (number) => boxNumbers.get(loose(number)),
    lookup: (code) => lookup(ordered, data.boxes, code),
  }
}

/** At most this many equipment and this many boxes; shorter codes are only looked up exactly. Same as the server. */
const LOOKUP_LIMIT = 30
const MIN_CONTAINS = 3

/**
 * What a scanned code that is not one of the system's labels belongs to (a maker's Data Matrix...):
 * as LookupController on the server. Equipment whose serial number or any field is the code, and
 * boxes whose number or name is; only when there are none, those that contain it.
 */
function lookup(equipment, boxes, raw) {
  const code = raw.trim()
  if (!code) return { code: '', matches: [] }
  const wanted = code.toLowerCase()
  const exact = (value) => value != null && loose(value) === wanted
  const contains = (value) => value != null && String(value).toLowerCase().includes(wanted)

  let matches = find(equipment, boxes, exact)
  if (!matches.length && [...code].length >= MIN_CONTAINS) matches = find(equipment, boxes, contains)
  return { code, matches }
}

function find(equipment, boxes, test) {
  const found = []
  for (const e of equipment) {
    if (found.length >= LOOKUP_LIMIT) break
    const bySerial = test(e.serial_number)
    const field = bySerial ? null : e.fields.find((f) => test(f.value))
    if (!bySerial && !field) continue
    found.push({
      type: 'equipment',
      id: e.id,
      serial_number: e.serial_number,
      display_name: e.display_name,
      category: e.category,
      parent: e.parent,
      photo_url: e.photo_url,
      match: field ? { by: 'field', key: field.key } : { by: 'serial', key: null },
    })
  }
  const inBoxes = boxes
    .filter((b) => test(b.number) || test(b.name))
    .slice(0, LOOKUP_LIMIT)
    .map((b) => ({ type: 'box', id: b.id, number: b.number, name: b.name, match: { by: test(b.number) ? 'number' : 'name', key: null } }))
  return [...found, ...inBoxes]
}
