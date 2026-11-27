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
export function compareText(a, b) {
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
})

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
    })),
  }
}

function boxList(copy, query) {
  const q = (query.get('q') || '').trim()
  return copy.data.boxes
    .filter((b) => q === '' || has(b.number, pattern(q)) || has(b.name, pattern(q)))
    .sort((a, b) => naturalCompare(a.number, b.number))
    .map((b) => ({ id: b.id, number: b.number, name: b.name, weight: b.weight, equipment_count: b.equipment.length, updated_at: b.updated_at }))
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
export function openCopy(data) {
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
export function findRoute(url) {
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
export async function findUserByPin(users, pin) {
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
