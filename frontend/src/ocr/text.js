/**
 * Turning a line read off the equipment into the code to save, and finding it among the
 * system's serial numbers even when the reading mixed up look-alike characters (O / 0, I / 1...).
 */

/**
 * Labels makers print before a number: S/N, Serial No., P/N, Model, Ref, Lot... They are dropped,
 * with the ":" / "#" / "." after them. A label is only taken when a separator or a digit follows
 * (so "SNAP" or "NOTE" stay as they are).
 */
const PREFIX =
  /^(?:S\s*[/.\\]?\s*N\s*O?|SER(?:IAL)?(?:\s*(?:NO|NR|NUMBER|#))?|P\s*[/.\\]?\s*N|PART\s*(?:NO|NR|NUMBER|#)?|MODEL(?:\s*(?:NO|NR|#))?|MOD|REF(?:ERENCE)?|LOT(?:\s*(?:NO|NR|#))?|BATCH|ART(?:ICLE)?(?:\s*(?:NO|NR|#))?|CAT(?:\s*(?:NO|NR|#))?|TYPE|ID|NO|NR)(?=[\s.:#\-/]|\d)[\s.:#\-/]*/i

/** The line cleaned: one space between words, no stray marks at either end, no maker's label. */
export function cleanLine(text) {
  let line = String(text).replace(/\s+/g, ' ').trim()
  line = line.replace(/^[\s|.,:;'"`~_-]+|[\s|.,:;'"`~_-]+$/g, '')
  const stripped = line.replace(PREFIX, '').trim()
  return stripped || line
}

/** The words of a cleaned line, when there are several (a line can hold more than one number). */
export function lineParts(line) {
  const parts = line.split(' ').filter((p) => p.length >= 2)
  return parts.length > 1 ? parts : []
}

/** Look-alike characters read as one: what each becomes. */
const LOOK_ALIKE = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', '!': '1', Z: '2', S: '5', G: '6', B: '8' }

/** A code reduced so readings that differ only by look-alikes, case, spaces or dashes compare equal. */
export function canonical(text) {
  let out = ''
  for (const ch of String(text).toUpperCase()) {
    if (/[\s\-./:_]/.test(ch)) continue
    out += LOOK_ALIKE[ch] ?? ch
  }
  return out
}

/** Codes shorter than this are only matched exactly (too many short numbers look alike). */
const MIN_FUZZY = 6

/**
 * Index of the system's serial numbers for matchSerial.
 * @param serials string[]
 */
export function serialIndex(serials) {
  const byCanonical = new Map()
  const exact = new Map()
  for (const serial of serials) {
    if (!serial) continue
    exact.set(String(serial).trim().toLowerCase(), serial)
    const key = canonical(serial)
    if (!key) continue
    if (!byCanonical.has(key)) byCanonical.set(key, new Set())
    byCanonical.get(key).add(serial)
  }
  return { exact, byCanonical, keys: [...byCanonical.keys()].filter((k) => k.length >= MIN_FUZZY) }
}

/**
 * The serial number a reading is, if the system has it:
 *   { serial, how: 'exact' }   the same text
 *   { serial, how: 'similar' } the same once look-alikes, case and spaces are set aside
 *   { serial, how: 'inside' }  the reading holds it (e.g. two numbers printed together)
 *   { serial, how: 'near' }    one character different (only for long codes, when only one is near)
 * or null.
 */
export function matchSerial(text, index) {
  if (!index || !text) return null
  const exact = index.exact.get(text.trim().toLowerCase())
  if (exact) return { serial: exact, how: 'exact' }

  const key = canonical(text)
  if (!key) return null
  const same = index.byCanonical.get(key)
  if (same?.size === 1) return { serial: [...same][0], how: 'similar' }
  if (same?.size > 1) return null // look-alikes of several serials: let the user choose by typing

  if (key.length >= MIN_FUZZY) {
    let inside = null
    for (const k of index.keys) {
      if (k.length < key.length && key.includes(k) && (!inside || k.length > inside.length)) inside = k
    }
    if (inside && index.byCanonical.get(inside).size === 1) return { serial: [...index.byCanonical.get(inside)][0], how: 'inside' }
  }

  if (key.length >= 8) {
    let found = null
    for (const k of index.keys) {
      if (Math.abs(k.length - key.length) > 1 || !withinOneEdit(k, key)) continue
      if (found) return null // two serials are near: not sure which
      found = k
    }
    if (found && index.byCanonical.get(found).size === 1) return { serial: [...index.byCanonical.get(found)][0], how: 'near' }
  }
  return null
}

/** True when b is a with at most one character changed, added or removed. */
function withinOneEdit(a, b) {
  if (a === b) return true
  if (a.length > b.length) [a, b] = [b, a]
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.slice(i) === b.slice(i + 1)
}
