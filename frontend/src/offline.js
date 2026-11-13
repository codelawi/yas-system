import { useSyncExternalStore } from 'react'

/*
 * Working without a connection: the "Work offline" page saves a copy of everything on the
 * phone, and the service worker (sw.js) answers the scan pages from it when the server
 * cannot be reached. Browsers only run service workers on https (or localhost).
 */

// Keep these names in sync with sw.js
const DATA = 'repo-offline-data'
const PHOTOS = 'repo-offline-photos'
const SNAPSHOT_KEY = '/__offline__/snapshot.json'
const META_KEY = '/__offline__/meta.json'

/** Photos downloaded at the same time. */
const PARALLEL = 4

export const offlineSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'caches' in window

/* ---------- Is the data on screen from the saved copy? (set by api.js from the worker's X-Repo-Offline header) */

let offline = false
const listeners = new Set()

export function setOffline(value) {
  if (offline === value) return
  offline = value
  listeners.forEach((listener) => listener())
}

export const isOffline = () => offline

export const useOffline = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => offline,
  )

/* ---------- The saved copy */

/** What is saved on this phone: { saved_at, generated_at, equipment, boxes, photos, photos_failed, with_photos, bytes }, or null. */
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

/**
 * Downloads everything to this phone (the app, the data, and the photos if asked).
 * onProgress({ step: 'app' | 'data' | 'photos', done, total }). Returns the new meta.
 */
export async function downloadOffline({ withPhotos, onProgress = () => {} }) {
  onProgress({ step: 'app' })
  const registration = await navigator.serviceWorker.register('/sw.js')
  await whenActive(registration)

  onProgress({ step: 'data' })
  const response = await fetch('/api/offline/snapshot', { headers: { Accept: 'application/json' }, cache: 'no-store' })
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
        const photo = await fetch(url)
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
    saved_at: new Date().toISOString(),
    generated_at: snapshot.generated_at,
    equipment: snapshot.equipment.length,
    boxes: snapshot.boxes.length,
    photos,
    photos_failed: failed,
    with_photos: withPhotos,
    bytes: new Blob([text]).size,
  }
  const cache = await caches.open(DATA)
  await cache.put(SNAPSHOT_KEY, new Response(text, { headers: { 'Content-Type': 'application/json' } }))
  await cache.put(META_KEY, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }))
  registration.active?.postMessage('snapshot-changed')

  // Ask the browser not to clear the copy when the phone runs low on space
  try {
    await navigator.storage?.persist?.()
  } catch {
    /* not supported: the copy may be cleared, the page says when it was saved */
  }
  return meta
}

/** Removes the copy, the photos, the saved app and the worker from this phone. */
export async function clearOffline() {
  const registration = await navigator.serviceWorker.getRegistration('/')
  for (const key of await caches.keys()) {
    if (key === DATA || key === PHOTOS || key.startsWith('repo-shell-')) await caches.delete(key)
  }
  registration?.active?.postMessage('snapshot-changed')
  await registration?.unregister()
  setOffline(false)
}
