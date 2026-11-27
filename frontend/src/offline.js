import { useSyncExternalStore } from 'react'
import { OCR_CACHE, saveOcrFiles } from './ocr/files'

/*
 * Working without a connection: the "Work offline" page saves a copy of everything on the
 * phone, and the service worker (sw.js) answers the pages from it when the server cannot be
 * reached. Browsers only run service workers on https (or localhost).
 */

// Keep these names in sync with sw.js
const DATA = 'repo-offline-data'
const PHOTOS = 'repo-offline-photos'
const SNAPSHOT_KEY = '/__offline__/snapshot.json'
const META_KEY = '/__offline__/meta.json'

/** Photos downloaded at the same time. */
const PARALLEL = 4

export const offlineSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'caches' in window

/*
 * ---------- Is the data on screen from the saved copy? Set by api.js from the worker's headers:
 * X-Repo-Offline (from the copy), X-Repo-Changes (changes waiting on the phone) and X-Repo-Server
 * (the server answered the worker's last check).
 */

let current = { offline: false, changes: 0, server: false }
const listeners = new Set()

export function setOfflineState(next) {
  const state = { ...current, ...next }
  if (state.offline === current.offline && state.changes === current.changes && state.server === current.server) return
  current = state
  listeners.forEach((listener) => listener())
}

export const setOffline = (value) => setOfflineState(value ? { offline: true } : { offline: false, changes: 0, server: true })

/** The pages show the phone's copy (no connection, or changes waiting to be synced). */
export const isOffline = () => current.offline

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useOffline = () => useSyncExternalStore(subscribe, () => current.offline)

/** { offline, changes, server } */
export const useOfflineState = () => useSyncExternalStore(subscribe, () => current)

/** Pages read again after the changes on the phone changed (undone, or synced). */
export const OFFLINE_CHANGED = 'offline:changed'

/* ---------- The saved copy */

/**
 * What is saved on this phone, or null: { version, saved_at, generated_at, equipment, boxes, groups,
 * vouchers, scan_documents, photos, photos_failed, with_photos, bytes }. A copy saved before
 * version 2 only opens equipment and box pages.
 */
export async function readOfflineMeta() {
  if (!offlineSupported()) return null
  try {
    const response = await caches.match(META_KEY)
    return response ? await response.json() : null
  } catch {
    return null
  }
}

/** Resolves once the worker runs; it saved the app itself while installing. */
function whenActive(registration) {
  if (registration.active) return Promise.resolve()
  const worker = registration.installing || registration.waiting
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve()
      if (worker.state === 'redundant') reject(new Error('service worker install failed'))
    })
  })
}

async function inParallel(items, count, work) {
  let next = 0
  const run = async () => {
    while (next < items.length) await work(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, run))
}

/** The download needs a PIN (it holds vouchers and recipients): the token was refused. */
export class OfflineNeedsPin extends Error {}

/**
 * Downloads everything to this phone (the app, the data, and the photos if asked), with the
 * token of a PIN entered on it (and whose it is). onProgress({ step: 'app' | 'ocr' | 'data' | 'photos', done, total }).
 * clearChanges: the changes kept on the phone were synced.
 * Returns the new meta.
 */
export async function downloadOffline({ token, user, withPhotos, onProgress = () => {}, clearChanges = false }) {
  onProgress({ step: 'app' })
  const registration = await navigator.serviceWorker.register('/sw.js')
  await whenActive(registration)

  // The text reader, so the camera can copy printed numbers without a connection too
  onProgress({ step: 'ocr' })
  await saveOcrFiles()

  onProgress({ step: 'data' })
  // From the server itself, never the phone's copy (X-Repo-Direct, see sw.js)
  const response = await fetch('/api/offline/snapshot', { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-Repo-Direct': '1' }, cache: 'no-store' })
  if (response.status === 401) throw new OfflineNeedsPin()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  const snapshot = JSON.parse(text)

  // Photos: keep the ones still used (their URL changes with the photo), fetch the missing ones
  let photos = 0
  let failed = 0
  if (withPhotos) {
    const cache = await caches.open(PHOTOS)
    const wanted = new Set(snapshot.equipment.map((e) => e.photo_url).filter(Boolean).map((url) => new URL(url, location.origin).href))
    const saved = new Set()
    for (const request of await cache.keys()) {
      if (wanted.has(request.url)) saved.add(request.url)
      else await cache.delete(request)
    }
    const missing = [...wanted].filter((url) => !saved.has(url))
    photos = saved.size
    onProgress({ step: 'photos', done: photos, total: wanted.size })
    await inParallel(missing, PARALLEL, async (url) => {
      try {
        const photo = await fetch(url, { headers: { 'X-Repo-Direct': '1' } })
        if (!photo.ok) throw new Error(`HTTP ${photo.status}`)
        await cache.put(url, photo)
        photos++
      } catch {
        failed++
      }
      onProgress({ step: 'photos', done: photos + failed, total: wanted.size })
    })
  } else {
    await caches.delete(PHOTOS)
  }

  const meta = {
    version: snapshot.version,
    saved_at: new Date().toISOString(),
    generated_at: snapshot.generated_at,
    equipment: snapshot.equipment.length,
    boxes: snapshot.boxes.length,
    groups: snapshot.groups.length,
    vouchers: snapshot.vouchers.list.length,
    scan_documents: Object.keys(snapshot.scan.documents).length,
    photos,
    photos_failed: failed,
    with_photos: withPhotos,
    bytes: new Blob([text]).size,
  }
  const cache = await caches.open(DATA)
  await cache.put(SNAPSHOT_KEY, new Response(text, { headers: { 'Content-Type': 'application/json' } }))
  await cache.put(META_KEY, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }))
  // A new copy starts with no changes (the sync sent them, see offlineSync.js)
  if (clearChanges) await clearSavedChanges(cache)
  registration.active?.postMessage('snapshot-changed')
  // Changes made with this token without a connection are kept under this person's name
  if (user) registration.active?.postMessage({ type: 'token', token, user })

  // Ask the browser not to clear the copy when the phone runs low on space
  try {
    await navigator.storage?.persist?.()
  } catch {
    /* not supported: the copy may be cleared, the page says when it was saved */
  }
  return meta
}

/* ---------- Changes kept on the phone (written by sw.js) */

const CHANGES_KEY = '/__offline__/changes.json'
const FILES = '/__offline__/files/'

/** The changes waiting on this phone, as sw.js keeps them: [{ id, key, at, user, method, path, body, ids }]. */
export async function readSavedChanges() {
  if (!offlineSupported()) return []
  try {
    const response = await (await caches.open(DATA)).match(CHANGES_KEY)
    return response ? (await response.json()).changes || [] : []
  } catch {
    return []
  }
}

/** The copy the changes were made on. */
export async function readSavedCopy() {
  const response = await (await caches.open(DATA)).match(SNAPSHOT_KEY)
  return response ? response.json() : null
}

/** A photo taken with a change ({ file } in its body). */
export async function readSavedFile(file) {
  const response = await (await caches.open(DATA)).match(FILES + file)
  return response ? response.blob() : null
}

async function clearSavedChanges(cache) {
  await cache.delete(CHANGES_KEY)
  for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith(FILES)) await cache.delete(request)
}

/** Removes the copy, the photos, the saved app and the worker from this phone. */
export async function clearOffline() {
  const registration = await navigator.serviceWorker.getRegistration('/')
  for (const key of await caches.keys()) {
    if (key === DATA || key === PHOTOS || key === OCR_CACHE || key.startsWith('repo-shell-')) await caches.delete(key)
  }
  registration?.active?.postMessage('snapshot-changed')
  await registration?.unregister()
  setOffline(false)
}
