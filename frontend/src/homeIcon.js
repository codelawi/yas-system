import { useSyncExternalStore } from 'react'
import { usePhone } from './nav'

/*
 * The system's icon on the phone's home screen (public/manifest.json): it opens the system as an
 * app, with or without a connection. Android's Chrome offers to add it (beforeinstallprompt), and
 * the page asks with its own button instead of Chrome's bar. The iPhone has no such offer: Safari's
 * share menu adds it. There the icon keeps its own data, apart from Safari's.
 */

/** Set once the icon was added from this browser, or the system was opened from it. */
const ADDED_KEY = 'home_icon_added'

let offer = null
let added = readAdded()
let snapshot = { canOffer: false, added }
const listeners = new Set()

function readAdded() {
  try {
    return localStorage.getItem(ADDED_KEY) === '1'
  } catch {
    return false
  }
}

function markAdded() {
  added = true
  try {
    localStorage.setItem(ADDED_KEY, '1')
  } catch {
    /* not remembered */
  }
}

function changed() {
  snapshot = { canOffer: !!offer, added }
  listeners.forEach((listener) => listener())
}

/** Opened from the home screen icon. */
export const openedFromIcon = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true

// iPadOS says it is a Mac: a Mac with a touch screen is an iPad
export const isIphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Keeps Chrome's offer to add the icon for the page's button (called once, in main.jsx). */
export function watchHomeIcon() {
  if (openedFromIcon()) markAdded()
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    offer = event
    changed()
  })
  window.addEventListener('appinstalled', () => {
    offer = null
    markAdded()
    changed()
  })
}

/** Chrome's own dialog for adding the icon. Resolves to true when the person added it. */
export async function addHomeIcon() {
  const event = offer
  if (!event) return false
  // An offer is used once: Chrome makes a new one when the page opens again
  offer = null
  changed()
  await event.prompt()
  const { outcome } = await event.userChoice
  if (outcome === 'accepted') {
    markAdded()
    changed()
  }
  return outcome === 'accepted'
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** { canOffer: Chrome offers to add the icon, added: it was added from this browser }. */
export const useHomeIconState = () => useSyncExternalStore(subscribe, () => snapshot)

/** Whether the page shows how to add the icon: on a phone, outside the icon itself. */
export function useHomeIconHere() {
  const phone = usePhone()
  return phone && !openedFromIcon()
}

/** Whether to offer it after a download: unless it is known to be there already (added from this browser, and Chrome no longer offers it). */
export function useOfferHomeIcon() {
  const here = useHomeIconHere()
  const { canOffer, added } = useHomeIconState()
  return here && (canOffer || !added)
}
