/**
 * Service worker: lets a phone open the system's pages with no connection to it, from the copy
 * saved on the "Work offline" page (offline.js), and make changes that wait on the phone until
 * it syncs (offlineSync.js).
 *
 * Online nothing changes: pages and data come from the server. When the server cannot be
 * reached, the app comes from this worker's cache and the data from the copy (offlineData.js),
 * with an X-Repo-Offline header so the app shows a banner. A PIN is then checked on the phone.
 * A change is then kept on the phone and applied to the copy (offlineEdit.js); while any is
 * waiting the phone stays on its copy, even with a connection, until it syncs.
 *
 * Not part of the app bundle: vite.config.js copies it to /app/sw.js, fills in VERSION and
 * ASSETS and puts offlineData.js and offlineEdit.js in place of OFFLINE_DATA and OFFLINE_EDIT.
 * Laravel serves it at /sw.js so it can answer every page.
 */

const VERSION = "3d8832b97c4a"
const ASSETS = ["/app/assets/dist-CjWoxUJ5.js","/app/assets/es-BkxMLVLq.js","/app/assets/html2canvas-Dlhqv_g4.js","/app/assets/ibm-plex-sans-arabic-arabic-400-normal-CyU-ddYS.woff2","/app/assets/ibm-plex-sans-arabic-arabic-500-normal-C4MQITzh.woff2","/app/assets/ibm-plex-sans-arabic-arabic-600-normal-0pRdybE_.woff2","/app/assets/ibm-plex-sans-arabic-arabic-700-normal-DrtBj6UE.woff2","/app/assets/index-BC636b4A.css","/app/assets/index-DKGCjj7V.js","/app/assets/index.es-C_ufJ2e3.js","/app/assets/inter-cyrillic-ext-wght-normal-BOeWTOD4.woff2","/app/assets/inter-cyrillic-wght-normal-DqGufNeO.woff2","/app/assets/inter-greek-ext-wght-normal-DlzME5K_.woff2","/app/assets/inter-greek-wght-normal-CkhJZR-_.woff2","/app/assets/inter-latin-ext-wght-normal-DO1Apj_S.woff2","/app/assets/inter-latin-wght-normal-Dx4kXJAl.woff2","/app/assets/inter-vietnamese-wght-normal-CBcvBZtf.woff2","/app/assets/jetbrains-mono-cyrillic-wght-normal-D73BlboJ.woff2","/app/assets/jetbrains-mono-greek-wght-normal-Bw9x6K1M.woff2","/app/assets/jetbrains-mono-latin-ext-wght-normal-DBQx-q_a.woff2","/app/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2","/app/assets/jetbrains-mono-vietnamese-wght-normal-Bt-aOZkq.woff2","/app/assets/jspdf.es.min-Ckx-ZXfe.js","/app/assets/ocr.worker-CU1LH8SP.js","/app/assets/purify.es-Dqk5qvad.js","/app/assets/zxing_reader-EOacYbLr.wasm","/app/favicon.svg"]
/** The text reader's files (about 30 MB): kept once used or saved for offline, not with every app update. */
const OCR_ASSETS = ["/app/assets/ch_ppocr_mobile_v2.0_cls_infer-CZsrcDcs.onnx","/app/assets/ort-wasm-simd-threaded-qh98TCA_.wasm","/app/assets/ppocr_det-BNVJyGmD.onnx","/app/assets/rec_en_PP-OCRv3_infer-ihNOzo5x.onnx"]

// Keep these names in sync with offline.js
const SHELL = `repo-shell-${VERSION}`
const DATA = 'repo-offline-data'
const PHOTOS = 'repo-offline-photos'
const OCR = 'repo-ocr' // also in ocr/files.js
const SNAPSHOT_KEY = '/__offline__/snapshot.json'
const CHANGES_KEY = '/__offline__/changes.json'
const TOKENS_KEY = '/__offline__/tokens.json'
const FILES = '/__offline__/files/'
const INDEX = '/app/index.html'

/** Waiting longer than this for the server means it cannot be reached (e.g. the phone is on another network). */
const TIMEOUT = 4000
/** After a failure, answer from the copy at once for this long instead of waiting again. */
const OFFLINE_FOR = 20000

let offlineUntil = 0
/** The copy with the changes applied (a promise), read again when the page saves a new one or syncs. */
let state = null
/** The changes waiting on this phone (a promise of the list). */
let waiting = null
/** Whether the server answered the last check, while the phone stays on its copy. */
let serverUp = false
let checkedAt = 0

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
  // A new copy, or the changes were synced (offline.js, offlineSync.js)
  if (event.data === 'snapshot-changed' || event.data === 'changes-changed') {
    state = null
    waiting = null
  }
  // Whoever downloaded the copy: their token was given before this worker ran
  if (event.data?.type === 'token') event.waitUntil(rememberToken(event.data.token, event.data.user))
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Syncing and downloading talk to the server itself
  if (request.headers.has('X-Repo-Direct')) return
  const path = url.pathname
  if (request.method === 'POST' && path === '/api/auth/login') return event.respondWith(login(request))
  if (path.startsWith('/api/offline/') && path !== '/api/offline/snapshot') return event.respondWith(phoneApi(request, path))
  if (path === '/api/auth/me' || path === '/api/auth/logout') return event.respondWith(session(request, path))
  if (request.method !== 'GET') {
    if (path.startsWith('/api/')) event.respondWith(change(request, path))
    return
  }

  // Pages: the same ones Laravel answers with the app (routes/web.php)
  if (request.mode === 'navigate') {
    if (!/^\/(api|app|storage)\//.test(path)) event.respondWith(page(request))
    return
  }
  if (path.startsWith('/app/')) return event.respondWith(asset(request))
  if (/^\/api\/(equipment|issues)\/\d+\/photo$/.test(path)) return event.respondWith(photo(request))
  if (path.startsWith('/api/')) {
    const route = findRoute(url)
    if (route) return event.respondWith(data(request, route))
    // Anything else (history, stocktakes, settings pages...) is not in the copy
    event.respondWith(notInCopy(request))
  }
})

/**
 * The server's answer, or a rejection when it fails or takes too long. A change is called off
 * when it takes too long, so it is not saved twice (on the server, and on the phone to sync).
 */
function fromNetwork(request, { cancel = false } = {}) {
  const stop = cancel ? new AbortController() : null
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offlineUntil = Date.now() + OFFLINE_FOR
      stop?.abort()
      reject(new Error('timeout'))
    }, TIMEOUT)
    fetch(stop ? new Request(request, { signal: stop.signal }) : request).then(
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

/** A photo's URL changes with every new photo, so a saved one never goes stale (a problem report's photo never changes). */
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

/** The phone stays on its copy while it cannot reach the server, or has changes to sync. */
async function onCopy() {
  return isOffline() || (await loadChanges()).length > 0
}

async function data(request, route) {
  if (!(await onCopy())) {
    try {
      return await fromNetwork(request)
    } catch {
      /* answer from the saved copy */
    }
  }
  const copy = (await loadState())?.copy
  if (!copy) return json(503, { message: 'offline_no_data' })
  // The app only keeps a token it got by entering a PIN (online, or on this phone below)
  const { status, body } = route.answer(copy, request.headers.has('Authorization'))
  return json(status, body)
}

/**
 * A page the copy does not have (history, settings...). With changes waiting and a connection it
 * comes from the server, except for someone unlocked on the phone: the server does not know them.
 */
async function notInCopy(request) {
  if (!(await onCopy())) return fetch(request)
  if (isOffline()) return json(503, { message: 'offline_no_edit' })
  if (isPhoneToken(request)) return json(409, { message: 'offline_sync_first' })
  try {
    return marked(await fromNetwork(request))
  } catch {
    return json(503, { message: 'offline_no_edit' })
  }
}

/** A server's answer while the phone stays on its copy: the app still shows the copy's banner. */
async function marked(response) {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(copyHeaders())) headers.set(key, value)
  return new Response(response.status === 204 ? null : await response.blob(), { status: response.status, statusText: response.statusText, headers })
}

const bearer = (request) => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
/** A token from a PIN checked on this phone (see login below), not one from the server. */
const isPhoneToken = (request) => bearer(request).startsWith('offline.')

/* ---------- Changes kept on the phone */

/**
 * A change: to the server while it can be reached and nothing waits to be synced, otherwise kept
 * on the phone (when the copy can make it; anything else waits for the sync).
 */
async function change(request, path) {
  const offlineEdit = OfflineEdit.canChangeOffline(request.method, path)
  if (!(await onCopy())) {
    if (!offlineEdit) return fetch(request)
    const kept = request.clone()
    try {
      return await fromNetwork(request, { cancel: true })
    } catch {
      return keep(kept, path)
    }
  }
  if (!offlineEdit) {
    return (await loadChanges()).length ? json(409, { message: 'offline_sync_first' }) : json(503, { message: 'offline_no_edit' })
  }
  return keep(request, path)
}

/** One change at a time: each builds on the one before. */
let queue = Promise.resolve()
const inTurn = (work) => {
  const turn = queue.then(work)
  queue = turn.catch(() => {})
  return turn
}

/** The change applied to the copy and saved with the others, as the server would answer it. */
function keep(request, path) {
  return inTurn(async () => {
    const current = await loadState()
    if (!current) return json(503, { message: 'offline_no_data' })
    const user = (await readTokens())[bearer(request)]
    if (!user) return json(401, { message: 'Unauthenticated.' })

    const files = []
    const body = await readBody(request, files)
    const { model, changes } = current
    // A large delete asks for the PIN again, as the server does; the phone checks it
    const pin = String(body.pin ?? '')
    delete body.pin
    const count = OfflineEdit.deleteCount(model, request.method, path, body)
    if (count > OfflineEdit.LARGE_DELETE) {
      const refused = !pin ? 'pin_required:' + count : (await checkPin(user, pin))
      if (refused) {
        await dropFiles(files)
        return json(422, { message: refused, errors: { pin: [refused] } })
      }
    }

    const entry = {
      id: changes.reduce((max, c) => Math.max(max, c.id), 0) + 1,
      key: crypto.randomUUID(),
      at: OfflineEdit.laravelTime(Date.now()),
      user: { id: user.id, name: user.name },
      method: request.method,
      path,
      body,
    }
    const result = OfflineEdit.applyChange(model, entry)
    if (result.status >= 400) {
      // Refused, as the server would: nothing is kept
      await dropFiles(files)
      return json(result.status, result.body)
    }
    await savePhotos(entry, result)
    await saveChanges([...changes, entry])
    changes.push(entry)
    current.results.push(result)
    current.copy = openCopy(OfflineEdit.fromModel(model, OfflineEdit.notesFrom(changes, current.results, Date.now())))
    return json(result.status, pageAfter(current.copy, entry, result))
  })
}

/** The page a change answers with, as the copy now shows it (with what is not synced). */
function pageAfter(copy, entry, result) {
  const body = result.body
  const page = (path) => findRoute(new URL(path, self.location.origin))?.answer(copy, true).body ?? body
  const { method, path } = entry
  if (/^\/api\/equipment(\/\d+)?$/.test(path) && method !== 'DELETE') return page(`/api/equipment/${body.id}`)
  if (/^\/api\/groups(\/\d+)?$/.test(path) && method !== 'DELETE') return page(`/api/groups/${body.id}`)
  if (/^\/api\/boxes(\/\d+)?$/.test(path) && method !== 'DELETE') return page(`/api/boxes/${body.id}`)
  if (/^\/api\/boxes\/\d+\/equipment$/.test(path)) return { ...body, box: page(`/api/boxes/${body.box.id}`) }
  if (/^\/api\/boxes\/\d+\/equipment\//.test(path) && body?.id) return page(`/api/boxes/${body.id}`)
  return body
}

/** The body as sent (JSON or a form); files are kept on the phone and replaced by { file, size, type, name }. */
async function readBody(request, files) {
  const type = request.headers.get('Content-Type') || ''
  if (type.includes('multipart/form-data')) {
    const form = await request.formData()
    const body = {}
    const cache = await caches.open(DATA)
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') body[key] = value
      else {
        const file = crypto.randomUUID()
        await cache.put(FILES + file, new Response(value, { headers: { 'Content-Type': value.type || 'application/octet-stream' } }))
        files.push(file)
        body[key] = { file, size: value.size, type: value.type, name: value.name }
      }
    }
    return body
  }
  try {
    const body = JSON.parse((await request.text()) || '{}')
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

async function dropFiles(files) {
  const cache = await caches.open(DATA)
  for (const file of files) await cache.delete(FILES + file)
}

/** A photo taken on the phone shows at once: it goes where the pages look for photos. */
async function savePhotos(entry, result) {
  const photo = entry.body.photo
  if (!photo?.file) return
  const url = /\/photo$/.test(entry.path) ? result.body.photo_url : /\/issues$/.test(entry.path) ? OfflineEdit.localIssuePhotoUrl(result.body.id) : null
  if (!url) return
  const saved = await (await caches.open(DATA)).match(FILES + photo.file)
  if (saved) await (await caches.open(PHOTOS)).put(new URL(url, self.location.origin).href, saved)
}

/** The PIN of whoever is unlocked, checked against the copy; null when right, else the error. */
async function checkPin(user, pin) {
  if (Date.now() < pinsBlockedUntil) return 'too_many_attempts'
  const copy = (await loadState())?.copy
  const saved = copy?.data.users?.find((u) => u.id === user.id)
  if (saved && (await pinMatches(pin, saved.offline_pin))) {
    wrongPins = 0
    return null
  }
  if (++wrongPins >= PIN_TRIES) {
    wrongPins = 0
    pinsBlockedUntil = Date.now() + PIN_WAIT
  }
  return 'wrong_pin'
}

/**
 * The phone's own API, for the offline page and the sync:
 *   GET  /api/offline/status: { changes, server } (server: it answered the last check)
 *   GET  /api/offline/changes: the changes waiting, what each does and who made it
 *   POST /api/offline/changes/{id}/undo: undoes it and the later ones that need it ({ dry_run: true }: only lists them)
 */
async function phoneApi(request, path) {
  if (request.method === 'GET' && path === '/api/offline/status') {
    const changes = (await loadChanges()).length
    if (changes) await checkServer(true)
    return json(200, { changes, server: serverUp })
  }
  const current = await loadState()
  if (request.method === 'GET' && path === '/api/offline/changes') {
    if (!current) return json(200, [])
    return json(200, current.changes.map((c, i) => describe(c, current.results[i])))
  }
  const undo = request.method === 'POST' && /^\/api\/offline\/changes\/(\d+)\/undo$/.exec(path)
  if (undo && current) {
    const { dry_run: dryRun } = await readBody(request, [])
    return inTurn(async () => {
      const ids = OfflineEdit.undoPlan(current.saved, current.changes, Number(undo[1]))
      const undone = current.changes.filter((c) => ids.includes(c.id))
      if (!undone.length) return json(404, { message: 'not_found' })
      if (dryRun) return json(200, undone.map((c) => describe(c, current.results[current.changes.indexOf(c)])))
      await saveChanges(current.changes.filter((c) => !ids.includes(c.id)))
      await dropFiles(undone.flatMap((c) => Object.values(c.body).filter((v) => v?.file).map((v) => v.file)))
      state = null
      waiting = null
      return json(200, { undone: ids })
    })
  }
  return json(404, { message: 'not_found' })
}

const describe = (change, result) => ({ id: change.id, at: change.at, user: change.user?.name ?? null, ...(result?.effect || {}), failed: !result || result.status >= 400 })

/** While changes wait, whether the server can be reached (so the app offers to sync). */
async function checkServer(now = false) {
  if (!now && Date.now() - checkedAt < 15000) return serverUp
  checkedAt = Date.now()
  try {
    const response = await fromNetwork(new Request('/api/network/ping', { cache: 'no-store' }))
    serverUp = response.ok
  } catch {
    serverUp = false
  }
  return serverUp
}

/**
 * Who is unlocked: while the phone stays on its copy, from the tokens this phone saw (a token
 * from the phone's own PIN check means nothing to the server).
 */
async function session(request, path) {
  if (!(await onCopy())) {
    if (path === '/api/auth/me') {
      const response = await fetch(request)
      if (response.ok) await rememberToken(bearer(request), (await response.clone().json()).user ?? null)
      return response
    }
    return fetch(request)
  }
  const tokens = await readTokens()
  const token = bearer(request)
  if (path === '/api/auth/logout') {
    await rememberToken(token, null)
    return new Response(null, { status: 204, headers: copyHeaders() })
  }
  return tokens[token] ? json(200, { user: tokens[token] }) : json(401, { message: 'Unauthenticated.' })
}

async function readTokens() {
  return (await readJson(TOKENS_KEY)) || {}
}

/** Who each token belongs to: a change kept on the phone is saved with their name. */
async function rememberToken(token, user) {
  if (!token) return
  const tokens = await readTokens()
  if (user) tokens[token] = { id: user.id, name: user.name, role: user.role }
  else delete tokens[token]
  await writeJson(TOKENS_KEY, tokens)
}

async function readJson(key) {
  try {
    const response = await (await caches.open(DATA)).match(key)
    return response ? await response.json() : null
  } catch {
    return null
  }
}

async function writeJson(key, value) {
  await (await caches.open(DATA)).put(key, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))
}

function loadChanges() {
  waiting ||= readJson(CHANGES_KEY).then((saved) => {
    const changes = saved?.changes || []
    waitingCount = changes.length
    return changes
  })
  return waiting
}

async function saveChanges(changes) {
  await writeJson(CHANGES_KEY, { changes })
  waiting = Promise.resolve(changes)
  waitingCount = changes.length
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
  if (!(await onCopy())) {
    try {
      const response = await fromNetwork(request)
      if (response.ok) {
        const { token, user } = await response.clone().json()
        await rememberToken(token, user)
      }
      return response
    } catch {
      /* check the PIN on the phone */
    }
  }
  const copy = (await loadState())?.copy
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
  const token = `offline.${crypto.randomUUID()}`
  await rememberToken(token, user)
  return json(200, { token, user })
}

/** A validation error as Laravel sends it. */
const pinError = (message) => json(422, { message, errors: { pin: [message] } })

/**
 * What the app reads on every answer from the copy: X-Repo-Offline (the banner), X-Repo-Changes
 * (how many wait to be synced) and X-Repo-Server (whether the server answered the last check).
 */
function copyHeaders() {
  const changes = waitingCount
  if (changes) checkServer()
  return { 'X-Repo-Offline': '1', 'X-Repo-Changes': String(changes), 'X-Repo-Server': serverUp && !isOffline() ? '1' : '0' }
}

/** Kept with each read of the changes, for copyHeaders. */
let waitingCount = 0

function json(status, body) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...copyHeaders() },
  })
}

function loadState() {
  state ||= readState().then((copy) => {
    if (!copy) state = null // nothing saved yet: look again next time
    return copy
  })
  return state
}

/** The saved copy, the changes made since, and the copy with them applied. */
async function readState() {
  const saved = await readJson(SNAPSHOT_KEY)
  if (!saved) return null
  const changes = [...(await loadChanges())]
  const { model, results, data } = OfflineEdit.applyAll(saved, changes)
  return { saved, changes, model, results, copy: openCopy(data) }
}

/*
 * The copy of the system a phone keeps for working without a connection (downloaded on the
 * "Work offline" page from /api/offline/snapshot), and the answers given from it: the same JSON
 * the server's API returns, so the pages work unchanged.
 *
 * The service worker (sw.js) includes this file when the app is built (see vite.config.js), so
 * it uses no browser-only APIs and no imports; it also runs in Node to compare with the server.
 */

/* ---------- Text as the database compares it (MariaDB / MySQL, utf8mb4_unicode_ci) */

const SPACE = 'ȉ'
/** Between characters' weights in a LIKE search (no weight is this low). */
const SEP = '\u0001'

let weights = null

/** The weight table at the end of this file, read once: code point => weights (one character per 16-bit weight). */
function weightTable() {
  if (weights) return weights
  weights = new Map()
  for (const run of WEIGHTS.split(';')) {
    const [start, list] = run.split(':')
    list.split('|').forEach((hex, i) => {
      let w = ''
      for (let j = 0; j < hex.length; j += 4) w += String.fromCharCode(Number.parseInt(hex.slice(j, j + 4), 16))
      weights.set(Number.parseInt(start, 16) + i, w)
    })
  }
  return weights
}

/** A character the table does not list gets the collation's implicit weight; beyond the BMP they all weigh as one. */
function weightOf(codePoint) {
  const w = weightTable().get(codePoint)
  if (w !== undefined) return w
  if (codePoint > 0xffff) return '�'
  return String.fromCharCode(0xfbc0 + (codePoint >> 15), (codePoint & 0x7fff) | 0x8000)
}

const weighed = new Map()

/** A text's sort key (all its weights) and its characters' weights for LIKE, kept since texts repeat. */
function weigh(text) {
  const s = String(text)
  let entry = weighed.get(s)
  if (!entry) {
    const chars = Array.from(s, (ch) => weightOf(ch.codePointAt(0)))
    entry = { key: chars.join(''), chars: SEP + chars.join(SEP) + SEP }
    if (weighed.size > 50000) weighed.clear()
    weighed.set(s, entry)
  }
  return entry
}

/**
 * The database's order of two texts. Case, accents and Arabic diacritics do not count (a = Á,
 * ١ = 1, مُحَمَّد = محمد), but أ and ا are different letters. The shorter text counts as padded
 * with spaces, so trailing spaces do not count either.
 */
function compareText(a, b) {
  const x = weigh(a).key
  const y = weigh(b).key
  if (x === y) return 0
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x.charCodeAt(i) - y.charCodeAt(i)
  const [rest, sign] = x.length > n ? [x, 1] : [y, -1]
  for (let i = n; i < rest.length; i++) if (rest[i] !== SPACE) return (rest.charCodeAt(i) - SPACE.charCodeAt(0)) * sign
  return 0
}

/** `=`; null never equals anything. */
const same = (a, b) => a != null && b != null && compareText(a, b) === 0

/** Texts that `=` finds equal share this key (what GROUP BY and DISTINCT merge). */
const groupKey = (text) => weigh(text).key.replace(/ȉ+$/, '')

/** What `like '%q%'` looks for; it compares character by character, so a diacritic in between stops a match. */
const pattern = (q) => weigh(q).chars
const has = (value, wanted) => value != null && weigh(value).chars.includes(wanted)

/** The database's order: null before any value. */
function compareValues(a, b) {
  if (a == null || b == null) return (a == null ? 0 : 1) - (b == null ? 0 : 1)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return compareText(a, b)
}

const byText = (key) => (a, b) => compareValues(a[key], b[key])

/** PHP's natural order (SORT_NATURAL): numbers by their value, the rest character by character. */
function naturalCompare(a, b) {
  const parts = (text) => String(text).match(/\d+|\D+/g) || []
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (/^\d/.test(x[i]) && /^\d/.test(y[i])) {
      const [p, q] = [x[i].replace(/^0+(?=\d)/, ''), y[i].replace(/^0+(?=\d)/, '')]
      if (p.length !== q.length) return p.length - q.length
      if (p !== q) return p < q ? -1 : 1
      continue
    }
    return x[i] < y[i] ? -1 : 1
  }
  return x.length - y.length
}

/** Laravel's $request->boolean(). */
const isTrue = (value) => ['1', 'true', 'on', 'yes'].includes(String(value ?? '').toLowerCase())
/** Laravel's $request->filled(). */
const filled = (value) => value != null && String(value).trim() !== ''

/* ---------- Equipment list (EquipmentController::listQuery) */

/** EquipmentFilters::CATEGORY_KEY */
const CATEGORY_KEY = '__category__'

function parseFilters(raw) {
  try {
    const filters = JSON.parse(raw || '[]')
    return Array.isArray(filters) ? filters.slice(0, 20) : []
  } catch {
    return []
  }
}

/** One field filter of EquipmentFilters::apply(); an empty value means "has this field". */
function passesFilter(e, filter) {
  const key = filter?.key == null ? '' : String(filter.key)
  const value = filter?.value == null ? '' : String(filter.value)
  if (key === '') return true
  if (key === CATEGORY_KEY) {
    if (value === '__none__') return e.category == null
    return value === '' ? e.category != null : same(e.category, value)
  }
  return e.fields.some((f) => same(f.key, key) && (value === '' || same(f.value, value)))
}

function matchesSearch(e, needle) {
  return (
    has(e.serial_number, needle) ||
    has(e.name, needle) ||
    has(e.category, needle) ||
    has(e.group?.name, needle) ||
    e.fields.some((f) => has(f.value, needle) || has(f.key, needle))
  )
}

const SORTS = ['serial_number', 'row_no', 'category', 'created_at', 'updated_at']

/** The equipment the list shows for these query parameters, in its order. */
function listEquipment(copy, query) {
  const q = (query.get('q') || '').trim()
  const needle = pattern(q)
  const category = query.get('category')
  const importId = query.get('import_id')
  const groupId = query.get('group_id')
  const ungrouped = isTrue(query.get('ungrouped'))
  const filters = parseFilters(query.get('filters'))
  const type = query.get('type')

  const rows = copy.data.equipment.filter((e) => {
    if (q !== '' && !matchesSearch(e, needle)) return false
    if (filled(category) && (category === '__none__' ? e.category != null : !same(e.category, category))) return false
    if (filled(importId) && Number(e.import?.id) !== Number(importId)) return false
    if (filled(groupId) && Number(e.group?.id) !== Number(groupId)) return false
    // Grouped list: what is not in a group. Accessories of grouped equipment only show when searched for
    if (ungrouped && (e.group || (q === '' && e.parent && copy.equipment.get(e.parent.id)?.group))) return false
    if (!filters.every((filter) => passesFilter(e, filter))) return false
    if (type === 'main' && e.parent) return false
    if (type === 'accessory' && !e.parent) return false
    return true
  })

  const sort = SORTS.includes(query.get('sort')) ? query.get('sort') : 'updated_at'
  const asc = query.get('dir') === 'asc'
  return rows.sort((a, b) => {
    // Equipment without a «ت» number goes last in both directions
    if (sort === 'row_no' && (a.row_no == null) !== (b.row_no == null)) return a.row_no == null ? 1 : -1
    const order = compareValues(a[sort], b[sort])
    return (asc ? order : -order) || a.id - b.id
  })
}

const listItem = (e) => ({
  id: e.id,
  serial_number: e.serial_number,
  name: e.name,
  display_name: e.display_name,
  row_no: e.row_no,
  category: e.category,
  parent: e.parent ? { id: e.parent.id, serial_number: e.parent.serial_number, name: e.parent.name } : null,
  group: e.group,
  accessories_count: e.accessories.length,
  fields: e.fields,
  updated_at: e.updated_at,
  ...offlineMark(e),
})

/** Changed on this phone and not synced yet ('new' or 'changed', see offlineEdit.js). */
const offlineMark = (item) => (item.offline ? { offline: item.offline } : {})

/** Laravel's paginate() as JSON (without the page links, which no page reads). */
function paginate(items, query, path) {
  const perPage = Math.min(200, Math.max(5, Number.parseInt(query.get('per_page') ?? '20', 10) || 0))
  const asked = Number.parseInt(query.get('page') ?? '1', 10)
  const page = Number.isInteger(asked) && asked >= 1 ? asked : 1
  const lastPage = Math.max(1, Math.ceil(items.length / perPage))
  const data = items.slice((page - 1) * perPage, page * perPage)
  const pageUrl = (n) => `${path}?page=${n}`
  return {
    current_page: page,
    data,
    first_page_url: pageUrl(1),
    from: data.length ? (page - 1) * perPage + 1 : null,
    last_page: lastPage,
    last_page_url: pageUrl(lastPage),
    links: [],
    next_page_url: page < lastPage ? pageUrl(page + 1) : null,
    path,
    per_page: perPage,
    prev_page_url: page > 1 ? pageUrl(page - 1) : null,
    to: data.length ? (page - 1) * perPage + data.length : null,
    total: items.length,
  }
}

/** Groups with how many equipment of the list (same search and filters) they hold. */
function groupSummary(copy, query) {
  const counts = new Map()
  for (const e of listEquipment(copy, query)) if (e.group) counts.set(e.group.id, (counts.get(e.group.id) || 0) + 1)
  return sortedGroups(copy)
    .filter((g) => counts.has(g.id))
    .map((g) => ({ ...g, count: counts.get(g.id) }))
}

/**
 * Grouped like GROUP BY (equal as the column compares; the first spelling seen), most used first.
 * Equally used ones stay in the order first seen; the database orders them by where its rows are
 * stored, which the copy does not know.
 */
function countBy(values) {
  const groups = new Map()
  for (const value of values) {
    const key = groupKey(value)
    const group = groups.get(key)
    if (group) group.uses++
    else groups.set(key, { value, uses: 1 })
  }
  return [...groups.values()].sort((a, b) => b.uses - a.uses)
}

const allFields = (copy) => copy.data.equipment.flatMap((e) => e.fields)

/** Field names, most used first (EquipmentController::keys). */
const fieldKeys = (copy) =>
  countBy(allFields(copy).map((f) => f.key))
    .slice(0, 500)
    .map((k) => k.value)

/** Values stored for one field, or for the category, most used first (EquipmentController::values). */
function fieldValues(copy, query) {
  const key = query.get('key') || ''
  if (key === CATEGORY_KEY) return countBy(copy.data.equipment.map((e) => e.category).filter((c) => c != null))
  const values = allFields(copy)
    .filter((f) => same(f.key, key) && f.value != null && f.value.trimEnd() !== '')
    .map((f) => f.value)
  return countBy(values).slice(0, 300)
}

const categories = (copy) =>
  countBy(copy.data.equipment.map((e) => e.category).filter((c) => c != null))
    .map((c) => c.value)
    .sort(compareText)

/* ---------- Groups and boxes */

const sortedGroups = (copy) => [...(copy.data.groups || [])].sort(byText('name'))
const groupOf = (e) => e.group?.id

function groupList(copy, query) {
  const q = (query.get('q') || '').trim()
  return sortedGroups(copy)
    .filter((g) => q === '' || has(g.name, pattern(q)))
    .map((g) => ({ ...g, equipment_count: copy.data.equipment.filter((e) => groupOf(e) === g.id).length }))
}

function groupPage(copy, id) {
  const group = copy.data.groups?.find((g) => g.id === id)
  if (!group) return undefined
  const units = copy.data.equipment
    .filter((e) => groupOf(e) === id)
    .sort((a, b) => compareValues(a.row_no, b.row_no) || compareValues(a.serial_number, b.serial_number))
  return {
    id: group.id,
    name: group.name,
    voucher_code: group.voucher_code,
    voucher_name: group.voucher_name,
    equipment: units.map((e) => ({
      id: e.id,
      serial_number: e.serial_number,
      display_name: e.display_name,
      row_no: e.row_no,
      category: e.category,
      accessories_count: e.accessories.length,
      photo_url: e.photo_url,
      ...offlineMark(e),
    })),
  }
}

function boxList(copy, query) {
  const q = (query.get('q') || '').trim()
  return copy.data.boxes
    .filter((b) => q === '' || has(b.number, pattern(q)) || has(b.name, pattern(q)))
    .sort((a, b) => naturalCompare(a.number, b.number))
    .map((b) => ({ id: b.id, number: b.number, name: b.name, weight: b.weight, equipment_count: b.equipment.length, updated_at: b.updated_at, ...offlineMark(b) }))
}

/* ---------- Dashboard, vouchers, scan documents: the server's own answers */

/** What the dashboard shows only to someone who entered a PIN (EquipmentController::stats). */
function stats(copy, authed) {
  const saved = copy.data.stats
  if (!saved || authed) return saved
  return { ...saved, recent_activity: null, activity_by_day: null, recent_imports: saved.recent_imports.map((i) => ({ ...i, user: null })) }
}

const VOUCHER_STATUSES = ['draft', 'issued', 'returned']
/** VoucherController::LIST_LIMIT */
const VOUCHER_LIMIT = 300

function voucherList(copy, query) {
  const vouchers = copy.data.vouchers?.list || []
  const status = query.get('status')
  const q = (query.get('q') || '').trim()
  const listed = vouchers
    .filter((v) => !VOUCHER_STATUSES.includes(status) || v.status === status)
    .filter((v) => q === '' || has(v.recipient, pattern(q)) || (/^\d+$/.test(q) && v.number === Number(q)))
    .slice(0, VOUCHER_LIMIT)
  const counts = {}
  for (const v of vouchers) counts[v.status] = (counts[v.status] || 0) + 1
  return { vouchers: listed, counts, next_number: copy.data.vouchers?.next_number ?? 1 }
}

const voucherPage = (copy, id) => copy.data.vouchers?.pages?.[id]
const folderPage = (copy, id) => copy.data.scan?.folder_pages?.[id]
const scanDocument = (copy, id) => copy.data.scan?.documents?.[id]
const revision = (value) => (value === undefined ? undefined : { revision: value })

/* ---------- Scanned codes that are not the system's labels (LookupController) */

/** At most this many equipment and this many boxes; shorter codes are only looked up exactly. Same as the server. */
const LOOKUP_LIMIT = 30
const MIN_CONTAINS = 3

/**
 * What a scanned code belongs to (a maker's Data Matrix...): equipment whose serial number or any
 * field is the code, and boxes whose number or name is; only when there are none, those that contain it.
 */
function lookup(copy, raw) {
  const code = raw.trim()
  if (!code) return { code: '', matches: [] }
  let matches = findCode(copy, code, true)
  if (!matches.length && [...code].length >= MIN_CONTAINS) matches = findCode(copy, code, false)
  return { code, matches }
}

function findCode(copy, code, exact) {
  const wanted = pattern(code)
  // The database picks what matches...
  const picks = (value) => (exact ? same(value, code) : has(value, wanted))
  // ...and the server then tells which value it was with PHP's plain lower case
  const lower = code.toLowerCase()
  const matched = (value) => value != null && (exact ? value.trimEnd().toLowerCase() === lower : value.toLowerCase().includes(lower))

  const found = copy.mainFirst
    .filter((e) => picks(e.serial_number) || e.fields.some((f) => picks(f.value)))
    .slice(0, LOOKUP_LIMIT)
    .map((e) => {
      const field = e.fields.find((f) => matched(f.value))
      return {
        type: 'equipment',
        id: e.id,
        serial_number: e.serial_number,
        display_name: e.display_name,
        category: e.category,
        parent: e.parent,
        photo_url: e.photo_url,
        match: matched(e.serial_number) || !field ? { by: 'serial', key: null } : { by: 'field', key: field.key },
      }
    })
  const boxes = copy.data.boxes
    .filter((b) => picks(b.number) || picks(b.name))
    .slice(0, LOOKUP_LIMIT)
    .map((b) => ({ type: 'box', id: b.id, number: b.number, name: b.name, match: { by: matched(b.number) ? 'number' : 'name', key: null } }))
  return [...found, ...boxes]
}

/* ---------- The copy and its routes */

/** The downloaded snapshot with the lookups the answers need. */
function openCopy(data) {
  const equipment = new Map(data.equipment.map((e) => [e.id, e]))
  // A serial or box number is found as the database compares it
  const serials = new Map(Object.entries(data.serials))
  const looseSerials = new Map()
  for (const [serial, id] of serials) if (!looseSerials.has(groupKey(serial))) looseSerials.set(groupKey(serial), id)
  const boxes = new Map(data.boxes.map((b) => [b.id, b]))
  const boxNumbers = new Map()
  for (const box of data.boxes) if (!boxNumbers.has(groupKey(box.number))) boxNumbers.set(groupKey(box.number), box)

  return {
    data,
    equipment,
    boxes,
    // Main equipment before accessories, as a scanned label does
    mainFirst: [...data.equipment].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0) || a.id - b.id),
    equipmentBySerial: (serial) => equipment.get(serials.get(serial) ?? looseSerials.get(groupKey(serial))),
    boxByNumber: (number) => boxNumbers.get(groupKey(number)),
  }
}

const decode = (part) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * The GET requests answered from the copy. Handlers get the copy, the parts of the path in
 * brackets, the query and whether a PIN was entered; undefined means "not found".
 * `pin`: the server only answers someone who entered a PIN.
 */
const ROUTES = [
  [/^\/api\/settings$/, (copy) => copy.data.settings],
  [/^\/api\/stats$/, (copy, query, authed) => stats(copy, authed)],
  [/^\/api\/equipment$/, (copy, query) => paginate(listEquipment(copy, query).map(listItem), query, '/api/equipment')],
  [/^\/api\/equipment\/group-summary$/, (copy, query) => groupSummary(copy, query)],
  [/^\/api\/equipment\/keys$/, (copy) => fieldKeys(copy)],
  [/^\/api\/equipment\/values$/, (copy, query) => fieldValues(copy, query)],
  [/^\/api\/equipment\/categories$/, (copy) => categories(copy)],
  [/^\/api\/equipment\/serial-list$/, (copy) => ({ serials: Object.keys(copy.data.serials) })],
  [/^\/api\/equipment\/serial\/(.+)$/, (copy, query, authed, serial) => copy.equipmentBySerial(decode(serial))],
  [/^\/api\/equipment\/(\d+)$/, (copy, query, authed, id) => copy.equipment.get(Number(id))],
  [/^\/api\/equipment\/(\d+)\/maintenance$/, (copy, query, authed, id) => (copy.equipment.has(Number(id)) ? copy.data.maintenance[id] || { schedules: [], records: [] } : undefined)],
  [/^\/api\/equipment\/(\d+)\/issues$/, (copy, query, authed, id) => (copy.equipment.has(Number(id)) ? copy.data.issues[id] || [] : undefined)],
  [/^\/api\/groups$/, (copy, query) => groupList(copy, query)],
  [/^\/api\/groups\/(\d+)$/, (copy, query, authed, id) => groupPage(copy, Number(id))],
  [/^\/api\/boxes$/, (copy, query) => boxList(copy, query)],
  [/^\/api\/boxes\/number\/(.+)$/, (copy, query, authed, number) => copy.boxByNumber(decode(number))],
  [/^\/api\/boxes\/(\d+)$/, (copy, query, authed, id) => copy.boxes.get(Number(id))],
  [/^\/api\/lookup$/, (copy, query) => lookup(copy, query.get('code') || '')],
  [/^\/api\/scan-folders$/, (copy) => copy.data.scan?.folders],
  [/^\/api\/scan-folders\/revision$/, (copy) => revision(copy.data.scan?.revision)],
  [/^\/api\/scan-folders\/(\d+)$/, (copy, query, authed, id) => folderPage(copy, id)],
  [/^\/api\/scan-folders\/(\d+)\/revision$/, (copy, query, authed, id) => revision(copy.data.scan?.folder_revisions?.[id])],
  [/^\/api\/scan-documents\/(\d+)$/, (copy, query, authed, id) => scanDocument(copy, id)],
  [/^\/api\/scan-documents\/(\d+)\/revision$/, (copy, query, authed, id) => revision(scanDocument(copy, id)?.document.revision)],
  [/^\/api\/vouchers$/, (copy, query) => voucherList(copy, query), 'pin'],
  [/^\/api\/vouchers\/recipients$/, (copy) => copy.data.vouchers?.recipients || [], 'pin'],
  [/^\/api\/vouchers\/(\d+)$/, (copy, query, authed, id) => voucherPage(copy, id), 'pin'],
  [/^\/api\/vouchers\/(\d+)\/revision$/, (copy, query, authed, id) => revision(voucherPage(copy, id)?.voucher.revision), 'pin'],
  [/^\/api\/voucher-templates$/, (copy) => copy.data.vouchers?.templates || [], 'pin'],
]

/**
 * The route answering this GET from the copy, or null when the copy cannot answer it.
 * `answer(copy, authed)` gives { status, body }.
 */
function findRoute(url) {
  for (const [pattern, handler, access] of ROUTES) {
    const match = url.pathname.match(pattern)
    if (!match) continue
    return {
      answer(copy, authed) {
        if (access === 'pin' && !authed) return { status: 401, body: { message: 'Unauthenticated.' } }
        const body = handler(copy, url.searchParams, authed, ...match.slice(1))
        return body === undefined ? { status: 404, body: { message: 'not_found' } } : { status: 200, body }
      },
    }
  }
  return null
}

/* ---------- Unlocking with a PIN (App\Support\OfflinePin) */

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

async function pinMatches(pin, hash) {
  const [kind, iterations, salt, expected] = String(hash || '').split('$')
  if (kind !== 'pbkdf2_sha256' || !(Number(iterations) >= 1) || !salt || !expected) return false
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations: Number(iterations) }, key, 256))
    const wanted = fromBase64(expected)
    return bits.length === wanted.length && bits.every((byte, i) => byte === wanted[i])
  } catch {
    return false
  }
}

/** The user whose PIN this is, as AuthController::login answers ({ id, name, role }), or null. */
async function findUserByPin(users, pin) {
  for (const user of users || []) {
    if (await pinMatches(pin, user.offline_pin)) return { id: user.id, name: user.name, role: user.role }
  }
  return null
}

/* ---------- The collation's weights */

/*
 * utf8mb4_unicode_ci's weight for each character of Latin, Arabic (with presentation forms),
 * digits and punctuation, as MariaDB gives it:
 *   select seq, hex(weight_string(convert(char(seq using utf32) using utf8mb4) collate utf8mb4_unicode_ci))
 *   from seq_0_to_65535 where seq in (9, 10, 13) or seq between 32 and 126 or seq between 160 and 591
 *     or seq between 768 and 879 or seq between 1536 and 1791 or seq between 1872 and 1919
 *     or seq between 2208 and 2303 or seq between 7680 and 7935 or seq between 8192 and 8303
 *     or seq between 64336 and 65023 or seq between 65136 and 65279 or seq between 65281 and 65374;
 * Runs of `first code point (hex):weights|weights|...` separated by `;`, 4 hex digits per weight;
 * an empty entry is a character that does not count (a diacritic).
 */
const WEIGHTS =
  '9:0201|0202;d:0205;20:0209|0251|027E|02D2|0E0F|02D3|02CF|0277|0288|0289|02C8|0428|022F|0221|025D|02CC|0E29|0E2A|0E2B|0E2C|0E2D|0E2E|0E2F|0E30|0E31|0E32|023D|023A|042C|042D|042E|0255|02C7|0E33|0E4A|0E60|0E6D|0E8B|0EB9|0EC1|0EE1|0EFB|0F10|0F21|0F2E|0F5B|0F64|0F82|0FA7|0FB4|0FC0|0FEA|1002|101F|1044|1051|105A|105E|106A|028A|02CE|028B|020F|021B|020C|0E33|0E4A|0E60|0E6D|0E8B|0EB9|0EC1|0EE1|0EFB|0F10|0F21|0F2E|0F5B|0F64|0F82|0FA7|0FB4|0FC0|0FEA|1002|101F|1044|1051|105A|105E|106A|028C|0430|028D|0433;a0:0209|0252|0E0E|0E10|0E0D|0E11|0431|02C2|0214|02C5|0E33|0286|042F|0220|02C6|0210|034A|0429|0E2B|0E2C|020D|10F8|02C3|0267|0219|0E2A|0F82|0287|0E2A02CD0E2D|0E2A02CD0E2B|0E2C02CD0E2D|0256|0E33|0E33|0E33|0E33|0E33|0E33|0E38|0E60|0E8B|0E8B|0E8B|0E8B|0EFB|0EFB|0EFB|0EFB|0E86|0F64|0F82|0F82|0F82|0F82|0F82|042B|0F8D|101F|101F|101F|101F|105E|1094|0FEA0FEA|0E33|0E33|0E33|0E33|0E33|0E33|0E38|0E60|0E8B|0E8B|0E8B|0E8B|0EFB|0EFB|0EFB|0EFB|0E86|0F64|0F82|0F82|0F82|0F82|0F82|042A|0F8D|101F|101F|101F|101F|105E|1094|105E|0E33|0E33|0E33|0E33|0E33|0E33|0E60|0E60|0E60|0E60|0E60|0E60|0E60|0E60|0E6D|0E6D|0E72|0E72|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0EC1|0EC1|0EC1|0EC1|0EC1|0EC1|0EC1|0EC1|0EE1|0EE1|0EED|0EED|0EFB|0EFB|0EFB|0EFB|0EFB|0EFB|0EFB|0EFB|0EFB|0EFF|0EFB0F10|0EFB0F10|0F10|0F10|0F21|0F21|0FBC|0F2E|0F2E|0F2E|0F2E|0F2E|0F2E|0F2E0267|0F2E0267|0F36|0F36|0F64|0F64|0F64|0F64|0F64|0F64|10B10F64|0F7E|0F7E|0F82|0F82|0F82|0F82|0F82|0F82|0F820E8B|0F820E8B|0FC0|0FC0|0FC0|0FC0|0FC0|0FC0|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|1002|1002|1002|1002|1007|1007|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|1051|1051|105E|105E|105E|106A|106A|106A|106A|106A|106A|0FEA|0E52|0E58|0E5C|0E5C|10A8|10A8|0F92|0E65|0E65|0E76|0E7A|0E7E|0E7E|106A1051|0E90|0E94|0E98|0EBD|0EBD|0ED1|0ED9|0EE9|0F0C|0F08|0F26|0F26|0F3B|0F53|1037|0F6E|0F72|0F9A|0F82|0F82|0EDD|0EDD|0FAC|0FAC|0FC4|10A0|10A0|0FF2|0FF6|100B|100F|100F|1013|101F|101F|1040|1049|1066|1066|106F|106F|107F|1084|1084|1088|109C|10A4|10A4|10020FEA|1098|10C8|10CC|10D0|10D4|0E6D106A|0E6D106A|0E6D106A|0F2E0F10|0F2E0F10|0F2E0F10|0F640F10|0F640F10|0F640F10|0E33|0E33|0EFB|0EFB|0F82|0F82|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|0E90|0E33|0E33|0E33|0E33|0E38|0E38|0ECD|0ECD|0EC1|0EC1|0F21|0F21|0F82|0F82|0F82|0F82|107F|107F|0F10|0E6D106A|0E6D106A|0E6D106A|0EC1|0EC1|0EE9|1098|0F64|0F64|0E33|0E33|0E38|0E38|0F8D|0F8D|0E33|0E33|0E33|0E33|0E8B|0E8B|0E8B|0E8B|0EFB|0EFB|0EFB|0EFB|0F82|0F82|0F82|0F82|0FC0|0FC0|0FC0|0FC0|101F|101F|101F|101F|0FEA|0FEA|1002|1002|1090|1090|0EE1|0EE1|0F72|0E82|0FA2|0FA2|1073|1073|0E33|0E33|0E8B|0E8B|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|105E|105E|0F4B|0F7A|1017|FBC08237|FBC08238|FBC08239|FBC0823A|FBC0823B|FBC0823C|FBC0823D|FBC0823E|FBC0823F|FBC08240|FBC08241|FBC08242|FBC08243|FBC08244|FBC08245|FBC08246|FBC08247|FBC08248|FBC08249|FBC0824A|FBC0824B|FBC0824C|FBC0824D|FBC0824E|FBC0824F;300:||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||||FBC08358|FBC08359|FBC0835A|FBC0835B|FBC0835C|||||||0E33|0E8B|0EFB|0F82|101F|0E60|0E6D|0EE1|0F5B|0FC0|1002|1044|105A;600:||||FBC08604|FBC08605|FBC08606|FBC08607|FBC08608|FBC08609|FBC0860A|FBC0860B|0231|0232|034C|034D|||||||FBC08616|FBC08617|FBC08618|FBC08619|FBC0861A|023B|FBC0861C|FBC0861D|FBC0861E|0258|FBC08620|1347|1348|1349|134C|134D|134F|1350|1352|1356|1357|1358|135E|1364|1365|1369|136A|1375|1376|1381|1382|1387|1388|138C|138D|138F|1390|FBC0863B|FBC0863C|FBC0863D|FBC0863E|FBC0863F|020B|1393|139B|139E|13AB|13B0|13B1|13B7|13BD|13C7|13C8|||||||||||||||FBC08659|FBC0865A|FBC0865B|FBC0865C|FBC0865D|FBC0865E|FBC0865F|0E29|0E2A|0E2B|0E2C|0E2D|0E2E|0E2F|0E30|0E31|0E32|02D4|0233|0234|02CB|1351|139A||134B|134A|134E|1347|13501347|13BD1347|13C11347|13C81347|1359|135A|1353|135B|135C|1354|135D|1355|1366|1367|135F|1360|1368|1361|1363|136B|136C|136D|136E|136F|1370|1371|1372|1373|1377|1378|1379|137A|137B|137C|137D|137E|137F|1383|1384|1385|1389|138A|138E|1391|1394|1395|1396|1397|1398|1399|139C|139D|139F|13A0|13A1|13A2|13A3|13A4|13A5|13A6|13A7|13A8|13A9|13AA|13AC|13AD|13AE|13AF|13B6|13B2|13B3|13B4|13B5|13B8|1362|13BC|13B9|13B9|13BA|13BE|13BF|13C0|13C1|13C2|13C3|13C4|13C5|13C9|13CA|13CB|13C6|13CC|13CD|13CE|13CE|025F|13BC||||||||||||||||13BD|13C8|||034E|||||1374|1380|0E29|0E2A|0E2B|0E2C|0E2D|0E2E|0E2F|0E30|0E31|0E32|1386|138B|1392|1347|13B0|13BB;750:FBC08750|FBC08751|FBC08752|FBC08753|FBC08754|FBC08755|FBC08756|FBC08757|FBC08758|FBC08759|FBC0875A|FBC0875B|FBC0875C|FBC0875D|FBC0875E|FBC0875F|FBC08760|FBC08761|FBC08762|FBC08763|FBC08764|FBC08765|FBC08766|FBC08767|FBC08768|FBC08769|FBC0876A|FBC0876B|FBC0876C|FBC0876D|FBC0876E|FBC0876F|FBC08770|FBC08771|FBC08772|FBC08773|FBC08774|FBC08775|FBC08776|FBC08777|FBC08778|FBC08779|FBC0877A|FBC0877B|FBC0877C|FBC0877D|FBC0877E|FBC0877F;8a0:FBC088A0|FBC088A1|FBC088A2|FBC088A3|FBC088A4|FBC088A5|FBC088A6|FBC088A7|FBC088A8|FBC088A9|FBC088AA|FBC088AB|FBC088AC|FBC088AD|FBC088AE|FBC088AF|FBC088B0|FBC088B1|FBC088B2|FBC088B3|FBC088B4|FBC088B5|FBC088B6|FBC088B7|FBC088B8|FBC088B9|FBC088BA|FBC088BB|FBC088BC|FBC088BD|FBC088BE|FBC088BF|FBC088C0|FBC088C1|FBC088C2|FBC088C3|FBC088C4|FBC088C5|FBC088C6|FBC088C7|FBC088C8|FBC088C9|FBC088CA|FBC088CB|FBC088CC|FBC088CD|FBC088CE|FBC088CF|FBC088D0|FBC088D1|FBC088D2|FBC088D3|FBC088D4|FBC088D5|FBC088D6|FBC088D7|FBC088D8|FBC088D9|FBC088DA|FBC088DB|FBC088DC|FBC088DD|FBC088DE|FBC088DF|FBC088E0|FBC088E1|FBC088E2|FBC088E3|FBC088E4|FBC088E5|FBC088E6|FBC088E7|FBC088E8|FBC088E9|FBC088EA|FBC088EB|FBC088EC|FBC088ED|FBC088EE|FBC088EF|FBC088F0|FBC088F1|FBC088F2|FBC088F3|FBC088F4|FBC088F5|FBC088F6|FBC088F7|FBC088F8|FBC088F9|FBC088FA|FBC088FB|FBC088FC|FBC088FD|FBC088FE|FBC088FF;1e00:0E33|0E33|0E4A|0E4A|0E4A|0E4A|0E4A|0E4A|0E60|0E60|0E6D|0E6D|0E6D|0E6D|0E6D|0E6D|0E6D|0E6D|0E6D|0E6D|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0EB9|0EB9|0EC1|0EC1|0EE1|0EE1|0EE1|0EE1|0EE1|0EE1|0EE1|0EE1|0EE1|0EE1|0EFB|0EFB|0EFB|0EFB|0F21|0F21|0F21|0F21|0F21|0F21|0F2E|0F2E|0F2E|0F2E|0F2E|0F2E|0F2E|0F2E|0F5B|0F5B|0F5B|0F5B|0F5B|0F5B|0F64|0F64|0F64|0F64|0F64|0F64|0F64|0F64|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0FA7|0FA7|0FA7|0FA7|0FC0|0FC0|0FC0|0FC0|0FC0|0FC0|0FC0|0FC0|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|0FEA|1002|1002|1002|1002|1002|1002|1002|1002|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|1044|1044|1044|1044|1051|1051|1051|1051|1051|1051|1051|1051|1051|1051|105A|105A|105A|105A|105E|105E|106A|106A|106A|106A|106A|106A|0EE1|1002|1051|105E|0E3310B3|0FEA|FBC09E9C|FBC09E9D|FBC09E9E|FBC09E9F|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E33|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0E8B|0EFB|0EFB|0EFB|0EFB|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|0F82|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|101F|105E|105E|105E|105E|105E|105E|105E|105E|FBC09EFA|FBC09EFB|FBC09EFC|FBC09EFD|FBC09EFE|FBC09EFF;2000:0209|0209|0209|0209|0209|0209|0209|0209|0209|0209|0209||||||0225|0225|0226|0227|0228|0229|0432|021C|0278|0279|027A|027B|027F|0280|0281|0282|02D8|02D9|02DA|02DB|025D|025D025D|025D025D025D|02DC|0207|0208||||||0209|02D5|02D6|02E0|02E002E0|02E002E002E0|02E1|02E102E1|02E102E102E1|02E4|027C|027D|02E5|02510251|025C|0211|02E6|02E8|02EA|02EB|02DD|02CD|0294|0295|02550255|02550251|02510255|02D1|02C4|02DE|02DF|02C9|023C|02E9|02CA|02D7|022A|02E7|FBC0A055|FBC0A056|02E002E002E002E0|FBC0A058|FBC0A059|FBC0A05A|FBC0A05B|FBC0A05C|FBC0A05D|FBC0A05E|0209|||||FBC0A064|FBC0A065|FBC0A066|FBC0A067|FBC0A068|FBC0A069||||||;fb50:134B|134B|1353|1353|1353|1353|1354|1354|1354|1354|1355|1355|1355|1355|135A|135A|135A|135A|135D|135D|135D|135D|1359|1359|1359|1359|1397|1397|1397|1397|1399|1399|1399|1399|1360|1360|1360|1360|135F|135F|135F|135F|1361|1361|1361|1361|1363|1363|1363|1363|1370|1370|136F|136F|1371|1371|136B|136B|137E|137E|1377|1377|139F|139F|139F|139F|13A5|13A5|13A5|13A5|13A9|13A9|13A9|13A9|13A7|13A7|13A7|13A7|13B2|13B2|13B3|13B3|13B3|13B3|13BC|13BC|13B9|13B9|13B9|13B9|13B8|13B8|13B8|13B8|13CE|13CE|13CE|13CE|FBC1FBB2|FBC1FBB3|FBC1FBB4|FBC1FBB5|FBC1FBB6|FBC1FBB7|FBC1FBB8|FBC1FBB9|FBC1FBBA|FBC1FBBB|FBC1FBBC|FBC1FBBD|FBC1FBBE|FBC1FBBF|FBC1FBC0|FBC1FBC1|FBC1FBC2|FBC1FBC3|FBC1FBC4|FBC1FBC5|FBC1FBC6|FBC1FBC7|FBC1FBC8|FBC1FBC9|FBC1FBCA|FBC1FBCB|FBC1FBCC|FBC1FBCD|FBC1FBCE|FBC1FBCF|FBC1FBD0|FBC1FBD1|FBC1FBD2|13A3|13A3|13A3|13A3|13C1|13C1|13C0|13C0|13C2|13C2|13C11347|13C5|13C5|13BF|13BF|13C3|13C3|13CC|13CC|13CC|13CC|13C7|13C7|134F1350|134F1350|134F13BC|134F13BC|134F13BD|134F13BD|134F13C1|134F13C1|134F13C0|134F13C0|134F13C2|134F13C2|134F13CC|134F13CC|134F13CC|134F13C7|134F13C7|134F13C7|13C9|13C9|13C9|13C9|134F135E|134F1364|134F13B0|134F13C7|134F13C8|1352135E|13521364|13521365|135213B0|135213C7|135213C8|1357135E|13571364|13571365|135713B0|135713C7|135713C8|1358135E|135813B0|135813C7|135813C8|135E1364|135E13B0|1364135E|136413B0|1365135E|13651364|136513B0|1381135E|13811364|13811365|138113B0|13871364|138713B0|1388135E|13881364|13881365|138813B0|138C1364|138C13B0|138D13B0|138F135E|138F13B0|1390135E|139013B0|1393135E|13931364|13931365|139313B0|139313C7|139313C8|139B1364|139B13B0|139B13C7|139B13C8|139E1350|139E135E|139E1364|139E1365|139E13AB|139E13B0|139E13C7|139E13C8|13AB135E|13AB1364|13AB1365|13AB13B0|13AB13C7|13AB13C8|13B0135E|13B01364|13B01365|13B013B0|13B013C7|13B013C8|13B1135E|13B11364|13B11365|13B113B0|13B113C7|13B113C8|13B7135E|13B713B0|13B713C7|13B713C8|13C8135E|13C81364|13C81365|13C813B0|13C813C7|13C813C8|136A|1375|13C7|||||||134F1375|134F1376|134F13B0|134F13B1|134F13C7|134F13C8|13521375|13521376|135213B0|135213B1|135213C7|135213C8|13571375|13571376|135713B0|135713B1|135713C7|135713C8|13581375|13581376|135813B0|135813B1|135813C7|135813C8|139313C7|139313C8|139B13C7|139B13C8|139E1350|139E13AB|139E13B0|139E13C7|139E13C8|13AB13B0|13AB13C7|13AB13C8|13B01350|13B013B0|13B11375|13B11376|13B113B0|13B113B1|13B113C7|13B113C8|13C7|13C81375|13C81376|13C813B0|13C813B1|13C813C7|13C813C8|134F135E|134F1364|134F1365|134F13B0|134F13B7|1352135E|13521364|13521365|135213B0|135213B7|1357135E|13571364|13571365|135713B0|135713B7|135813B0|135E1364|135E13B0|1364135E|136413B0|1365135E|136513B0|1381135E|13811364|13811365|138113B0|13871364|13871365|138713B0|1388135E|13881364|13881365|138813B0|138C1364|138D13B0|138F135E|138F13B0|1390135E|139013B0|1393135E|13931364|13931365|139313B0|139B1364|139B13B0|139E135E|139E1364|139E1365|139E13AB|139E13B0|13AB135E|13AB1364|13AB1365|13AB13B0|13AB13B7|13B0135E|13B01364|13B01365|13B013B0|13B1135E|13B11364|13B11365|13B113B0|13B113B7|13B7135E|13B713B0|13B7|13C8135E|13C81364|13C81365|13C813B0|13C813B7|134F13B0|134F13B7|135213B0|135213B7|135713B0|135713B7|135813B0|135813B7|138113B0|138113B7|138213B0|138213B7|139E13AB|139E13B0|13AB13B0|13B113B0|13B113B7|13C813B0|13C813B7||||138C13C7|138C13C8|138F13C7|138F13C8|139013C7|139013C8|138113C7|138113C8|138213C7|138213C8|136413C7|136413C8|135E13C7|135E13C8|136513C7|136513C8|138713C7|138713C8|138813C7|138813C8|1382135E|13821364|13821365|138213B0|13821375|13811375|13871375|13881375|138C13C7|138C13C8|138F13C7|138F13C8|139013C7|139013C8|138113C7|138113C8|138213C7|138213C8|136413C7|136413C8|135E13C7|135E13C8|136513C7|136513C8|138713C7|138713C8|138813C7|138813C8|1382135E|13821364|13821365|138213B0|13821375|13811375|13871375|13881375|1382135E|13821364|13821365|138213B0|138113B7|138213B7|138C13B0|1381135E|13811364|13811365|1382135E|13821364|13821365|138C13B0|138D13B0|1350|1350|02C0|02C1|FBC1FD40|FBC1FD41|FBC1FD42|FBC1FD43|FBC1FD44|FBC1FD45|FBC1FD46|FBC1FD47|FBC1FD48|FBC1FD49|FBC1FD4A|FBC1FD4B|FBC1FD4C|FBC1FD4D|FBC1FD4E|FBC1FD4F|1357135E13B0|13571364135E|13571364135E|1357136413B0|1357136513B0|135713B0135E|135713B01364|135713B01365|135E13B01364|135E13B01364|136413B013C8|136413B013C7|13811364135E|1381135E1364|1381135E13C7|138113B01364|138113B01364|138113B0135E|138113B013B0|138113B013B0|138713641364|138713641364|138713B013B0|1382136413B0|1382136413B0|1382135E13C8|138213B01365|138213B01365|138213B013B0|138213B013B0|1388136413C7|1388136513B0|1388136513B0|138C13B01364|138C13B01364|138C13B013B0|138C13B013C8|138F135E13B0|138F13B013B0|138F13B013B0|138F13B013C7|139013B013B0|139013B013C8|139013B013C7|1393136513B0|1393136513B0|139B13B01364|139B13B013B0|13AB136413B0|13AB136413C8|13AB136413C7|13AB135E135E|13AB135E135E|13AB136513B0|13AB136513B0|13AB13B01364|13AB13B01364|13B01364135E|13B0136413B0|13B0136413C8|13B0135E1364|13B0135E13B0|13B01365135E|13B0136513B0|FBC1FD90|FBC1FD91|13B0135E1365|13B713B0135E|13B713B013B0|13B1136413B0|13B1136413C7|13B1135E13B0|13B1135E13B0|13B1135E13C7|13B113B013C8|13B113B013C7|13C813B013B0|13C813B013B0|1352136513C8|1357135E13C8|1357135E13C7|1357136513C8|1357136513C7|135713B013C8|135713B013C7|135E13B013C8|135E136413C7|135E13B013C7|1381136513C7|1387136413C8|1382136413C8|1388136413C8|13AB135E13C8|13AB13B013C8|13C8136413C8|13C8135E13C8|13C813B013C8|13B013B013C8|139B13B013C8|13B1136413C8|139B13B01364|13AB136413B0|138F13B013C8|139E13B013C8|13B1135E1364|13B0136513C8|13AB135E13B0|139E13B013B0|13AB135E13B0|13B1135E1364|135E136413C8|1364135E13C8|13B0135E13C8|139313B013C8|1352136413C8|139E13B013B0|138F135E13B0|138713B013B0|1381136513C8|13B1135E13C8|FBC1FDC8|FBC1FDC9|FBC1FDCA|FBC1FDCB|FBC1FDCC|FBC1FDCD|FBC1FDCE|FBC1FDCF|FBC1FDD0|FBC1FDD1|FBC1FDD2|FBC1FDD3|FBC1FDD4|FBC1FDD5|FBC1FDD6|FBC1FDD7|FBC1FDD8|FBC1FDD9|FBC1FDDA|FBC1FDDB|FBC1FDDC|FBC1FDDD|FBC1FDDE|FBC1FDDF|FBC1FDE0|FBC1FDE1|FBC1FDE2|FBC1FDE3|FBC1FDE4|FBC1FDE5|FBC1FDE6|FBC1FDE7|FBC1FDE8|FBC1FDE9|FBC1FDEA|FBC1FDEB|FBC1FDEC|FBC1FDED|FBC1FDEE|FBC1FDEF|138713AB13CE|139B13AB13CE|135013AB13AB13B7|1350139E13521375|13B0136413B01369|138713AB138F13B0|1375138113BD13AB|138F13AB13C813B7|13BD138113AB13B0|138713AB13C7|FBC1FDFA|135E13AB0209135E13AB135013AB13B7|137513C9135013AB|034F|FBC1FDFE|FBC1FDFF;fe70:|||||FBC1FE75|||||||||||1347|1348|1348|1349|1349|134C|134C|134D|134D|134F|134F|134F|134F|1350|1350|1352|1352|1352|1352|1356|1356|1357|1357|1357|1357|1358|1358|1358|1358|135E|135E|135E|135E|1364|1364|1364|1364|1365|1365|1365|1365|1369|1369|136A|136A|1375|1375|1376|1376|1381|1381|1381|1381|1382|1382|1382|1382|1387|1387|1387|1387|1388|1388|1388|1388|138C|138C|138C|138C|138D|138D|138D|138D|138F|138F|138F|138F|1390|1390|1390|1390|1393|1393|1393|1393|139B|139B|139B|139B|139E|139E|139E|139E|13AB|13AB|13AB|13AB|13B0|13B0|13B0|13B0|13B1|13B1|13B1|13B1|13B7|13B7|13B7|13B7|13BD|13BD|13C7|13C7|13C8|13C8|13C8|13C8|13AB1348|13AB1348|13AB1349|13AB1349|13AB134D|13AB134D|13AB1350|13AB1350|FBC1FEFD|FBC1FEFE|;ff01:0251|027E|02D2|0E0F|02D3|02CF|0277|0288|0289|02C8|0428|022F|0221|025D|02CC|0E29|0E2A|0E2B|0E2C|0E2D|0E2E|0E2F|0E30|0E31|0E32|023D|023A|042C|042D|042E|0255|02C7|0E33|0E4A|0E60|0E6D|0E8B|0EB9|0EC1|0EE1|0EFB|0F10|0F21|0F2E|0F5B|0F64|0F82|0FA7|0FB4|0FC0|0FEA|1002|101F|1044|1051|105A|105E|106A|028A|02CE|028B|020F|021B|020C|0E33|0E4A|0E60|0E6D|0E8B|0EB9|0EC1|0EE1|0EFB|0F10|0F21|0F2E|0F5B|0F64|0F82|0FA7|0FB4|0FC0|0FEA|1002|101F|1044|1051|105A|105E|106A|028C|0430|028D|0433'


const OfflineEdit = (() => {
/*
 * Changes made on a phone without a connection, kept on the phone until it syncs.
 *
 * A change is the request a page sent (method, path, body), with who made it and when. To show
 * the copy as changed, the saved copy (offlineData.js) is taken apart into records (toModel), each
 * change is applied the way the server's controller applies it (CHANGES), and the pages are put
 * together again from the records (fromModel): the same JSON the server would answer. Applying the
 * list again to the saved copy gives the same result (a change keeps the ids it was given), so a
 * change is undone by dropping it.
 *
 * Like offlineData.js, the service worker includes this file (see vite.config.js): no browser-only
 * APIs, and imports from offlineData.js only.
 */


/** What a phone adds gets ids from here on, far above the server's own; it gets real ones when it syncs. */
const TEMP_ID = 1_000_000_000
const isTempId = (id) => Number(id) >= TEMP_ID

/* ---------- PHP and Laravel, as the server's code behaves */

/** Laravel's TrimStrings: whitespace and invisible characters (Str::trim). */
const TRIMMED = '\\s\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F\\u2060-\\u2065\\u206A-\\u206F\\u2800\\u3164\\uFFA0\\u{1D159}\\u{1D173}-\\u{1D17A}\\u{E0020}\\0'
const LARAVEL_EDGES = new RegExp(`^[${TRIMMED}]+|[${TRIMMED}]+$`, 'gu')

/** The body as a controller sees it: texts trimmed, empty ones null (TrimStrings, ConvertEmptyStringsToNull). */
function asInput(value) {
  if (typeof value === 'string') {
    const text = value.replace(LARAVEL_EDGES, '')
    return text === '' ? null : text
  }
  if (Array.isArray(value)) return value.map(asInput)
  if (value && typeof value === 'object' && !value.file) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asInput(v)]))
  return value
}

/** PHP's trim(): ASCII whitespace only (with NUL and vertical tab). */
// oxlint-disable-next-line no-control-regex
const PHP_EDGES = /^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g
const phpTrim = (text) => String(text ?? '').replace(PHP_EDGES, '')
/** A PHP text is false when empty or '0'. */
const truthy = (text) => text != null && text !== '' && text !== '0'
/** strtok($text, "\n"): the first line that is not empty. */
const firstToken = (text) => String(text ?? '').split('\n').find((line) => line !== '') ?? ''
const length = (text) => Array.from(String(text)).length
/** $request->filled() */
const filled = (value) => value != null && String(value).trim() !== ''
const isInteger = (value) => (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()))
const isNumeric = (value) => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(value))

// oxlint-disable-next-line no-control-regex
const NAME_EDGES = /^[ \t\n\r\0\x0B:：.\-_]+|[ \t\n\r\0\x0B:：.\-_]+$/g

/** WordTableParser::normalize: how names are matched (groups, name fields). */
function normalizeName(text) {
  return String(text ?? '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(NAME_EDGES, '')
}

/** EquipmentGroup::keyFor */
const groupNameKey = (name) => Array.from(normalizeName(name)).slice(0, 191).join('')

/** EquipmentController::NAME_KEYS */
const NAME_KEYS = ['الاسم', 'اسم المعده', 'المعده', 'اسم', 'name', 'equipment', 'النوع', 'type']

/** Code point order, as PHP compares texts byte by byte (UTF-8). */
function codePointCompare(a, b) {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0)
    if (d) return d
  }
  return x.length - y.length
}

/** PHP 8's <=> for numbers, texts and null. */
function phpCompare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const x = a == null ? '' : String(a)
  const y = b == null ? '' : String(b)
  if (isNumeric(x) && isNumeric(y) && a != null && b != null) return Number(x) - Number(y)
  return codePointCompare(x, y)
}

/** mb_strimwidth($text, 0, $width, '…'): East Asian wide characters count twice. */
function strimwidth(text, width) {
  const wide = (cp) => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000
  const chars = Array.from(text).map((ch) => [ch, wide(ch.codePointAt(0)) ? 2 : 1])
  if (chars.reduce((sum, [, w]) => sum + w, 0) <= width) return text
  let out = ''
  let used = 0
  for (const [ch, w] of chars) {
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/** FieldDiff::make: the change set the history keeps. */
function fieldDiff(before, after, extraBefore = {}, extraAfter = {}) {
  const toMap = (fields) => new Map(fields.map((f) => [f.key, f.value ?? null]))
  const old = toMap(before)
  const now = toMap(after)
  const changes = { added: [], removed: [], changed: [] }
  for (const [key, value] of now) {
    if (!old.has(key)) changes.added.push({ key, value })
    else if (String(old.get(key) ?? '') !== String(value ?? '')) changes.changed.push({ key, from: old.get(key), to: value })
  }
  for (const [key, value] of old) if (!now.has(key)) changes.removed.push({ key, value })
  for (const [key, value] of Object.entries(extraAfter)) {
    if (String(extraBefore[key] ?? '') !== String(value ?? '')) changes.changed.push({ key, from: extraBefore[key] ?? null, to: value, system: true })
  }
  const kept = Object.fromEntries(Object.entries(changes).filter(([, list]) => list.length))
  return Object.keys(kept).length ? kept : null
}

/** A date as the database keeps it (Y-m-d), from what a page sent. */
function toDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''))
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(match[3]) ? null : date.toISOString().slice(0, 10)
}

/** Carbon's addMonthsNoOverflow: the 31st plus a month is the last day of the next month. */
function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, last))
  return target.toISOString().slice(0, 10)
}

/** A time as Laravel writes it in JSON. */
const laravelTime = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, '.000000Z')

/* ---------- Refusals, as Laravel answers them */

class Refusal {
  constructor(status, body) {
    this.status = status
    this.body = body
  }
}

const invalid = (field, message = 'offline_invalid') => {
  throw new Refusal(422, { message, errors: { [field]: [message] } })
}
const notFound = () => {
  throw new Refusal(404, { message: 'not_found' })
}

/** The checks of $request->validate() that the pages can break. */
function check(field, value, { required, max, integer, numeric, min, maxValue, date } = {}) {
  if (value == null) {
    if (required) invalid(field)
    return
  }
  if (typeof value === 'object') invalid(field)
  if (max != null && length(value) > max) invalid(field)
  if (integer && !isInteger(value)) invalid(field)
  if (numeric && !isNumeric(value)) invalid(field)
  if (min != null && Number(value) < min) invalid(field)
  if (maxValue != null && Number(value) > maxValue) invalid(field)
  if (date && !toDate(value)) invalid(field)
}

function idList(field, value, max, required = true) {
  if (value == null) {
    if (required) invalid(field)
    return []
  }
  if (!Array.isArray(value) || value.length > max) invalid(field)
  if (!value.every(isInteger)) invalid(`${field}.0`)
  return value.map(Number)
}

/* ---------- The records */

/** The copy taken apart: the rows the server keeps, which the pages are made from. */
function toModel(data) {
  const equipment = new Map()
  for (const e of data.equipment) {
    equipment.set(e.id, {
      id: e.id,
      parent_id: e.parent?.id ?? null,
      group_id: e.group?.id ?? null,
      serial_number: e.serial_number,
      name: e.name,
      row_no: e.row_no,
      category: e.category,
      fields: e.fields.map((f) => ({ key: f.key, value: f.value })),
      photo_url: e.photo_url,
      import: e.import,
      created_by: e.created_by,
      updated_by: e.updated_by,
      created_at: e.created_at,
      updated_at: e.updated_at,
    })
  }
  const boxes = new Map()
  const boxItems = new Map()
  for (const b of data.boxes) {
    boxes.set(b.id, { id: b.id, number: b.number, name: b.name, weight: b.weight, created_at: b.created_at, updated_at: b.updated_at })
    boxItems.set(b.id, b.equipment.map((e) => e.id))
  }
  const maintenance = new Map()
  for (const [id, m] of Object.entries(data.maintenance || {})) {
    maintenance.set(Number(id), { schedules: m.schedules.map((s) => ({ ...s })), records: m.records.map((r) => ({ ...r })) })
  }
  const issues = new Map()
  for (const [id, list] of Object.entries(data.issues || {})) issues.set(Number(id), list.map((i) => ({ ...i })))
  return {
    data,
    equipment,
    groups: new Map((data.groups || []).map((g) => [g.id, { ...g }])),
    boxes,
    boxItems,
    maintenance,
    issues,
    nextId: TEMP_ID,
  }
}

/** An equipment's accessories (while the pages are put together, from an index). */
const children = (m, e) => (m.index ? m.index.children.get(e.id) || [] : [...m.equipment.values()].filter((a) => a.parent_id === e.id))

/** EquipmentController::displayName */
function displayName(m, e) {
  if (truthy(e.name)) return e.name
  const named = new Map()
  for (const f of e.fields) if (phpTrim(f.value) !== '') named.set(normalizeName(f.key), f)
  for (const key of NAME_KEYS) if (named.has(key)) return firstToken(named.get(key).value)
  return e.group_id != null ? (m.groups.get(e.group_id)?.name ?? null) : null
}

/** EquipmentController::summaryFields */
function summaryFields(m, e, limit = 3) {
  const name = phpTrim(displayName(m, e) ?? '')
  return e.fields
    .map((f) => ({ key: phpTrim(f.key), value: phpTrim(firstToken(f.value)) }))
    .filter((f) => f.value !== '' && !NAME_KEYS.includes(normalizeName(f.key)) && f.value !== name && f.value !== e.serial_number)
    .slice(0, limit)
    .map((f) => ({ key: f.key, value: strimwidth(f.value, 60) }))
}

const groupRef = (m, id) => {
  const g = id != null ? m.groups.get(id) : null
  return g ? { id: g.id, name: g.name } : null
}

function boxesOf(m, e) {
  let list = []
  if (m.index) list = m.index.boxes.get(e.id) || []
  else for (const [id, items] of m.boxItems) if (items.includes(e.id)) list.push(m.boxes.get(id))
  return [...list].sort((a, b) => compareText(a.number, b.number) || a.id - b.id).map((b) => ({ id: b.id, number: b.number, name: b.name }))
}

/** EquipmentController::present, plus what the phone has not synced yet. */
function presentEquipment(m, e, notes) {
  const parent = e.parent_id != null ? m.equipment.get(e.parent_id) : null
  const accessories = children(m, e).sort((a, b) => compareValues(a.name, b.name) || compareValues(a.serial_number, b.serial_number) || a.id - b.id)
  return {
    id: e.id,
    serial_number: e.serial_number,
    name: e.name,
    display_name: displayName(m, e),
    row_no: e.row_no,
    category: e.category,
    parent: parent ? { id: parent.id, serial_number: parent.serial_number, name: parent.name, display_name: displayName(m, parent), category: parent.category } : null,
    group: groupRef(m, e.group_id),
    accessories: accessories.map((a) => ({ id: a.id, serial_number: a.serial_number, name: a.name, fields: a.fields.map((f) => ({ ...f })) })),
    fields: e.fields.map((f) => ({ ...f })),
    photo_url: e.photo_url,
    boxes: boxesOf(m, e),
    import: e.import,
    created_by: e.created_by,
    updated_by: e.updated_by,
    created_at: e.created_at,
    updated_at: e.updated_at,
    ...notesFor(notes, 'equipment', e.id),
  }
}

/** BoxController::present */
function presentBox(m, b, notes) {
  const items = (m.boxItems.get(b.id) || []).map((id) => m.equipment.get(id)).filter(Boolean)
  // sortBy([parent or own id, main first, serial]) with PHP's comparison (stable)
  const key = (e) => [e.parent_id ?? e.id, e.parent_id === null ? 0 : 1, e.serial_number]
  items.sort((a, b2) => {
    const [x, y] = [key(a), key(b2)]
    for (let i = 0; i < 3; i++) {
      const d = phpCompare(x[i], y[i])
      if (d) return d
    }
    return 0
  })
  return {
    id: b.id,
    number: b.number,
    name: b.name,
    weight: b.weight,
    created_at: b.created_at,
    updated_at: b.updated_at,
    equipment: items.map((e) => {
      const parent = e.parent_id != null ? m.equipment.get(e.parent_id) : null
      return {
        id: e.id,
        serial_number: e.serial_number,
        display_name: displayName(m, e),
        summary: summaryFields(m, e),
        category: e.category,
        parent: parent ? { id: parent.id, serial_number: parent.serial_number, name: parent.name, display_name: displayName(m, parent) } : null,
        // Accessories show under their main equipment's group
        group: groupRef(m, parent ? parent.group_id : e.group_id),
        photo_url: e.photo_url,
        ...markOf(notes, 'equipment', e.id),
      }
    }),
    ...notesFor(notes, 'box', b.id),
  }
}

/** EquipmentGroupController::show */
function presentGroupPage(m, g) {
  const units = [...m.equipment.values()].filter((e) => e.group_id === g.id).sort((a, b) => compareValues(a.row_no, b.row_no) || compareValues(a.serial_number, b.serial_number) || a.id - b.id)
  return {
    id: g.id,
    name: g.name,
    voucher_code: g.voucher_code,
    voucher_name: g.voucher_name,
    equipment: units.map((e) => ({
      id: e.id,
      serial_number: e.serial_number,
      display_name: displayName(m, e),
      row_no: e.row_no,
      category: e.category,
      accessories_count: children(m, e).length,
      photo_url: e.photo_url,
    })),
  }
}

/** The mark of an item changed on the phone ('new' or 'changed'), as `offline`. */
function markOf(notes, type, id) {
  const mark = notes?.marks.get(`${type}:${id}`)
  return mark ? { offline: mark } : {}
}

/** A page's mark and its changes not synced yet (the page lists them, with undo). */
function notesFor(notes, type, id) {
  const list = notes?.byItem.get(`${type}:${id}`)
  return { ...markOf(notes, type, id), ...(list?.length ? { offline_changes: list } : {}) }
}

/** The pages put together again from the records: the snapshot's shape (see OfflineController). */
function fromModel(m, notes = null) {
  const byId = (a, b) => a.id - b.id
  const equipment = [...m.equipment.values()].sort(byId)
  m.index = { children: new Map(), boxes: new Map() }
  for (const e of equipment) {
    if (e.parent_id == null) continue
    if (!m.index.children.has(e.parent_id)) m.index.children.set(e.parent_id, [])
    m.index.children.get(e.parent_id).push(e)
  }
  for (const [id, items] of m.boxItems) {
    for (const equipmentId of items) {
      if (!m.index.boxes.has(equipmentId)) m.index.boxes.set(equipmentId, [])
      m.index.boxes.get(equipmentId).push(m.boxes.get(id))
    }
  }
  try {
    return pages(m, notes, equipment, byId)
  } finally {
    delete m.index
  }
}

function pages(m, notes, equipment, byId) {
  const serials = {}
  for (const e of [...equipment].sort((a, b) => (a.parent_id != null) - (b.parent_id != null) || a.id - b.id)) {
    if ((e.serial_number ?? '') !== '' && !(e.serial_number in serials)) serials[e.serial_number] = e.id
  }
  const maintenance = {}
  for (const [id, item] of m.maintenance) if (m.equipment.has(id) && (item.schedules.length || item.records.length)) maintenance[id] = item
  const issues = {}
  for (const [id, list] of m.issues) if (m.equipment.has(id) && list.length) issues[id] = list
  const data = {
    ...m.data,
    equipment: equipment.map((e) => presentEquipment(m, e, notes)),
    serials,
    boxes: [...m.boxes.values()].sort(byId).map((b) => presentBox(m, b, notes)),
    maintenance,
    issues,
    groups: [...m.groups.values()].sort(byId).map((g) => ({ ...g, ...markOf(notes, 'group', g.id) })),
  }
  if (notes) data.stats = dashboard(m, notes.now)
  return data
}

/* ---------- The dashboard (EquipmentController::stats) for a changed copy */

function dashboard(m, now) {
  const saved = m.data.stats
  if (!saved) return saved
  const all = [...m.equipment.values()].sort((a, b) => a.id - b.id)
  const main = all.filter((e) => e.parent_id == null)
  const nameOnly = (e) => ({ id: e.id, serial_number: e.serial_number, name: e.name, group_id: e.group_id, display_name: displayName(m, e) })

  const categories = new Map()
  for (const e of all) {
    const key = e.category == null ? null : groupKey(e.category)
    const entry = categories.get(key)
    if (entry) entry.total++
    else categories.set(key, { category: e.category, total: 1 })
  }

  const today = new Date(now).toISOString().slice(0, 10)
  const week = addDays(today, 7)
  const monthStart = `${today.slice(0, 7)}-01T00:00:00.000Z`
  const schedules = []
  const openIssues = []
  for (const [id, item] of m.maintenance) if (m.equipment.has(id)) schedules.push(...item.schedules)
  for (const [id, list] of m.issues) if (m.equipment.has(id)) openIssues.push(...list.filter((i) => i.status === 'open'))
  schedules.sort((a, b) => compareText(a.due_date, b.due_date) || a.id - b.id)
  openIssues.sort((a, b) => b.id - a.id)

  return {
    ...saved,
    total: all.length,
    main: main.length,
    accessories: all.length - main.length,
    without_data: main.filter((e) => !e.fields.length).length,
    categories: [...categories.values()].sort((a, b) => b.total - a.total),
    added_this_month: all.filter((e) => new Date(e.created_at) >= new Date(monthStart)).length,
    attention: attention(m, all),
    maintenance: {
      overdue: schedules.filter((s) => s.due_date < today).length,
      soon: schedules.filter((s) => s.due_date >= today && s.due_date <= week).length,
      items: schedules.slice(0, 6).map((s) => ({ ...s, equipment: nameOnly(m.equipment.get(s.equipment_id)) })),
    },
    issues: {
      open: openIssues.length,
      items: openIssues.slice(0, 5).map((i) => ({ ...i, closed_by: null, equipment: nameOnly(m.equipment.get(i.equipment_id)) })),
    },
    recent_equipment: [...main]
      .sort((a, b) => compareText(b.created_at, a.created_at) || b.id - a.id)
      .slice(0, 6)
      .map((e) => ({ id: e.id, serial_number: e.serial_number, display_name: displayName(m, e), accessories_count: children(m, e).length, created_at: e.created_at })),
  }
}

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

/** EquipmentController::needsAttention */
function attention(m, all) {
  const words = String(m.data.settings?.attention_words ?? '')
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter(Boolean)
  if (!words.length) return { words: [], total: 0, items: [] }
  const wanted = words.map(pattern)
  const matches = []
  for (const e of [...all].sort((a, b) => compareText(b.updated_at, a.updated_at))) {
    const field = e.fields.find((f) => wanted.some((w) => has(f.value, w)))
    if (field) matches.push({ id: e.id, serial_number: e.serial_number, key: field.key, value: firstToken(field.value) })
  }
  return { words, total: matches.length, items: matches.slice(0, 8) }
}

/* ---------- The changes (each as the server's controller does it) */

function equipmentOr404(m, id) {
  return m.equipment.get(Number(id)) ?? notFound()
}

/** EquipmentController::validated */
function validatedEquipment(m, input, existing) {
  const serial = phpTrim(input.serial_number ?? '')
  const accessory = existing ? existing.parent_id != null : filled(input.parent_id)
  if (!accessory && serial === '') invalid('serial_number')
  check('serial_number', serial, { max: 191 })
  if (!accessory && [...m.equipment.values()].some((e) => e.parent_id == null && e.id !== existing?.id && same(e.serial_number, serial))) invalid('serial_number', 'serial_taken')
  check('name', input.name, { max: 191 })
  check('row_no', input.row_no, { integer: true, min: 0, maxValue: 999999999 })
  check('category', input.category, { max: 191 })
  if (existing) {
    if (filled(input.parent_id)) invalid('parent_id')
  } else if (input.parent_id != null) {
    check('parent_id', input.parent_id, { integer: true })
    const parent = m.equipment.get(Number(input.parent_id))
    if (!parent || parent.parent_id != null) invalid('parent_id')
  }
  if (input.group_id != null) {
    check('group_id', input.group_id, { integer: true })
    if (!m.groups.has(Number(input.group_id))) invalid('group_id')
  }
  const fields = input.fields ?? []
  if (!Array.isArray(fields) || fields.length > 500) invalid('fields')
  fields.forEach((f, i) => {
    check(`fields.${i}.key`, f?.key, { required: true, max: 255 })
    check(`fields.${i}.value`, f?.value, { max: 10000 })
  })
  return {
    serial_number: truthy(serial) ? serial : null,
    name: input.name ?? null,
    row_no: input.row_no == null ? null : Number(input.row_no),
    category: input.category ?? null,
    parent_id: input.parent_id == null ? null : Number(input.parent_id),
    group_id: input.group_id == null ? null : Number(input.group_id),
    fields: fields.map((f) => ({ key: phpTrim(f.key), value: f.value != null ? phpTrim(f.value) : null })),
    has: (key) => key in input,
  }
}

/** EquipmentGroup::joinByName: a new main equipment joins the group that has its name. */
function joinByName(m, e, ctx) {
  if (e.parent_id != null || e.group_id != null) return
  const key = groupNameKey(displayName(m, e))
  if (key === '') return
  const group = [...m.groups.values()].sort((a, b) => a.id - b.id).find((g) => same(g.name_key, key))
  if (group) {
    e.group_id = group.id
    e.updated_at = ctx.at
  }
}

const label = (m, e) => e.serial_number || displayName(m, e) || ''

/** How an equipment is named in the list of changes (its serial, or its name). */
const equipmentLabel = label

function storeEquipment(m, input, ctx) {
  const data = validatedEquipment(m, input, null)
  const parent = data.parent_id != null ? m.equipment.get(data.parent_id) : null
  const e = {
    id: ctx.newId(),
    parent_id: parent?.id ?? null,
    // Accessories stay with their main equipment and are never grouped
    group_id: parent ? null : data.group_id,
    serial_number: data.serial_number,
    name: data.name,
    row_no: data.row_no,
    category: truthy(data.category) ? data.category : (parent?.category ?? null),
    fields: data.fields,
    photo_url: null,
    import: null,
    created_by: ctx.user.name,
    updated_by: ctx.user.name,
    created_at: ctx.at,
    updated_at: ctx.at,
  }
  m.equipment.set(e.id, e)
  joinByName(m, e, ctx)
  // An accessory goes wherever its main equipment is
  if (parent) for (const items of m.boxItems.values()) if (items.includes(parent.id)) items.push(e.id)
  ctx.mark('equipment', e.id, 'new')
  if (parent) ctx.mark('equipment', parent.id)
  return {
    body: presentEquipment(m, e),
    effect: parent ? { kind: 'accessory_created', label: label(m, e), parent: label(m, parent) } : { kind: 'equipment_created', label: label(m, e) },
  }
}

/** What an equipment holds that its page edits: compared before and after (history, sync). */
const equipmentState = (e) => ({ serial_number: e.serial_number, name: e.name, row_no: e.row_no, category: e.category, group_id: e.group_id, fields: e.fields.map((f) => ({ ...f })) })

function updateEquipment(m, input, ctx, id) {
  const e = equipmentOr404(m, id)
  const data = validatedEquipment(m, input, e)
  const before = e.fields
  const extraBefore = { serial_number: e.serial_number, name: e.name, row_no: e.row_no, category: e.category }
  const groupBefore = e.group_id

  // parent_id is fixed after creation; Eloquent only saves (and dates) what changed
  const next = {
    serial_number: data.serial_number,
    name: data.name,
    row_no: data.has('row_no') ? data.row_no : e.row_no,
    category: data.has('category') ? data.category : e.category,
    updated_by: ctx.user.name,
  }
  const dirty = Object.entries(next).some(([key, value]) => e[key] !== value)
  Object.assign(e, next)
  if (dirty) e.updated_at = ctx.at
  if (data.has('group_id') && e.parent_id == null && Number(data.group_id ?? 0) !== Number(e.group_id ?? 0)) {
    e.group_id = data.group_id
    e.updated_at = ctx.at
  }
  e.fields = data.fields

  const changes = fieldDiff(before, e.fields, extraBefore, { serial_number: e.serial_number, name: e.name, row_no: e.row_no, category: e.category })
  ctx.mark('equipment', e.id)
  return {
    body: presentEquipment(m, e),
    effect: { kind: 'equipment_updated', label: label(m, e), changes, group: e.group_id !== groupBefore ? (groupRef(m, e.group_id)?.name ?? '') : undefined },
  }
}

/** Deleting more than this many equipment asks for the PIN again (EquipmentController::LARGE_DELETE). */
const LARGE_DELETE = 5

/** How many equipment a delete request takes away (the PIN is asked above LARGE_DELETE). */
function deleteCount(m, method, path, input) {
  const one = method === 'DELETE' && /^\/api\/equipment\/(\d+)$/.exec(path)
  if (one) {
    const e = m.equipment.get(Number(one[1]))
    return e ? 1 + children(m, e).length : 0
  }
  if (method === 'POST' && path === '/api/equipment/bulk-delete' && Array.isArray(input?.ids)) {
    const ids = new Set(input.ids.map(Number))
    return [...ids].filter((id) => m.equipment.has(id)).length + [...m.equipment.values()].filter((e) => ids.has(e.parent_id) && !ids.has(e.id)).length
  }
  return 0
}

function forget(m, e) {
  m.equipment.delete(e.id)
  m.maintenance.delete(e.id)
  m.issues.delete(e.id)
  for (const items of m.boxItems.values()) {
    const i = items.indexOf(e.id)
    if (i >= 0) items.splice(i, 1)
  }
}

/** @return number of equipment deleted (the equipment and its accessories) */
function deleteWithAccessories(m, e, ctx) {
  const accessories = children(m, e)
  for (const a of accessories) forget(m, a)
  if (e.parent_id != null) ctx.mark('equipment', e.parent_id)
  forget(m, e)
  return accessories.length + 1
}

function deleteEquipment(m, input, ctx, id) {
  const e = equipmentOr404(m, id)
  const name = label(m, e)
  const n = deleteWithAccessories(m, e, ctx)
  return { status: 204, effect: { kind: 'equipment_deleted', label: name, n } }
}

function bulkDelete(m, input, ctx) {
  const ids = idList('ids', input.ids, 1000)
  const labels = []
  let n = 0
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    // An accessory may already be gone together with its main equipment
    const e = m.equipment.get(id)
    if (!e) continue
    labels.push(label(m, e))
    n += deleteWithAccessories(m, e, ctx)
  }
  return { body: { deleted: n }, effect: { kind: 'equipment_bulk_deleted', n, labels } }
}

/** FieldController::bulkUpdate */
function bulkUpdate(m, input, ctx) {
  const ids = idList('ids', input.ids, 2000)
  if (!['set', 'remove', 'category'].includes(input.action)) invalid('action')
  if (input.action !== 'category') check('key', input.key, { required: true, max: 255 })
  check('value', input.value, { max: 10000 })
  check('category', input.category, { max: 191 })
  const key = phpTrim(input.key ?? '')
  const items = [...new Set(ids)].sort((a, b) => a - b).map((id) => m.equipment.get(id)).filter(Boolean)

  let updated = 0
  for (const e of items) {
    const before = e.fields
    const categoryBefore = e.category
    let fields = before
    if (input.action === 'category') e.category = truthy(input.category) ? input.category : null
    else {
      fields = before.filter((f) => f.key !== key)
      if (input.action === 'set') {
        // Keep the field where it was, or add it at the end
        const position = before.findIndex((f) => f.key === key)
        fields.splice(position === -1 ? fields.length : position, 0, { key, value: input.value ?? '' })
      }
      e.fields = fields
    }
    if (fieldDiff(before, e.fields, { category: categoryBefore }, { category: e.category })) {
      e.updated_by = ctx.user.name
      e.updated_at = ctx.at
      ctx.mark('equipment', e.id)
      updated++
    }
  }
  return {
    body: { updated },
    effect: { kind: input.action === 'category' ? 'bulk_category' : input.action === 'set' ? 'bulk_set' : 'bulk_remove', n: updated, key, value: input.action === 'category' ? (input.category ?? '') : (input.value ?? '') },
  }
}

/** EquipmentGroupController::assign */
function assignGroup(m, input, ctx) {
  const ids = idList('ids', input.ids, 2000)
  if (input.group_id != null) {
    check('group_id', input.group_id, { integer: true })
    if (!m.groups.has(Number(input.group_id))) invalid('group_id')
  }
  const groupId = input.group_id == null ? null : Number(input.group_id)
  // Accessories always stay with their main equipment
  const items = [...new Set(ids)]
    .sort((a, b) => a - b)
    .map((id) => m.equipment.get(id))
    .filter((e) => e && e.parent_id == null && e.group_id !== groupId)
  const from = items.map((e) => groupRef(m, e.group_id)?.name).filter(Boolean)
  for (const e of items) {
    e.group_id = groupId
    e.updated_at = ctx.at
    ctx.mark('equipment', e.id)
  }
  return {
    body: { changed: items.length },
    effect: groupId ? { kind: 'group_assigned', n: items.length, group: m.groups.get(groupId).name, labels: items.map((e) => label(m, e)) } : { kind: 'group_unassigned', n: items.length, group: from[0] ?? '', labels: items.map((e) => label(m, e)) },
  }
}

const PHOTO_TYPES = /^image\/(jpe?g|png|webp|hei[cf])$/
const PHOTO_NAMES = /\.(jpe?g|png|webp|hei[cf])$/i
const MAX_PHOTO = 12288 * 1024

function photoFile(field, file, required) {
  if (!file?.file) {
    if (required || file != null) invalid(field)
    return null
  }
  if (file.size > MAX_PHOTO || !(PHOTO_TYPES.test(file.type || '') || PHOTO_NAMES.test(file.name || ''))) invalid(field)
  return file
}

/** The address a photo taken on the phone is kept at (in the photo store of sw.js). */
const localPhotoUrl = (id, file) => `/api/equipment/${id}/photo?v=${file.slice(0, 8)}`
const localIssuePhotoUrl = (id) => `/api/issues/${id}/photo`

function setPhoto(m, input, ctx, id) {
  const e = equipmentOr404(m, id)
  const file = photoFile('photo', input.photo, true)
  e.photo_url = localPhotoUrl(e.id, file.file)
  e.updated_by = ctx.user.name
  e.updated_at = ctx.at
  ctx.mark('equipment', e.id)
  return { body: { photo_url: e.photo_url }, effect: { kind: 'photo_changed', label: label(m, e) } }
}

function removePhoto(m, input, ctx, id) {
  const e = equipmentOr404(m, id)
  if (e.photo_url) {
    e.photo_url = null
    e.updated_by = ctx.user.name
    e.updated_at = ctx.at
    ctx.mark('equipment', e.id)
  }
  return { body: { photo_url: null }, effect: { kind: 'photo_removed', label: label(m, e) } }
}

/* Maintenance (MaintenanceController) */

function maintenanceOf(m, id) {
  if (!m.maintenance.has(id)) m.maintenance.set(id, { schedules: [], records: [] })
  return m.maintenance.get(id)
}

function findSchedule(m, id) {
  for (const [equipmentId, item] of m.maintenance) {
    const schedule = item.schedules.find((s) => s.id === Number(id))
    if (schedule && m.equipment.has(equipmentId)) return { schedule, item, equipment: m.equipment.get(equipmentId) }
  }
  return notFound()
}

const sortSchedules = (list) => list.sort((a, b) => compareText(a.due_date, b.due_date) || a.id - b.id)
const sortRecords = (list) => list.sort((a, b) => compareText(b.done_at, a.done_at) || b.id - a.id)

function validatedSchedule(input) {
  check('title', input.title, { required: true, max: 191 })
  check('due_date', input.due_date, { required: true, date: true })
  check('interval_months', input.interval_months, { integer: true, min: 1, maxValue: 240 })
  check('notes', input.notes, { max: 5000 })
  return { title: input.title, due_date: toDate(input.due_date), interval_months: input.interval_months == null ? null : Number(input.interval_months), notes: input.notes ?? null }
}

function validatedWork(input, required) {
  check('title', input.title, { required, max: 191 })
  check('done_at', input.done_at, { required, date: true })
  check('notes', input.notes, { max: 5000 })
  check('cost', input.cost, { numeric: true, min: 0, maxValue: 999999999 })
  return { cost: input.cost == null ? null : (Math.round(Number(input.cost) * 100) / 100).toFixed(2) }
}

function addSchedule(m, input, ctx, id) {
  const e = equipmentOr404(m, id)
  const data = validatedSchedule(input)
  const schedule = { id: ctx.newId(), equipment_id: e.id, ...data, created_at: ctx.at, updated_at: ctx.at }
  sortSchedules(maintenanceOf(m, e.id).schedules).push(schedule)
  sortSchedules(maintenanceOf(m, e.id).schedules)
  ctx.mark('equipment', e.id)
  return { status: 201, body: schedule, effect: { kind: 'schedule_added', label: label(m, e), title: schedule.title, date: schedule.due_date } }
}

function updateSchedule(m, input, ctx, id) {
  const { schedule, item, equipment } = findSchedule(m, id)
  Object.assign(schedule, validatedSchedule(input), { updated_at: ctx.at })
  sortSchedules(item.schedules)
  ctx.mark('equipment', equipment.id)
  return { body: schedule, effect: { kind: 'schedule_updated', label: label(m, equipment), title: schedule.title, date: schedule.due_date } }
}

function deleteSchedule(m, input, ctx, id) {
  const { schedule, item, equipment } = findSchedule(m, id)
  item.schedules.splice(item.schedules.indexOf(schedule), 1)
  ctx.mark('equipment', equipment.id)
  return { status: 204, effect: { kind: 'schedule_removed', label: label(m, equipment), title: schedule.title } }
}

function record(m, e, ctx, fields) {
  const entry = { id: ctx.newId(), equipment_id: e.id, ...fields, user_id: ctx.user.id, created_at: ctx.at, updated_at: ctx.at }
  const item = maintenanceOf(m, e.id)
  item.records.push({ ...entry, user: { id: ctx.user.id, name: ctx.user.name } })
  sortRecords(item.records)
  return entry
}

/** The work was done: logged, then a repeating date moves on from the day it was done, a one-time date goes. */
function completeSchedule(m, input, ctx, id) {
  const { schedule, item, equipment } = findSchedule(m, id)
  check('done_at', input.done_at, { date: true })
  const { cost } = validatedWork({ ...input, title: schedule.title }, false)
  const doneAt = toDate(input.done_at) ?? ctx.at.slice(0, 10)
  const entry = record(m, equipment, ctx, { schedule_id: schedule.interval_months ? schedule.id : null, title: schedule.title, done_at: doneAt, notes: input.notes ?? null, cost })
  if (schedule.interval_months) {
    schedule.due_date = addMonths(doneAt, schedule.interval_months)
    schedule.updated_at = ctx.at
    sortSchedules(item.schedules)
  } else item.schedules.splice(item.schedules.indexOf(schedule), 1)
  ctx.mark('equipment', equipment.id)
  return {
    body: { record: entry, schedule: schedule.interval_months ? schedule : null },
    effect: { kind: 'schedule_done', label: label(m, equipment), title: schedule.title, date: doneAt },
  }
}

function addRecord(m, input, ctx, id) {
  const e = equipmentOr404(m, id)
  const { cost } = validatedWork(input, true)
  const entry = record(m, e, ctx, { schedule_id: null, title: input.title, done_at: toDate(input.done_at), notes: input.notes ?? null, cost })
  ctx.mark('equipment', e.id)
  return { status: 201, body: entry, effect: { kind: 'record_added', label: label(m, e), title: entry.title, date: entry.done_at } }
}

/* Problem reports (IssueController) */

function reportIssue(m, input, ctx, id) {
  const e = equipmentOr404(m, id)
  check('description', input.description, { required: true, max: 2000 })
  check('reporter', input.reporter, { max: 100 })
  const photo = photoFile('photo', input.photo, false)
  const issue = {
    id: ctx.newId(),
    equipment_id: e.id,
    description: input.description,
    reporter: input.reporter ?? null,
    status: 'open',
    resolution: null,
    closed_by: null,
    closed_at: null,
    created_at: ctx.at,
    updated_at: ctx.at,
    has_photo: !!photo,
  }
  if (!m.issues.has(e.id)) m.issues.set(e.id, [])
  m.issues.get(e.id).unshift(issue)
  ctx.mark('equipment', e.id)
  return { status: 201, body: issue, effect: { kind: 'issue_reported', label: label(m, e), text: issue.description } }
}

function closeIssue(m, input, ctx, id) {
  let found = null
  for (const [equipmentId, list] of m.issues) {
    const issue = list.find((i) => i.id === Number(id))
    if (issue && m.equipment.has(equipmentId)) found = { issue, equipment: m.equipment.get(equipmentId) }
  }
  if (!found) notFound()
  check('resolution', input.resolution, { max: 2000 })
  const { issue, equipment } = found
  if (issue.status !== 'open') invalid('resolution', 'already_closed')
  Object.assign(issue, { status: 'closed', resolution: input.resolution ?? null, closed_by: { id: ctx.user.id, name: ctx.user.name }, closed_at: ctx.at, updated_at: ctx.at })
  ctx.mark('equipment', equipment.id)
  return { body: issue, effect: { kind: 'issue_closed', label: label(m, equipment), text: issue.description } }
}

/* Groups (EquipmentGroupController) */

/** Empty voucher texts are kept as null (EquipmentGroupController::trimmed). */
const voucherText = (value) => {
  const text = phpTrim(String(value ?? '').replace(/\s+/gu, ' '))
  return truthy(text) ? text : null
}

function validatedGroupName(m, input, group) {
  check('name', input.name, { required: true, max: 191 })
  const name = phpTrim(input.name)
  const key = groupNameKey(name)
  const taken = [...m.groups.values()].some((g) => g.id !== group?.id && same(g.name_key, key))
  if (taken || key === '') invalid('name', taken ? 'group_name_taken' : 'group_name_invalid')
  return { name, name_key: key }
}

function storeGroup(m, input, ctx) {
  check('voucher_code', input.voucher_code, { max: 191 })
  check('voucher_name', input.voucher_name, { max: 191 })
  const named = validatedGroupName(m, input, null)
  const group = {
    id: ctx.newId(),
    ...named,
    voucher_code: 'voucher_code' in input ? voucherText(input.voucher_code) : null,
    voucher_name: 'voucher_name' in input ? voucherText(input.voucher_name) : null,
    created_by: ctx.user.id,
    created_at: ctx.at,
    updated_at: ctx.at,
  }
  m.groups.set(group.id, group)
  ctx.mark('group', group.id, 'new')
  return { body: presentGroupPage(m, group), effect: { kind: 'group_created', label: group.name } }
}

/** What a group holds that its page edits. */
const groupState = (g) => ({ name: g.name, voucher_code: g.voucher_code, voucher_name: g.voucher_name })

function updateGroup(m, input, ctx, id) {
  const group = m.groups.get(Number(id)) ?? notFound()
  check('voucher_code', input.voucher_code, { max: 191 })
  check('voucher_name', input.voucher_name, { max: 191 })
  const next = {}
  for (const key of ['voucher_code', 'voucher_name']) if (key in input) next[key] = voucherText(input[key])
  if ('name' in input) Object.assign(next, validatedGroupName(m, input, group))
  const before = group.name
  if (Object.entries(next).some(([key, value]) => group[key] !== value)) {
    Object.assign(group, next, { updated_at: ctx.at })
  }
  ctx.mark('group', group.id)
  return { body: presentGroupPage(m, group), effect: { kind: 'group_updated', label: group.name, from: before !== group.name ? before : undefined } }
}

function deleteGroup(m, input, ctx, id) {
  const group = m.groups.get(Number(id)) ?? notFound()
  for (const e of m.equipment.values()) {
    if (e.group_id === group.id) {
      e.group_id = null
      e.updated_at = ctx.at
      ctx.mark('equipment', e.id)
    }
  }
  m.groups.delete(group.id)
  return { status: 204, effect: { kind: 'group_deleted', label: group.name } }
}

/* Boxes (BoxController) */

function boxOr404(m, id) {
  return m.boxes.get(Number(id)) ?? notFound()
}

function validatedBox(m, input, box) {
  const number = phpTrim(input.number ?? '')
  if (number === '') invalid('number')
  check('number', number, { max: 50 })
  if (/[/\\?]/.test(number)) invalid('number', 'box_number_invalid')
  if ([...m.boxes.values()].some((b) => b.id !== box?.id && same(b.number, number))) invalid('number', 'box_number_taken')
  check('name', input.name, { max: 191 })
  check('weight', input.weight, { numeric: true, min: 0, maxValue: 99999999 })
  const data = { number }
  if ('name' in input) data.name = input.name ?? null
  if ('weight' in input) data.weight = input.weight == null ? null : Number(input.weight)
  return data
}

/** What a box holds that its page edits. */
const boxState = (b) => ({ number: b.number, name: b.name, weight: b.weight })

function storeBox(m, input, ctx) {
  const data = validatedBox(m, input, null)
  const box = { id: ctx.newId(), number: data.number, name: data.name ?? null, weight: data.weight ?? null, created_at: ctx.at, updated_at: ctx.at }
  m.boxes.set(box.id, box)
  m.boxItems.set(box.id, [])
  ctx.mark('box', box.id, 'new')
  return { body: presentBox(m, box), effect: { kind: 'box_created', label: box.number } }
}

function updateBox(m, input, ctx, id) {
  const box = boxOr404(m, id)
  const data = validatedBox(m, input, box)
  const before = box.number
  if (Object.entries(data).some(([key, value]) => box[key] !== value)) Object.assign(box, data, { updated_at: ctx.at })
  ctx.mark('box', box.id)
  return { body: presentBox(m, box), effect: { kind: 'box_updated', label: box.number, from: before !== box.number ? before : undefined } }
}

function deleteBox(m, input, ctx, id) {
  const box = boxOr404(m, id)
  for (const equipmentId of m.boxItems.get(box.id) || []) if (m.equipment.has(equipmentId)) ctx.mark('equipment', equipmentId)
  m.boxes.delete(box.id)
  m.boxItems.delete(box.id)
  return { status: 204, effect: { kind: 'box_deleted', label: box.number } }
}

/** Main equipment bring their accessories (BoxController::withAccessories). */
function withAccessories(m, list) {
  const out = [...list]
  const mains = new Set(list.filter((e) => e.parent_id == null).map((e) => e.id))
  for (const e of [...m.equipment.values()].sort((a, b) => a.id - b.id)) if (mains.has(e.parent_id)) out.push(e)
  return [...new Map(out.map((e) => [e.id, e])).values()]
}

function attachToBox(m, input, ctx, id) {
  const box = boxOr404(m, id)
  if (input.ids == null && input.group_ids == null) invalid('ids')
  const ids = new Set(idList('ids', input.ids, 1000, false))
  const groupIds = new Set(idList('group_ids', input.group_ids, 100, false))
  for (const groupId of groupIds) if (!m.groups.has(groupId)) invalid('group_ids.0')
  const items = m.boxItems.get(box.id)
  const chosen = [...m.equipment.values()].sort((a, b) => a.id - b.id).filter((e) => ids.has(e.id) || groupIds.has(e.group_id))
  const added = withAccessories(m, chosen).filter((e) => !items.includes(e.id))
  for (const e of added) {
    items.push(e.id)
    ctx.mark('equipment', e.id)
  }
  box.updated_at = ctx.at
  ctx.mark('box', box.id)
  return { body: { added: added.length, box: presentBox(m, box) }, effect: { kind: 'box_items_added', label: box.number, n: added.length, labels: added.filter((e) => e.parent_id == null).map((e) => label(m, e)) } }
}

function takeOut(m, box, list, ctx) {
  const items = m.boxItems.get(box.id)
  const removed = withAccessories(m, list).filter((e) => items.includes(e.id))
  for (const e of removed) {
    items.splice(items.indexOf(e.id), 1)
    ctx.mark('equipment', e.id)
  }
  box.updated_at = ctx.at
  ctx.mark('box', box.id)
  return { body: presentBox(m, box), effect: { kind: 'box_items_removed', label: box.number, n: removed.length, labels: removed.filter((e) => e.parent_id == null || !removed.some((x) => x.id === e.parent_id)).map((e) => label(m, e)) } }
}

function detachFromBox(m, input, ctx, id, equipmentId) {
  const box = boxOr404(m, id)
  return takeOut(m, box, [equipmentOr404(m, equipmentId)], ctx)
}

function detachManyFromBox(m, input, ctx, id) {
  const box = boxOr404(m, id)
  const ids = new Set(idList('ids', input.ids, 1000))
  return takeOut(m, box, [...m.equipment.values()].sort((a, b) => a.id - b.id).filter((e) => ids.has(e.id)), ctx)
}

/** The changes a phone can make without a connection; anything else waits for the server. */
const CHANGES = [
  ['POST', /^\/api\/equipment$/, storeEquipment],
  ['PUT', /^\/api\/equipment\/(\d+)$/, updateEquipment],
  ['DELETE', /^\/api\/equipment\/(\d+)$/, deleteEquipment],
  ['POST', /^\/api\/equipment\/bulk-delete$/, bulkDelete],
  ['POST', /^\/api\/equipment\/bulk-update$/, bulkUpdate],
  ['POST', /^\/api\/equipment\/(\d+)\/photo$/, setPhoto],
  ['DELETE', /^\/api\/equipment\/(\d+)\/photo$/, removePhoto],
  ['POST', /^\/api\/equipment\/(\d+)\/maintenance$/, addSchedule],
  ['POST', /^\/api\/equipment\/(\d+)\/maintenance-records$/, addRecord],
  ['PUT', /^\/api\/maintenance\/(\d+)$/, updateSchedule],
  ['DELETE', /^\/api\/maintenance\/(\d+)$/, deleteSchedule],
  ['POST', /^\/api\/maintenance\/(\d+)\/complete$/, completeSchedule],
  ['POST', /^\/api\/equipment\/(\d+)\/issues$/, reportIssue],
  ['POST', /^\/api\/issues\/(\d+)\/close$/, closeIssue],
  ['POST', /^\/api\/groups$/, storeGroup],
  ['PUT', /^\/api\/groups\/(\d+)$/, updateGroup],
  ['DELETE', /^\/api\/groups\/(\d+)$/, deleteGroup],
  ['POST', /^\/api\/groups\/assign$/, assignGroup],
  ['POST', /^\/api\/boxes$/, storeBox],
  ['PUT', /^\/api\/boxes\/(\d+)$/, updateBox],
  ['DELETE', /^\/api\/boxes\/(\d+)$/, deleteBox],
  ['POST', /^\/api\/boxes\/(\d+)\/equipment$/, attachToBox],
  ['DELETE', /^\/api\/boxes\/(\d+)\/equipment\/(\d+)$/, detachFromBox],
  ['POST', /^\/api\/boxes\/(\d+)\/equipment\/remove$/, detachManyFromBox],
]

/** Whether the phone can make this change without the server. */
const canChangeOffline = (method, path) => CHANGES.some(([m, pattern]) => m === method && pattern.test(path))

/**
 * Applies one change to the records, as the server would. A refused change answers 4xx and
 * changes nothing. `replay`: the change was made before, it takes the ids it was given then.
 * Returns { status, body, effect, touched }: effect describes it for the list of changes, touched
 * is what it changed ([type, id, 'new' | 'changed']).
 */
function applyChange(m, change, { replay = false } = {}) {
  const route = CHANGES.find(([method, pattern]) => method === change.method && pattern.test(change.path))
  if (!route) return { status: 409, body: { message: 'offline_sync_first' } }
  const given = replay ? [...(change.ids || [])] : []
  const ids = []
  const touched = []
  const ctx = {
    at: change.at,
    user: change.user,
    newId: () => {
      const id = replay && given.length ? given.shift() : m.nextId
      m.nextId = Math.max(m.nextId, id + 1)
      ids.push(id)
      return id
    },
    mark: (type, id, state = 'changed') => touched.push([type, id, state]),
  }
  try {
    const { status = 200, body = null, effect } = route[2](m, asInput(change.body ?? {}), ctx, ...change.path.match(route[1]).slice(1))
    if (!replay) change.ids = ids
    return { status, body, effect, touched }
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, body: error.body }
    throw error
  }
}

/** Marks and change lists for the pages, from the changes applied in order. */
function notesFrom(changes, results, now) {
  const marks = new Map()
  const byItem = new Map()
  changes.forEach((change, i) => {
    const result = results[i]
    if (!result || result.status >= 400) return
    const seen = new Set()
    for (const [type, id, state] of result.touched) {
      const key = `${type}:${id}`
      if (state === 'new' || !marks.has(key)) marks.set(key, marks.get(key) === 'new' ? 'new' : state)
      if (seen.has(key)) continue
      seen.add(key)
      if (!byItem.has(key)) byItem.set(key, [])
      byItem.get(key).push({ id: change.id, at: change.at, user: change.user?.name ?? null, ...result.effect })
    }
  })
  return { marks, byItem, now }
}

/**
 * The saved copy with the changes applied, as the pages read it (data for openCopy), and what
 * each change did: [{ status, body, effect, touched }]. A change that no longer applies (one it
 * built on was undone) answers 4xx.
 */
function applyAll(saved, changes, now = Date.now()) {
  const model = toModel(saved)
  for (const change of changes) for (const id of change.ids || []) model.nextId = Math.max(model.nextId, id + 1)
  const results = changes.map((change) => applyChange(model, change, { replay: true }))
  return { model, results, data: changes.length ? fromModel(model, notesFrom(changes, results, now)) : saved }
}

/** Undoing a change also undoes the later ones that built on it (they no longer apply without it). */
function undoPlan(saved, changes, id) {
  const rest = changes.filter((c) => c.id !== id)
  const { results } = applyAll(saved, rest)
  return [id, ...rest.filter((c, i) => results[i].status >= 400).map((c) => c.id)]
}

return { TEMP_ID, isTempId, normalizeName, groupNameKey, fieldDiff, laravelTime, toModel, fromModel, equipmentLabel, equipmentState, LARGE_DELETE, deleteCount, localPhotoUrl, localIssuePhotoUrl, groupState, boxState, canChangeOffline, applyChange, notesFrom, applyAll, undoPlan }
})()
