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
    // Saved on the server with this key (App\Http\Middleware\ApplyOfflineChange): when its answer
    // comes too late, the phone keeps the change too, and the sync does not make it twice
    const key = crypto.randomUUID()
    const headers = new Headers(request.headers)
    headers.set('X-Offline-Change', key)
    headers.set('X-Offline-Live', '1')
    try {
      return await fromNetwork(new Request(request, { headers }), { cancel: true })
    } catch {
      return keep(kept, path, key)
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

/**
 * The change applied to the copy and saved with the others, as the server would answer it (`key`:
 * the one it was sent to the server with, when that got no answer in time).
 */
function keep(request, path, key = crypto.randomUUID()) {
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
      key,
      at: OfflineEdit.laravelTime(Date.now()),
      user: { id: user.id, name: user.name },
      method: request.method,
      path,
      body,
    }
    const result = OfflineEdit.applyChange(model, entry)
    if (result.status >= 400 || !result.effect) {
      // Refused as the server would, or nothing changed (a code already scanned): nothing is kept
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
  if (/^\/api\/scan-documents\/\d+$/.test(path) && method === 'PUT') return page(path)
  // A row of a scan document, with its mark
  const row = /^\/api\/scan-documents\/(\d+)\/(scan|rows)/.exec(path) && (body?.row ?? body)
  if (row?.id && method !== 'DELETE') {
    const shown = page(`/api/scan-documents/${row.scan_document_id}`)?.rows?.find((r) => r.id === row.id)
    const marked = shown?.offline ? { ...row, offline: shown.offline } : row
    return body?.row ? { ...body, row: marked } : marked
  }
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

/* OFFLINE_DATA */

/* OFFLINE_EDIT */
