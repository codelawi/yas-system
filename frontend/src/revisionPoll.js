import { useEffect, useRef } from 'react'
import api from './api'

/** How often open screens ask whether something changed (ms). */
const POLL_MS = 1500

/**
 * Live updates without any extra server: every POLL_MS asks `url` for the current revision and calls
 * `onChange` when it differs from `known.current` (the caller sets it after each load).
 * Pauses while the tab is hidden and checks at once when it is shown again; does nothing without a url.
 */
export default function useRevisionPoll(url, known, onChange) {
  const callback = useRef(onChange)
  callback.current = onChange

  useEffect(() => {
    if (!url) return undefined
    let stopped = false
    let busy = false
    const check = async () => {
      if (stopped || busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const { data } = await api.get(url)
        if (!stopped && data.revision !== known.current) {
          known.current = data.revision
          await callback.current()
        }
      } catch {
        /* the server is busy or out of reach: try again next time */
      } finally {
        busy = false
      }
    }
    const timer = setInterval(check, POLL_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [url, known])
}
