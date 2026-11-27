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
import { compareText, compareValues, groupKey, has, pattern, same } from './offlineData'

/** What a phone adds gets ids from here on, far above the server's own; it gets real ones when it syncs. */
export const TEMP_ID = 1_000_000_000
export const isTempId = (id) => Number(id) >= TEMP_ID

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
export function normalizeName(text) {
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
export const groupNameKey = (name) => Array.from(normalizeName(name)).slice(0, 191).join('')

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
export function fieldDiff(before, after, extraBefore = {}, extraAfter = {}) {
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
export const laravelTime = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, '.000000Z')

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
export function toModel(data) {
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
    ...scanRecords(data.scan),
    ...voucherRecords(data.vouchers),
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
export function fromModel(m, notes = null) {
  const byId = (a, b) => a.id - b.id
  const equipment = [...m.equipment.values()].sort(byId)
  m.index = { children: new Map(), boxes: new Map(), rows: new Map() }
  for (const r of [...m.scanRows.values()].sort(byPosition)) {
    if (!m.index.rows.has(r.scan_document_id)) m.index.rows.set(r.scan_document_id, [])
    m.index.rows.get(r.scan_document_id).push(r)
  }
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
  if (m.data.scan) data.scan = scanPages(m, notes)
  if (m.vouchers) data.vouchers = voucherData(m, notes)
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
export const equipmentLabel = label

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
export const equipmentState = (e) => ({ serial_number: e.serial_number, name: e.name, row_no: e.row_no, category: e.category, group_id: e.group_id, fields: e.fields.map((f) => ({ ...f })) })

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
export const LARGE_DELETE = 5

/** How many equipment a delete request takes away (the PIN is asked above LARGE_DELETE). */
export function deleteCount(m, method, path, input) {
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
  departUnit(m, e)
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
export const localPhotoUrl = (id, file) => `/api/equipment/${id}/photo?v=${file.slice(0, 8)}`
export const localIssuePhotoUrl = (id) => `/api/issues/${id}/photo`

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
export const groupState = (g) => ({ name: g.name, voucher_code: g.voucher_code, voucher_name: g.voucher_name })

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
export const boxState = (b) => ({ number: b.number, name: b.name, weight: b.weight })

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

/* Scan documents (ScanFolderController, ScanDocumentController) */

/** ScanDocument::BUILT_IN_COLUMNS, DUPLICATE_SCOPES, defaultColumns */
const SCAN_BUILT_IN = ['no', 'code', 'scanned_at', 'notes']
const SCAN_SCOPES = ['document', 'folder']
const SCAN_DEFAULT_COLUMNS = [
  { key: 'no', label: 'ت' },
  { key: 'code', label: 'النص الممسوح' },
  { key: 'scanned_at', label: 'وقت المسح' },
  { key: 'notes', label: 'ملاحظات' },
]
/** The photo of a line read by the camera's text mode ('photo' => 'max:4096', 'mimes:jpg,jpeg,png,webp') */
const SCAN_PHOTO_TYPES = /^image\/(jpe?g|png|webp)$/
const SCAN_PHOTO_NAMES = /\.(jpe?g|png|webp)$/i
const MAX_SCAN_PHOTO = 4096 * 1024

/** A row of the copy (ScanDocumentController::full) as the records keep it. */
export function scanRowFrom(r) {
  return {
    id: r.id,
    scan_document_id: r.scan_document_id,
    position: r.position,
    code: r.code ?? null,
    cells: Array.isArray(r.cells) || !r.cells ? [] : { ...r.cells },
    scanned_at: r.scanned_at ?? null,
    scanned_by: typeof r.scanned_by === 'object' ? (r.scanned_by?.id ?? null) : (r.scanned_by ?? null),
    scanner: typeof r.scanned_by === 'object' ? (r.scanned_by ?? null) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    photo_url: r.photo_url ?? null,
  }
}

function scanRecords(scan) {
  const folders = new Map()
  const documents = new Map()
  const rows = new Map()
  for (const { folder: f } of Object.values(scan?.folder_pages || {})) {
    folders.set(f.id, { id: f.id, name: f.name, revision: f.revision, creator: f.created_by ?? null, updated_by: f.updated_by, created_at: f.created_at, updated_at: f.updated_at })
  }
  for (const { document: d, rows: list } of Object.values(scan?.documents || {})) {
    documents.set(d.id, {
      id: d.id,
      scan_folder_id: d.scan_folder_id,
      title: d.title,
      columns: (d.columns || []).map((c) => ({ ...c })),
      duplicate_scope: d.duplicate_scope,
      revision: d.revision,
      creator: d.created_by ?? null,
      updated_by: d.updated_by,
      created_at: d.created_at,
      updated_at: d.updated_at,
    })
    for (const r of list) rows.set(r.id, scanRowFrom(r))
  }
  return { scanFolders: folders, scanDocuments: documents, scanRows: rows }
}

const byPosition = (a, b) => a.position - b.position || a.id - b.id
/** A document's rows, in the table's order (ScanDocument::rows). */
const rowsOf = (m, d) => (m.index?.rows ? m.index.rows.get(d.id) || [] : [...m.scanRows.values()].filter((r) => r.scan_document_id === d.id).sort(byPosition))
const documentsOf = (m, f) => [...m.scanDocuments.values()].filter((d) => d.scan_folder_id === f.id)
const who = (user) => (user ? { id: user.id, name: user.name } : null)
/** A database time (withMax): Y-m-d H:i:s */
const dbTime = (time) => time.slice(0, 19).replace('T', ' ')

const presentScanFolder = (f) => ({ id: f.id, name: f.name, revision: f.revision, created_by: f.creator, updated_by: f.updated_by, created_at: f.created_at, updated_at: f.updated_at })
const presentScanDocument = (d) => ({
  id: d.id,
  scan_folder_id: d.scan_folder_id,
  title: d.title,
  columns: d.columns.map((c) => ({ ...c })),
  duplicate_scope: d.duplicate_scope,
  revision: d.revision,
  created_by: d.creator,
  updated_by: d.updated_by,
  created_at: d.created_at,
  updated_at: d.updated_at,
})
/** A row as a page lists it (scannedBy loaded), or as the model itself answers (scanned_by an id). */
function presentScanRow(r, notes, loaded = true) {
  return {
    id: r.id,
    scan_document_id: r.scan_document_id,
    position: r.position,
    code: r.code,
    cells: Array.isArray(r.cells) ? [] : { ...r.cells },
    scanned_at: r.scanned_at,
    scanned_by: loaded ? r.scanner : r.scanned_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    photo_url: r.photo_url,
    ...markOf(notes, 'scan_row', r.id),
  }
}

/** ScanDocumentController::full */
function scanDocumentPage(m, d, notes) {
  const folder = m.scanFolders.get(d.scan_folder_id)
  return {
    document: { ...presentScanDocument(d), folder: folder ? { id: folder.id, name: folder.name } : null, ...notesFor(notes, 'scan_document', d.id) },
    rows: rowsOf(m, d).map((r) => presentScanRow(r, notes)),
  }
}

/** A folder is marked when a document in it is. */
function folderMark(notes, m, f) {
  const own = markOf(notes, 'scan_folder', f.id)
  if (own.offline || !notes) return own
  return documentsOf(m, f).some((d) => notes.marks.has(`scan_document:${d.id}`)) ? { offline: 'changed' } : {}
}

const revisionOf = (list) => `${list.length}:${list.reduce((sum, x) => sum + x.revision, 0)}:${list.reduce((max, x) => Math.max(max, x.id), 0)}`

/** The scan documents part of the copy (OfflineController::scanDocuments). */
function scanPages(m, notes) {
  const folders = [...m.scanFolders.values()].sort((a, b) => a.id - b.id)
  const documents = [...m.scanDocuments.values()].sort((a, b) => a.id - b.id)
  const folderPages = {}
  const folderRevisions = {}
  const listed = []
  for (const f of folders) {
    const docs = documentsOf(m, f)
    const newest = [...docs].sort((a, b) => (b.updated_at > a.updated_at) - (b.updated_at < a.updated_at) || b.id - a.id)
    folderPages[f.id] = {
      folder: { ...presentScanFolder(f), ...folderMark(notes, m, f) },
      documents: newest.map((d) => ({ ...presentScanDocument(d), rows_count: rowsOf(m, d).length, ...markOf(notes, 'scan_document', d.id) })),
    }
    folderRevisions[f.id] = `${f.revision}/${revisionOf(docs)}`
    const changed = docs.reduce((max, d) => (max == null || d.updated_at > max ? d.updated_at : max), null)
    listed.push({
      ...presentScanFolder(f),
      documents_count: docs.length,
      rows_count: docs.reduce((sum, d) => sum + rowsOf(m, d).length, 0),
      documents_max_updated_at: changed && dbTime(changed),
      last_change_at: laravelTime(changed && changed > f.updated_at ? changed : f.updated_at),
      ...folderMark(notes, m, f),
    })
  }
  const pages = {}
  for (const d of documents) pages[d.id] = scanDocumentPage(m, d, notes)
  return {
    // The most recently used first (sortByDesc keeps the database's order between equals)
    folders: listed.sort((a, b) => (b.last_change_at > a.last_change_at) - (b.last_change_at < a.last_change_at)),
    revision: `${revisionOf(folders)}/${revisionOf(documents)}`,
    folder_pages: folderPages,
    folder_revisions: folderRevisions,
    documents: pages,
  }
}

function scanFolderOr404(m, id) {
  return m.scanFolders.get(Number(id)) ?? notFound()
}

function scanDocumentOr404(m, id) {
  return m.scanDocuments.get(Number(id)) ?? notFound()
}

/** ScanDocumentController::validColumns */
function validColumns(columns) {
  const clean = new Map()
  for (const column of columns) {
    const isMap = !!column && typeof column === 'object' && !Array.isArray(column)
    const key = isMap ? String(column.key ?? '') : ''
    const label = isMap ? phpTrim(String(column.label ?? '')) : ''
    const known = SCAN_BUILT_IN.includes(key) || /^c_[a-z0-9]{1,20}$/.test(key)
    if (!known || label === '' || length(label) > 100 || clean.has(key)) invalid('columns', 'scan_doc_bad_columns')
    clean.set(key, { key, label })
  }
  if (!clean.has('code') || clean.size > 30) invalid('columns', 'scan_doc_bad_columns')
  return [...clean.values()]
}

/** ScanDocument::cellKeys: the columns typed by hand */
const cellKeys = (d) => d.columns.map((c) => c.key).filter((key) => !['no', 'code', 'scanned_at'].includes(key))

/** ScanDocument::duplicateCandidates: the rows a scanned code must not repeat in. */
function scanCandidates(m, d) {
  if (d.duplicate_scope === 'folder' && d.scan_folder_id) {
    const inFolder = new Set(documentsOf(m, m.scanFolders.get(d.scan_folder_id) || { id: d.scan_folder_id }).map((x) => x.id))
    return [...m.scanRows.values()].filter((r) => inFolder.has(r.scan_document_id)).sort((a, b) => a.id - b.id)
  }
  return rowsOf(m, d)
}

const nextPosition = (m, d) => rowsOf(m, d).reduce((max, r) => Math.max(max, r.position), 0) + 1
/** The row's number (ت) as the table shows it. */
const rowNumber = (m, d, row) => rowsOf(m, d).filter((r) => r.position < row.position || (r.position === row.position && r.id <= row.id)).length

/** The address a line photo taken on the phone is known by (the pages do not show it). */
export const localScanPhotoUrl = (documentId, rowId, file) => `/api/scan-documents/${documentId}/rows/${rowId}/photo?v=${file.slice(0, 8)}`

function scanFolderName(input) {
  check('name', input.name, { required: true, max: 191 })
  return phpTrim(input.name)
}

/** What a folder, document and row hold that their pages edit: compared before and after (sync). */
export const scanFolderState = (f) => ({ name: f.name })
export const scanDocumentState = (d) => ({ title: d.title, duplicate_scope: d.duplicate_scope, scan_folder_id: d.scan_folder_id, fields: d.columns.map((c) => ({ key: c.key, value: c.label })) })
/** A row's cells as fields (an empty cell is no field). */
export const scanRowState = (r) => ({
  code: r.code,
  scan_document_id: r.scan_document_id,
  fields: Object.entries(Array.isArray(r.cells) ? {} : r.cells)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
})

function storeScanFolder(m, input, ctx) {
  const name = scanFolderName(input)
  const f = { id: ctx.newId(), name, revision: 0, creator: who(ctx.user), updated_by: ctx.user?.id ?? null, created_at: ctx.at, updated_at: ctx.at }
  m.scanFolders.set(f.id, f)
  ctx.mark('scan_folder', f.id, 'new')
  // The server's answer has no revision: the database fills it in
  const { revision, ...shown } = presentScanFolder(f)
  void revision
  return { status: 201, body: { ...shown, documents_count: 0, rows_count: 0 }, effect: { kind: 'scan_folder_created', label: name } }
}

function updateScanFolder(m, input, ctx, id) {
  const f = scanFolderOr404(m, id)
  const name = scanFolderName(input)
  const before = f.name
  Object.assign(f, { name, updated_by: ctx.user?.id ?? null, revision: f.revision + 1, updated_at: ctx.at })
  ctx.mark('scan_folder', f.id)
  return { body: presentScanFolder(f), effect: { kind: 'scan_folder_updated', label: name, from: before !== name ? before : undefined } }
}

function deleteScanFolder(m, input, ctx, id) {
  const f = scanFolderOr404(m, id)
  const docs = documentsOf(m, f)
  for (const d of docs) {
    for (const r of rowsOf(m, d)) m.scanRows.delete(r.id)
    m.scanDocuments.delete(d.id)
  }
  m.scanFolders.delete(f.id)
  ctx.mark('scan_folder', f.id)
  return { status: 204, effect: { kind: 'scan_folder_deleted', label: f.name, n: docs.length } }
}

function storeScanDocument(m, input, ctx) {
  check('scan_folder_id', input.scan_folder_id, { required: true, integer: true })
  const folder = m.scanFolders.get(Number(input.scan_folder_id)) ?? invalid('scan_folder_id')
  check('title', input.title, { required: true, max: 191 })
  if (input.columns != null && !Array.isArray(input.columns)) invalid('columns')
  if ('duplicate_scope' in input && !SCAN_SCOPES.includes(input.duplicate_scope)) invalid('duplicate_scope')
  const d = {
    id: ctx.newId(),
    scan_folder_id: folder.id,
    title: input.title,
    columns: input.columns != null ? validColumns(input.columns) : SCAN_DEFAULT_COLUMNS.map((c) => ({ ...c })),
    duplicate_scope: input.duplicate_scope ?? 'document',
    revision: 0,
    creator: who(ctx.user),
    updated_by: ctx.user?.id ?? null,
    created_at: ctx.at,
    updated_at: ctx.at,
  }
  m.scanDocuments.set(d.id, d)
  ctx.mark('scan_document', d.id, 'new')
  const { revision, ...shown } = presentScanDocument(d)
  void revision
  return { status: 201, body: { ...shown, rows_count: 0 }, effect: { kind: 'scan_document_created', label: d.title, folder: folder.name } }
}

function updateScanDocument(m, input, ctx, id) {
  const d = scanDocumentOr404(m, id)
  if ('title' in input) check('title', input.title, { required: true, max: 191 })
  if ('columns' in input && !Array.isArray(input.columns)) invalid('columns')
  if ('duplicate_scope' in input && !SCAN_SCOPES.includes(input.duplicate_scope)) invalid('duplicate_scope')
  const columns = 'columns' in input ? validColumns(input.columns) : d.columns
  const before = { title: d.title, columns: JSON.stringify(d.columns), scope: d.duplicate_scope }
  if ('title' in input) d.title = input.title
  d.columns = columns
  if ('duplicate_scope' in input) d.duplicate_scope = input.duplicate_scope
  Object.assign(d, { updated_by: ctx.user?.id ?? null, revision: d.revision + 1, updated_at: ctx.at })
  ctx.mark('scan_document', d.id)
  const kind =
    before.title !== d.title ? 'scan_document_renamed' : before.columns !== JSON.stringify(d.columns) ? 'scan_columns_changed' : before.scope !== d.duplicate_scope ? 'scan_scope_changed' : 'scan_document_updated'
  return { body: scanDocumentPage(m, d), effect: { kind, label: d.title, from: before.title, scope: d.duplicate_scope } }
}

function deleteScanDocument(m, input, ctx, id) {
  const d = scanDocumentOr404(m, id)
  const rows = rowsOf(m, d)
  for (const r of rows) m.scanRows.delete(r.id)
  m.scanDocuments.delete(d.id)
  ctx.mark('scan_document', d.id)
  if (m.scanFolders.has(d.scan_folder_id)) ctx.mark('scan_folder', d.scan_folder_id)
  return { status: 204, effect: { kind: 'scan_document_deleted', label: d.title, n: rows.length } }
}

function scanPhoto(photo) {
  if (!photo?.file) invalid('photo')
  if (photo.size > MAX_SCAN_PHOTO || !(SCAN_PHOTO_TYPES.test(photo.type || '') || SCAN_PHOTO_NAMES.test(photo.name || ''))) invalid('photo')
}

/** The answer's row: the model itself, without its scannedBy (ScanDocumentController::scan). */
const createdRow = (r) => ({
  position: r.position,
  code: r.code,
  cells: [],
  scanned_at: r.scanned_at,
  scanned_by: r.scanned_by,
  scan_document_id: r.scan_document_id,
  updated_at: r.updated_at,
  created_at: r.created_at,
  id: r.id,
  photo_url: r.photo_url,
})

function scanCode(m, input, ctx, id) {
  const d = scanDocumentOr404(m, id)
  check('code', input.code, { required: true, max: 500 })
  if (input.photo != null) scanPhoto(input.photo)
  const code = phpTrim(input.code)
  if (code === '') invalid('code', 'scan_empty')
  const existing = scanCandidates(m, d).find((r) => same(r.code, code))
  if (existing) {
    // Kept on the phone it was new: made again after an undo, it no longer is
    if (ctx.replay) throw new Refusal(409, { message: 'scan_duplicate' })
    const where = m.scanDocuments.get(existing.scan_document_id)
    const row = presentScanRow(existing, null, false)
    // In another document of the folder: the server loaded it on the row
    if (where.id !== d.id) row.document = { ...presentScanDocument(where), created_by: where.creator?.id ?? null }
    return { body: { status: 'duplicate', row, row_number: rowNumber(m, where, existing), document: { id: where.id, title: where.title } }, effect: null }
  }
  const rowId = ctx.newId()
  const row = {
    id: rowId,
    scan_document_id: d.id,
    position: nextPosition(m, d),
    code,
    cells: [],
    scanned_at: ctx.at,
    scanned_by: ctx.user?.id ?? null,
    scanner: who(ctx.user),
    created_at: ctx.at,
    updated_at: ctx.at,
    photo_url: input.photo ? localScanPhotoUrl(d.id, rowId, input.photo.file) : null,
  }
  m.scanRows.set(row.id, row)
  Object.assign(d, { revision: d.revision + 1, updated_at: ctx.at })
  ctx.mark('scan_row', row.id, 'new')
  ctx.mark('scan_document', d.id)
  return { body: { status: 'added', row: createdRow(row), row_number: rowNumber(m, d, row), document: { id: d.id, title: d.title } }, effect: { kind: 'scan_code_added', label: d.title, code } }
}

function addScanRow(m, input, ctx, id) {
  const d = scanDocumentOr404(m, id)
  const row = { id: ctx.newId(), scan_document_id: d.id, position: nextPosition(m, d), code: null, cells: [], scanned_at: null, scanned_by: null, scanner: null, created_at: ctx.at, updated_at: ctx.at, photo_url: null }
  m.scanRows.set(row.id, row)
  Object.assign(d, { revision: d.revision + 1, updated_at: ctx.at })
  ctx.mark('scan_row', row.id, 'new')
  ctx.mark('scan_document', d.id)
  const { position, cells, scan_document_id, updated_at, created_at, id: rowId, photo_url } = row
  return { status: 201, body: { position, cells, scan_document_id, updated_at, created_at, id: rowId, photo_url }, effect: { kind: 'scan_row_added', label: d.title } }
}

function scanRowOr404(m, d, rowId) {
  const row = m.scanRows.get(Number(rowId))
  if (!row || row.scan_document_id !== d.id) notFound()
  return row
}

function updateScanRow(m, input, ctx, id, rowId) {
  const d = scanDocumentOr404(m, id)
  const row = scanRowOr404(m, d, rowId)
  if ('code' in input) check('code', input.code, { max: 500 })
  if ('cells' in input) {
    if (!input.cells || typeof input.cells !== 'object' || input.cells.file) invalid('cells')
    for (const [key, value] of Object.entries(input.cells)) check(`cells.${key}`, value, { max: 2000 })
  }
  const before = JSON.stringify([row.code, row.cells])
  const label = row.code
  if ('code' in input) {
    const code = phpTrim(String(input.code ?? '')) || null
    if (code !== null && scanCandidates(m, d).some((r) => r.id !== row.id && same(r.code, code))) invalid('code', d.duplicate_scope === 'folder' ? 'scan_duplicate_folder' : 'scan_duplicate')
    row.code = code
  }
  if ('cells' in input && !Array.isArray(input.cells)) {
    const allowed = cellKeys(d)
    const cells = Array.isArray(row.cells) ? {} : { ...row.cells }
    for (const [key, value] of Object.entries(input.cells)) if (allowed.includes(key)) cells[key] = value
    row.cells = Object.keys(cells).length ? cells : []
  }
  if (JSON.stringify([row.code, row.cells]) !== before) row.updated_at = ctx.at
  Object.assign(d, { revision: d.revision + 1, updated_at: ctx.at })
  ctx.mark('scan_row', row.id)
  ctx.mark('scan_document', d.id)
  return { body: presentScanRow(row, null, false), effect: { kind: 'scan_row_updated', label: d.title, code: row.code ?? label } }
}

function deleteScanRow(m, input, ctx, id, rowId) {
  const d = scanDocumentOr404(m, id)
  const row = scanRowOr404(m, d, rowId)
  m.scanRows.delete(row.id)
  Object.assign(d, { revision: d.revision + 1, updated_at: ctx.at })
  ctx.mark('scan_row', row.id)
  ctx.mark('scan_document', d.id)
  return { status: 204, effect: { kind: 'scan_row_deleted', label: d.title, code: row.code } }
}

/* Issue vouchers (VoucherController, VoucherRows, App\Models\Voucher) */

const DRAFT = 'draft'
const ISSUED = 'issued'
const RETURNED = 'returned'
/** VoucherController::MAX_COPIES */
const MAX_COPIES = 20
/** A print asked for on the phone: the print station prints it at the end of the sync. */
export const PRINT_AT_SYNC = 'waiting_sync'

/** The rows of the copy (OfflineController::vouchers), and what deleted equipment showed on its vouchers. */
function voucherRecords(v) {
  if (!v?.records) return {}
  const pages = v.pages || {}
  const vouchers = new Map()
  for (const r of v.records.vouchers) {
    const page = pages[r.id]?.voucher
    vouchers.set(r.id, { ...r, fields: r.fields ?? null, layout: r.layout ?? null, creator: page?.creator ?? null, issuer: page?.issuer ?? null, last_print: page?.last_print ?? null })
  }
  const departed = new Map()
  for (const page of Object.values(pages)) {
    const rows = new Map(page.rows.map((r) => [r.key, r]))
    for (const item of page.items) {
      if (!item.equipment.deleted || departed.has(item.equipment.id)) continue
      const { deleted, ...brief } = item.equipment
      void deleted
      departed.set(brief.id, { brief, key: item.row_key, code: rows.get(item.row_key)?.code ?? null, accessory: item.row_key.startsWith('a:'), accessories: item.accessories })
    }
  }
  return {
    vouchers,
    voucherItems: new Map(v.records.items.map((i) => [i.id, { ...i }])),
    custodies: new Map(v.records.custodies.map((c) => [c.id, { ...c }])),
    departed,
    voucherSettings: {
      templates: (v.templates || []).map((t) => ({ ...t })),
      layouts: v.layouts || {},
      last_fields: { ...(v.last_fields || {}) },
      copies: v.copies ?? 1,
      number_from: v.number_from ?? 0,
    },
  }
}

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة']
const TENS = ['', 'عشرة', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون']
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة']

function belowHundred(n) {
  if (n < 10) return ONES[n]
  if (n === 10) return 'عشرة'
  if (n === 11) return 'أحد عشر'
  if (n === 12) return 'اثنا عشر'
  if (n < 20) return `${ONES[n - 10]} عشر`
  if (n % 10 === 0) return TENS[n / 10]
  return `${ONES[n % 10]} و${TENS[Math.floor(n / 10)]}`
}

function belowThousand(n) {
  const parts = []
  if (n >= 100) {
    parts.push(HUNDREDS[Math.floor(n / 100)])
    n %= 100
  }
  if (n > 0) parts.push(belowHundred(n))
  return parts.join(' و')
}

/** ArabicNumber::words: 2 → «اثنان» */
export function arabicWords(n) {
  if (n <= 0) return 'صفر'
  if (n >= 1000000) return String(n)
  const thousands = Math.floor(n / 1000)
  const rest = n % 1000
  const parts = []
  if (thousands > 0) parts.push(thousands === 1 ? 'ألف' : thousands === 2 ? 'ألفان' : thousands <= 10 ? `${belowThousand(thousands)} آلاف` : `${belowThousand(thousands)} ألف`)
  if (rest > 0) parts.push(belowThousand(rest))
  return parts.join(' و')
}

const byId = (a, b) => a.id - b.id
const isOpen = (c) => c && c.returned_at == null

/** VoucherRows::name: the group's voucher name for main equipment, else its own name (or serial). */
function rowName(m, e) {
  const group = e.parent_id == null && e.group_id != null ? m.groups.get(e.group_id) : null
  if (group) {
    const own = phpTrim(group.voucher_name ?? '')
    return truthy(own) ? own : group.name
  }
  const name = phpTrim(displayName(m, e) ?? '')
  return truthy(name) ? name : String(e.serial_number ?? '')
}

/** VoucherRows::key: units with the same key share a line. */
function rowKey(m, e) {
  if (e.parent_id == null) return e.group_id != null ? `g:${e.group_id}` : `n:${groupNameKey(rowName(m, e))}`
  const parent = m.equipment.get(e.parent_id)
  const parentKey = parent ? rowKey(m, parent) : (m.departed?.get(e.parent_id)?.key ?? `p:${e.parent_id}`)
  return `a:${parentKey}|${groupNameKey(rowName(m, e))}`
}

/** VoucherController::brief */
function voucherBrief(m, e) {
  const parent = e.parent_id != null ? m.equipment.get(e.parent_id) : null
  const parentSerial = parent ? parent.serial_number : e.parent_id != null ? (m.departed?.get(e.parent_id)?.brief.serial_number ?? null) : null
  return { id: e.id, serial_number: e.serial_number, display_name: rowName(m, e), parent_serial: parentSerial }
}

/** What a voucher shows of a unit: the equipment, or what it was when it was deleted. */
function unitOf(m, id) {
  const e = m.equipment.get(id)
  if (!e) {
    const gone = m.departed?.get(id)
    return gone ? { ...gone, deleted: true } : null
  }
  const main = e.parent_id == null
  return {
    brief: voucherBrief(m, e),
    key: rowKey(m, e),
    code: main && e.group_id != null ? (m.groups.get(e.group_id)?.voucher_code ?? null) : null,
    accessory: !main,
    accessories: main
      ? children(m, e)
          .sort((a, b) => compareValues(a.name, b.name) || compareValues(a.serial_number, b.serial_number) || a.id - b.id)
          .map((a) => ({ id: a.id, serial_number: a.serial_number, display_name: rowName(m, a) }))
      : [],
    deleted: false,
  }
}

/** Deleted on the phone: its vouchers still show it as it was. */
function departUnit(m, e) {
  if (!m.voucherItems || ![...m.voucherItems.values()].some((i) => i.equipment_id === e.id)) return
  const { deleted, ...unit } = unitOf(m, e.id)
  void deleted
  m.departed.set(e.id, unit)
}

/** Items by voucher and custody by equipment, in id order, while pages are put together. */
function voucherIndex(m) {
  const items = new Map()
  const custodies = new Map()
  const replacement = new Map()
  for (const i of [...m.voucherItems.values()].sort(byId)) {
    if (!items.has(i.voucher_id)) items.set(i.voucher_id, [])
    items.get(i.voucher_id).push(i)
  }
  for (const c of [...m.custodies.values()].sort(byId)) {
    if (!custodies.has(c.equipment_id)) custodies.set(c.equipment_id, [])
    custodies.get(c.equipment_id).push(c)
  }
  for (const v of [...m.vouchers.values()].sort(byId)) if (v.replaces_id != null && !replacement.has(v.replaces_id)) replacement.set(v.replaces_id, v.id)
  return { items: (v) => items.get(v.id) || [], custodies: (id) => custodies.get(id) || [], replacement }
}

const itemsOfVoucher = (m, v) => [...m.voucherItems.values()].filter((i) => i.voucher_id === v.id).sort(byId)
const custodiesOfVoucher = (m, v) => [...m.custodies.values()].filter((c) => c.voucher_id === v.id).sort(byId)
const custodyOf = (m, item) => (item.custody_id != null ? (m.custodies.get(item.custody_id) ?? null) : null)
const numberOf = (m, voucherId) => (voucherId != null ? (m.vouchers.get(voucherId)?.number ?? null) : null)
/** An empty array is saved as [] (JSON): it comes back as a list. */
const fieldsOut = (fields) => (fields && typeof fields === 'object' && !Array.isArray(fields) && !Object.keys(fields).length ? [] : fields)

/** VoucherController::heldElsewhere: open custody of these equipment that is not this voucher's own. */
function heldElsewhere(m, v, equipmentIds) {
  const own = [v.id, v.replaces_id].filter((id) => id != null)
  const ids = new Set(equipmentIds)
  return [...m.custodies.values()].filter((c) => isOpen(c) && ids.has(c.equipment_id) && (c.voucher_id == null || !own.includes(c.voucher_id))).sort(byId)
}

function heldList(m, held) {
  return held.map((c) => ({ ...(unitOf(m, c.equipment_id)?.brief ?? { id: c.equipment_id }), holder: c.holder, voucher_number: numberOf(m, c.voucher_id) }))
}

/** VoucherController::movedTo: units another voucher took, by item. */
function movedTo(m, ix, v, items) {
  const moved = new Map()
  for (const item of items) {
    const custody = custodyOf(m, item)
    if (!custody?.returned_at) continue
    let next = null
    for (const c of ix.custodies(item.equipment_id)) if (c.voucher_id != null && c.voucher_id !== v.id && c.handed_at === custody.returned_at) next = c
    // Taken by a voucher issued on this phone: it has no number until the sync ('')
    if (next) moved.set(item.id, numberOf(m, next.voucher_id) || '')
  }
  return moved
}

function currentTemplate(m, id) {
  const list = [...m.voucherSettings.templates].sort(byId)
  return (id != null && list.find((t) => t.id === Number(id))) || list.find((t) => t.is_default) || list[0] || null
}

const templateLayout = (m, id) => {
  const template = currentTemplate(m, id)
  return template ? (m.voucherSettings.layouts[template.id] ?? null) : null
}

/** VoucherRows::for */
function voucherRows(units) {
  const rows = new Map()
  for (const { unit, custody } of units) {
    if (!rows.has(unit.key)) rows.set(unit.key, { key: unit.key, code: unit.accessory ? null : unit.code, name: unit.brief.display_name, accessory: unit.accessory, quantity: 0, quantity_words: '', returned: 0, serials: [] })
    const row = rows.get(unit.key)
    row.quantity++
    row.serials.push(unit.brief.serial_number)
    if (custody?.returned_at) row.returned++
  }
  for (const row of rows.values()) row.quantity_words = `${arabicWords(row.quantity)} فقط`
  return [...rows.values()]
}

/** VoucherController::payload. `created`: the model just made answers without the revision the database gives it. */
function voucherPage(m, ix, v, notes = null, created = false) {
  const draft = v.status === DRAFT
  const items = ix.items(v)
  const held = new Map()
  if (draft) for (const c of heldElsewhere(m, v, items.map((i) => i.equipment_id))) held.set(c.equipment_id, c)
  const moved = movedTo(m, ix, v, items)
  const replaced = v.replaces_id != null ? m.vouchers.get(v.replaces_id) : null
  const units = []
  const shown = []
  for (const item of items) {
    const unit = unitOf(m, item.equipment_id)
    if (!unit) continue
    const custody = custodyOf(m, item)
    const holder = held.get(item.equipment_id)
    units.push({ unit, custody })
    shown.push({
      id: item.id,
      row_key: unit.key,
      equipment: { ...unit.brief, deleted: unit.deleted },
      accessories: unit.accessories,
      returned_at: custody?.returned_at ?? null,
      return_notes: custody?.return_notes ?? null,
      moved_to: moved.get(item.id) ?? null,
      held_by: holder ? { holder: holder.holder, voucher_number: numberOf(m, holder.voucher_id) } : null,
      added_at: item.created_at,
    })
  }
  return {
    voucher: {
      id: v.id,
      number: v.number,
      status: v.status,
      recipient: v.recipient,
      fields: fieldsOut(v.fields),
      template_id: v.template_id,
      revision: created ? null : v.revision,
      issued_at: v.issued_at,
      returned_at: v.returned_at,
      created_at: v.created_at,
      creator: v.creator,
      issuer: v.issuer,
      replaces: replaced ? { id: replaced.id, number: replaced.number } : null,
      replacement_id: draft ? null : (ix.replacement.get(v.id) ?? null),
      last_print: v.last_print,
      ...notesFor(notes, 'voucher', v.id),
    },
    layout: v.layout ?? templateLayout(m, v.template_id),
    copies: Math.max(1, Number(m.voucherSettings.copies) || 0),
    items: shown,
    rows: voucherRows(units),
  }
}

const pageOf = (m, v, created = false) => voucherPage(m, voucherIndex(m), v, null, created)

/** Voucher::nextNumber */
const nextNumber = (m) => Math.max(Number(m.voucherSettings.number_from) || 0, [...m.vouchers.values()].reduce((max, v) => Math.max(max, v.number ?? 0), 0) + 1, 1)

/** The list's order (VoucherController::listed); issued on the phone (no number yet) comes after the drafts. */
const listRank = (v) => (v.status === DRAFT ? 0 : v.number == null ? 1 : 2)
const listOrder = (a, b) => listRank(a) - listRank(b) || (b.number ?? 0) - (a.number ?? 0) || b.id - a.id

function listEntry(m, ix, v, notes) {
  const items = ix.items(v)
  const replaced = v.replaces_id != null ? m.vouchers.get(v.replaces_id) : null
  const { layout, last_print, ...attributes } = v
  void layout
  void last_print
  return {
    ...attributes,
    fields: fieldsOut(v.fields),
    items_count: items.length,
    held_count: items.filter((i) => isOpen(custodyOf(m, i))).length,
    replaces: replaced ? { id: replaced.id, number: replaced.number } : null,
    ...markOf(notes, 'voucher', v.id),
  }
}

/** VoucherController::recipients: names used before, for suggestions. */
function voucherRecipients(m) {
  const distinct = (values) => {
    const seen = new Set()
    return values.filter((value) => {
      if (value == null) return false
      const key = groupKey(String(value))
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const names = [...distinct([...m.vouchers.values()].sort(byId).map((v) => v.recipient)), ...distinct([...m.custodies.values()].sort(byId).map((c) => c.holder))]
    .map((name) => phpTrim(String(name)))
    .filter(truthy)
  return [...new Set(names)].sort(phpCompare).slice(0, 500)
}

/** The voucher pages of the copy (OfflineController::vouchers). */
function voucherData(m, notes) {
  const ix = voucherIndex(m)
  const all = [...m.vouchers.values()].sort(byId)
  const pages = {}
  for (const v of all) pages[v.id] = voucherPage(m, ix, v, notes)
  const counts = new Map()
  for (const v of all) if (v.template_id != null) counts.set(v.template_id, (counts.get(v.template_id) || 0) + 1)
  const { records, ...saved } = m.data.vouchers
  void records
  return {
    ...saved,
    list: [...all].sort(listOrder).map((v) => listEntry(m, ix, v, notes)),
    next_number: nextNumber(m),
    pages,
    recipients: voucherRecipients(m),
    templates: saved.templates.map((t) => ({ ...t, vouchers_count: counts.get(t.id) || 0 })),
    last_fields: { ...m.voucherSettings.last_fields },
    copies: Math.max(1, Number(m.voucherSettings.copies) || 0),
  }
}

/** How a voucher is named in the list of changes: its number and recipient. */
const voucherLabel = (v) => [v.number, v.recipient].filter(Boolean).join(' · ')

function vouchersOf(m) {
  if (!m.vouchers) throw new Refusal(409, { message: 'offline_sync_first' })
  return m.vouchers
}

const voucherOr404 = (m, id) => vouchersOf(m).get(Number(id)) ?? notFound()

function mustBeDraft(v) {
  if (v.status !== DRAFT) invalid('voucher', 'voucher_locked')
}

/** The boolean rule; `move` is true only for true, 1 and '1'. */
function checkBoolean(field, value) {
  if (value != null && ![true, false, 0, 1, '0', '1'].includes(value)) invalid(field)
  return value === true || value === 1 || value === '1'
}

/** Voucher::syncStatus: "returned" once nothing is held any more, "issued" again when something is. */
function syncStatus(m, v, ctx) {
  if (v.status !== DRAFT) {
    const items = itemsOfVoucher(m, v)
    const done = items.length > 0 && !items.some((i) => isOpen(custodyOf(m, i)))
    v.status = done ? RETURNED : ISSUED
    v.returned_at = done ? (v.returned_at ?? ctx.at) : null
  }
  v.revision++
  v.updated_at = ctx.at
  ctx.mark('voucher', v.id)
}

/** A custody saved with another return time: its voucher follows (Custody::booted). */
function custodyChanged(m, c, ctx) {
  const v = c.voucher_id != null ? m.vouchers.get(c.voucher_id) : null
  if (v) syncStatus(m, v, ctx)
}

/** The voucher row deleted: its units go with it, its custody stays without it. */
function removeVoucher(m, v) {
  m.vouchers.delete(v.id)
  for (const [id, item] of m.voucherItems) if (item.voucher_id === v.id) m.voucherItems.delete(id)
  for (const c of m.custodies.values()) if (c.voucher_id === v.id) c.voucher_id = null
  for (const other of m.vouchers.values()) if (other.replaces_id === v.id) other.replaces_id = null
}

/** VoucherController::discard: custody still open is cancelled, a unit taken from someone goes back to them. */
function discard(m, v, ctx, carried = new Set()) {
  const note = `نُقلت إلى سند الصرف رقم ${v.number ?? ''}`
  for (const custody of custodiesOfVoucher(m, v).filter(isOpen)) {
    m.custodies.delete(custody.id)
    for (const item of m.voucherItems.values()) if (item.custody_id === custody.id) item.custody_id = null
    if (carried.has(custody.equipment_id)) continue
    const before = [...m.custodies.values()]
      .filter((c) => c.equipment_id === custody.equipment_id && c.returned_at === custody.handed_at && c.return_notes === note)
      .sort(byId)
      .pop()
    if (before && ![...m.custodies.values()].some((c) => c.equipment_id === custody.equipment_id && isOpen(c))) {
      before.returned_at = null
      before.return_notes = null
      custodyChanged(m, before, ctx)
    }
  }
  removeVoucher(m, v)
  ctx.mark('voucher', v.id)
}

function addItem(m, v, equipmentId, ctx) {
  const item = { id: ctx.newId(), voucher_id: v.id, equipment_id: equipmentId, custody_id: null, added_by: ctx.user?.id ?? null, created_at: ctx.at }
  m.voucherItems.set(item.id, item)
  return item
}

/** StocktakeController::serialFromCode */
function serialFromCode(code) {
  const text = phpTrim(code)
  const match = /\/eq\/([^/?#]+)/.exec(text)
  if (!match) return text
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/** VoucherController::findByCode: a system label or a serial number, else a maker's code in a field of exactly one equipment. */
function findByCode(m, code) {
  const serial = serialFromCode(code)
  const all = [...m.equipment.values()].sort(byId)
  let e = all.filter((x) => same(x.serial_number, serial)).sort((a, b) => (a.parent_id != null) - (b.parent_id != null) || a.id - b.id)[0]
  if (!e && serial !== '') {
    const ids = all.filter((x) => x.fields.some((f) => same(f.value, serial))).map((x) => x.id)
    if (ids.length > 1) invalid('code', 'voucher_code_many')
    e = ids.length ? m.equipment.get(ids[0]) : null
  }
  if (!e) invalid('code', 'voucher_unknown_code')
  return e
}

/** What the sync needs to know of a custody the phone ended. */
const custodyInfo = (c) => ({ id: c.id, equipment_id: c.equipment_id, voucher_id: c.voucher_id })

function storeVoucher(m, input, ctx) {
  vouchersOf(m)
  check('recipient', input.recipient, { max: 191 })
  const last = m.voucherSettings.last_fields
  const v = {
    id: ctx.newId(),
    number: null,
    status: DRAFT,
    recipient: voucherText(input.recipient),
    fields: Object.keys(last).length ? { ...last } : null,
    replaces_id: null,
    template_id: null,
    layout: null,
    revision: 0,
    created_by: ctx.user?.id ?? null,
    issued_by: null,
    issued_at: null,
    returned_at: null,
    created_at: ctx.at,
    updated_at: ctx.at,
    creator: who(ctx.user),
    issuer: null,
    last_print: null,
  }
  m.vouchers.set(v.id, v)
  ctx.mark('voucher', v.id, 'new')
  return { body: pageOf(m, v, true), effect: { kind: 'voucher_created', label: voucherLabel(v) } }
}

function updateVoucher(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  mustBeDraft(v)
  if ('recipient' in input) check('recipient', input.recipient, { max: 191 })
  if ('template_id' in input && input.template_id != null) {
    check('template_id', input.template_id, { integer: true })
    if (!m.voucherSettings.templates.some((t) => t.id === Number(input.template_id))) invalid('template_id')
  }
  if ('fields' in input) {
    const fields = input.fields
    if (!fields || typeof fields !== 'object' || fields.file || Object.keys(fields).length > 50) invalid('fields')
    for (const [key, value] of Object.entries(fields)) check(`fields.${key}`, value, { max: 500 })
  }
  if ('recipient' in input) v.recipient = voucherText(input.recipient)
  if ('template_id' in input) v.template_id = input.template_id == null ? null : Number(input.template_id)
  if ('fields' in input) v.fields = Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [key, voucherText(value)]))
  v.revision++
  v.updated_at = ctx.at
  ctx.mark('voucher', v.id)
  return { body: pageOf(m, v), effect: { kind: 'voucher_updated', label: voucherLabel(v) } }
}

/** Deleting an issued or returned voucher asks for the PIN again, as the server does; the phone checks it. */
export function voucherPinNeeded(m, method, path) {
  if (!m.vouchers) return false
  const match = (method === 'DELETE' && /^\/api\/vouchers\/(\d+)$/.exec(path)) || (method === 'POST' && /^\/api\/vouchers\/(\d+)\/return-all$/.exec(path))
  const v = match && m.vouchers.get(Number(match[1]))
  return !!v && v.status !== DRAFT
}

function deleteVoucher(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  const name = voucherLabel(v)
  for (const draft of [...m.vouchers.values()].sort(byId)) if (draft.replaces_id === v.id && draft.status === DRAFT) removeVoucher(m, draft)
  discard(m, v, ctx)
  return { status: 204, effect: { kind: 'voucher_deleted', label: name } }
}

function replaceVoucher(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  if (v.status === DRAFT) invalid('voucher', 'voucher_not_issued')
  const existing = [...m.vouchers.values()].sort(byId).find((d) => d.replaces_id === v.id && d.status === DRAFT)
  if (existing) return { body: pageOf(m, existing), effect: null }
  const out = custodiesOfVoucher(m, v)
    .filter(isOpen)
    .map((c) => c.equipment_id)
  if (!out.length) invalid('voucher', 'voucher_nothing_out')
  const templateId = Number(v.layout?.template_id ?? v.template_id)
  const draft = {
    id: ctx.newId(),
    number: null,
    status: DRAFT,
    recipient: v.recipient,
    fields: v.fields == null ? null : JSON.parse(JSON.stringify(v.fields)),
    replaces_id: v.id,
    template_id: m.voucherSettings.templates.some((t) => t.id === templateId) ? templateId : null,
    layout: null,
    revision: 0,
    created_by: ctx.user?.id ?? null,
    issued_by: null,
    issued_at: null,
    returned_at: null,
    created_at: ctx.at,
    updated_at: ctx.at,
    creator: who(ctx.user),
    issuer: null,
    last_print: null,
  }
  m.vouchers.set(draft.id, draft)
  for (const equipmentId of out) addItem(m, draft, equipmentId, ctx)
  v.revision++
  v.updated_at = ctx.at
  ctx.mark('voucher', draft.id, 'new')
  ctx.mark('voucher', v.id)
  return { body: pageOf(m, draft, true), effect: { kind: 'voucher_replace_started', label: voucherLabel(v), n: out.length } }
}

function addVoucherItems(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  mustBeDraft(v)
  if (input.code == null && input.equipment_ids == null) throw new Refusal(422, { message: 'offline_invalid', errors: { code: ['offline_invalid'], equipment_ids: ['offline_invalid'] } })
  check('code', input.code, { max: 500 })
  const ids = input.equipment_ids != null ? idList('equipment_ids', input.equipment_ids, 500) : []
  const move = checkBoolean('move', input.move)
  let equipment
  if (input.code != null) equipment = [findByCode(m, input.code)]
  else {
    const wanted = new Set(ids)
    equipment = [...m.equipment.values()].filter((e) => wanted.has(e.id)).sort(byId)
  }
  const inVoucher = new Set(itemsOfVoucher(m, v).map((i) => i.equipment_id))
  const fresh = equipment.filter((e) => !inVoucher.has(e.id))
  if (!fresh.length) return { body: { status: 'already', equipment: equipment.map((e) => voucherBrief(m, e)), ...pageOf(m, v) }, effect: null }
  const held = heldElsewhere(m, v, fresh.map((e) => e.id))
  if (held.length && !move) return { body: { status: 'held', held: heldList(m, held), ...pageOf(m, v) }, effect: null }
  const added = fresh.map((e) => addItem(m, v, e.id, ctx))
  syncStatus(m, v, ctx)
  return {
    body: { status: 'added', added: added.map((i) => i.id), equipment: fresh.map((e) => voucherBrief(m, e)), ...pageOf(m, v) },
    effect: { kind: 'voucher_items_added', label: voucherLabel(v), n: fresh.length, labels: fresh.map((e) => label(m, e)) },
  }
}

function removeVoucherItem(m, input, ctx, id, itemId) {
  const v = voucherOr404(m, id)
  const item = m.voucherItems.get(Number(itemId))
  if (!item || item.voucher_id !== v.id) notFound()
  mustBeDraft(v)
  m.voucherItems.delete(item.id)
  syncStatus(m, v, ctx)
  const unit = unitOf(m, item.equipment_id)
  return { body: pageOf(m, v), effect: { kind: 'voucher_item_removed', label: voucherLabel(v), serial: unit?.brief.serial_number || unit?.brief.display_name || '' } }
}

/** VoucherController::queuePrint: on the phone the print waits for the sync. */
function queuePrint(m, v, copies, ctx) {
  m.voucherSettings.copies = copies
  if (copies < 1) return null
  const job = { id: ctx.newId(), copies, status: PRINT_AT_SYNC, created_at: ctx.at, finished_at: null }
  v.last_print = job
  return job
}

/** The print station is on the laptop: a phone without a connection cannot tell whether it is open. */
const STATION_UNKNOWN = { online: false, seen_at: null }

/** VoucherController::handOver: custody for each unit; a unit someone else holds is taken back from them first. */
function handOver(m, v, items, ctx) {
  const ids = new Set(items.map((i) => i.equipment_id))
  const previous = [...m.custodies.values()].filter((c) => isOpen(c) && ids.has(c.equipment_id)).sort(byId)
  for (const item of items) {
    for (const old of previous.filter((c) => c.equipment_id === item.equipment_id)) {
      old.returned_at = ctx.at
      old.return_notes = `نُقلت إلى سند الصرف رقم ${v.number ?? ''}`
      custodyChanged(m, old, ctx)
    }
    const custody = { id: ctx.newId(), equipment_id: item.equipment_id, voucher_id: v.id, holder: v.recipient, handed_at: ctx.at, returned_at: null, return_notes: null }
    m.custodies.set(custody.id, custody)
    item.custody_id = custody.id
  }
}

/**
 * Hands every unit over to the recipient. On the phone the voucher has no number until it syncs
 * (a correction takes the number of the voucher it corrects); `m.numbered` numbers it as the
 * server does (offlineSync.js keeps the server's data up to date with it).
 */
function issueVoucher(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  check('recipient', input.recipient, { max: 191 })
  const move = checkBoolean('move', input.move)
  check('copies', input.copies, { integer: true, min: 0, maxValue: MAX_COPIES })
  if (v.status !== DRAFT) invalid('voucher', 'voucher_not_draft')
  const recipient = voucherText(input.recipient) ?? v.recipient
  if (!recipient) invalid('recipient', 'voucher_no_recipient')
  const items = itemsOfVoucher(m, v)
  if (!items.length) invalid('voucher', 'voucher_empty')
  const held = heldElsewhere(m, v, items.map((i) => i.equipment_id))
  if (held.length && !move) return { body: { status: 'held', held: heldList(m, held), ...pageOf(m, v) }, effect: null }

  const copies = input.copies == null ? 1 : Number(input.copies)
  const template = currentTemplate(m, v.template_id)
  const replaced = v.replaces_id != null ? m.vouchers.get(v.replaces_id) : null
  const number = replaced?.number ?? null
  if (replaced) discard(m, replaced, ctx, new Set(items.map((i) => i.equipment_id)))
  Object.assign(v, {
    number: number ?? (m.numbered ? nextNumber(m) : null),
    replaces_id: null,
    status: ISSUED,
    recipient,
    template_id: template?.id ?? null,
    layout: template ? (m.voucherSettings.layouts[template.id] ?? null) : null,
    issued_at: ctx.at,
    issued_by: ctx.user?.id ?? null,
    issuer: who(ctx.user),
    updated_at: ctx.at,
  })
  handOver(m, v, items, ctx)
  syncStatus(m, v, ctx)
  const typed = Object.entries(v.fields || {}).filter(([, value]) => typeof value === 'string' && value !== '')
  if (typed.length) m.voucherSettings.last_fields = { ...m.voucherSettings.last_fields, ...Object.fromEntries(typed) }
  const job = queuePrint(m, v, copies, ctx)
  return {
    body: { status: 'issued', print: { job, station: STATION_UNKNOWN }, ...pageOf(m, v) },
    effect: { kind: 'voucher_issued', label: voucherLabel(v), n: items.length, copies, replaces: replaced ? voucherLabel(replaced) : undefined },
    info: { held: held.map(custodyInfo), replaced: replaced?.id ?? null },
  }
}

function printVoucher(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  check('copies', input.copies, { required: true, integer: true, min: 1, maxValue: MAX_COPIES })
  if (v.status === DRAFT) invalid('voucher', 'voucher_not_issued')
  const job = queuePrint(m, v, Number(input.copies), ctx)
  v.revision++
  v.updated_at = ctx.at
  ctx.mark('voucher', v.id)
  return { body: { print: { job, station: STATION_UNKNOWN }, ...pageOf(m, v) }, effect: { kind: 'voucher_printed', label: voucherLabel(v), copies: job.copies } }
}

function holderOf(m, e) {
  const c = [...m.custodies.values()].filter((x) => x.equipment_id === e.id && isOpen(x)).sort(byId)[0]
  return c ? { holder: c.holder, voucher_number: numberOf(m, c.voucher_id) } : null
}

function takeBack(m, custody, ctx) {
  custody.returned_at = ctx.at
  custodyChanged(m, custody, ctx)
}

function returnVoucherItem(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  check('code', input.code, { required: true, max: 500 })
  if (v.status === DRAFT) invalid('code', 'voucher_not_issued')
  const e = findByCode(m, input.code)
  const item = itemsOfVoucher(m, v).find((i) => i.equipment_id === e.id)
  if (!item) return { body: { status: 'not_in_voucher', equipment: voucherBrief(m, e), holder: holderOf(m, e), ...pageOf(m, v) }, effect: null }
  const custody = custodyOf(m, item)
  if (!isOpen(custody)) return { body: { status: 'already', equipment: voucherBrief(m, e), ...pageOf(m, v) }, effect: null }
  takeBack(m, custody, ctx)
  return {
    body: { status: 'returned', equipment: voucherBrief(m, e), ...pageOf(m, v) },
    effect: { kind: 'voucher_item_returned', label: voucherLabel(v), serial: label(m, e) },
    info: { custodies: [custodyInfo(custody)] },
  }
}

function returnAllVoucher(m, input, ctx, id) {
  const v = voucherOr404(m, id)
  if (v.status === DRAFT) invalid('voucher', 'voucher_not_issued')
  const open = custodiesOfVoucher(m, v).filter(isOpen)
  if (!open.length) invalid('voucher', 'voucher_nothing_out')
  for (const custody of open) {
    custody.returned_at = ctx.at
    custody.return_notes = `إرجاع كامل لسند الصرف رقم ${v.number ?? ''}`
  }
  syncStatus(m, v, ctx)
  return { body: { status: 'returned', returned: open.length, ...pageOf(m, v) }, effect: { kind: 'voucher_returned_all', label: voucherLabel(v), n: open.length }, info: { custodies: open.map(custodyInfo) } }
}

function returnAnyUnit(m, input, ctx) {
  vouchersOf(m)
  check('code', input.code, { required: true, max: 500 })
  const e = findByCode(m, input.code)
  const custody = [...m.custodies.values()].filter((c) => c.equipment_id === e.id && isOpen(c)).sort((a, b) => (b.handed_at > a.handed_at) - (b.handed_at < a.handed_at) || b.id - a.id)[0]
  if (!custody) return { body: { status: 'not_held', equipment: voucherBrief(m, e) }, effect: null }
  takeBack(m, custody, ctx)
  const v = custody.voucher_id != null ? m.vouchers.get(custody.voucher_id) : null
  const items = v ? itemsOfVoucher(m, v) : []
  return {
    body: {
      status: 'returned',
      equipment: voucherBrief(m, e),
      holder: custody.holder,
      voucher: v ? { id: v.id, number: v.number, recipient: v.recipient, status: v.status, items_count: items.length, held_count: items.filter((i) => isOpen(custodyOf(m, i))).length } : null,
    },
    effect: { kind: 'voucher_unit_returned', label: label(m, e), holder: custody.holder, voucher: v ? voucherLabel(v) : '' },
    info: { custodies: [custodyInfo(custody)] },
  }
}

/** What a voucher holds that the sync compares (offlineSync.js). */
export const voucherState = (m, v) => ({
  recipient: v.recipient,
  template_id: v.template_id,
  status: v.status,
  number: v.number,
  replaces_id: v.replaces_id,
  fields: Object.entries(v.fields && typeof v.fields === 'object' ? v.fields : {}).map(([key, value]) => ({ key, value })),
  items: itemsOfVoucher(m, v).map((i) => i.equipment_id),
  open: itemsOfVoucher(m, v)
    .filter((i) => isOpen(custodyOf(m, i)))
    .map((i) => i.equipment_id),
  revision: v.revision,
})

/** Open custody of an equipment (for the sync): who holds it now. */
export const openCustodies = (m, equipmentId) => [...(m.custodies?.values() || [])].filter((c) => c.equipment_id === equipmentId && isOpen(c)).sort(byId)

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
  ['POST', /^\/api\/scan-folders$/, storeScanFolder],
  ['PUT', /^\/api\/scan-folders\/(\d+)$/, updateScanFolder],
  ['DELETE', /^\/api\/scan-folders\/(\d+)$/, deleteScanFolder],
  ['POST', /^\/api\/scan-documents$/, storeScanDocument],
  ['PUT', /^\/api\/scan-documents\/(\d+)$/, updateScanDocument],
  ['DELETE', /^\/api\/scan-documents\/(\d+)$/, deleteScanDocument],
  ['POST', /^\/api\/scan-documents\/(\d+)\/scan$/, scanCode],
  ['POST', /^\/api\/scan-documents\/(\d+)\/rows$/, addScanRow],
  ['PUT', /^\/api\/scan-documents\/(\d+)\/rows\/(\d+)$/, updateScanRow],
  ['DELETE', /^\/api\/scan-documents\/(\d+)\/rows\/(\d+)$/, deleteScanRow],
  ['POST', /^\/api\/vouchers$/, storeVoucher],
  ['PUT', /^\/api\/vouchers\/(\d+)$/, updateVoucher],
  ['DELETE', /^\/api\/vouchers\/(\d+)$/, deleteVoucher],
  ['POST', /^\/api\/vouchers\/(\d+)\/replace$/, replaceVoucher],
  ['POST', /^\/api\/vouchers\/(\d+)\/items$/, addVoucherItems],
  ['DELETE', /^\/api\/vouchers\/(\d+)\/items\/(\d+)$/, removeVoucherItem],
  ['POST', /^\/api\/vouchers\/(\d+)\/issue$/, issueVoucher],
  ['POST', /^\/api\/vouchers\/(\d+)\/print$/, printVoucher],
  ['POST', /^\/api\/vouchers\/(\d+)\/return$/, returnVoucherItem],
  ['POST', /^\/api\/vouchers\/(\d+)\/return-all$/, returnAllVoucher],
  ['POST', /^\/api\/vouchers\/return$/, returnAnyUnit],
]

/** Whether the phone can make this change without the server. */
export const canChangeOffline = (method, path) => CHANGES.some(([m, pattern]) => m === method && pattern.test(path))

/**
 * Applies one change to the records, as the server would. A refused change answers 4xx and
 * changes nothing. `replay`: the change was made before, it takes the ids it was given then.
 * Returns { status, body, effect, touched, info }: effect describes it for the list of changes,
 * touched is what it changed ([type, id, 'new' | 'changed']), info what the sync needs besides.
 */
export function applyChange(m, change, { replay = false } = {}) {
  const route = CHANGES.find(([method, pattern]) => method === change.method && pattern.test(change.path))
  if (!route) return { status: 409, body: { message: 'offline_sync_first' } }
  const given = replay ? [...(change.ids || [])] : []
  const ids = []
  const touched = []
  const ctx = {
    at: change.at,
    user: change.user,
    replay,
    newId: () => {
      const id = replay && given.length ? given.shift() : m.nextId
      m.nextId = Math.max(m.nextId, id + 1)
      ids.push(id)
      return id
    },
    mark: (type, id, state = 'changed') => touched.push([type, id, state]),
  }
  try {
    const { status = 200, body = null, effect, info } = route[2](m, asInput(change.body ?? {}), ctx, ...change.path.match(route[1]).slice(1))
    if (!replay) change.ids = ids
    return { status, body, effect, touched, info }
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, body: error.body }
    throw error
  }
}

/** Marks and change lists for the pages, from the changes applied in order. */
export function notesFrom(changes, results, now) {
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
export function applyAll(saved, changes, now = Date.now()) {
  const model = toModel(saved)
  for (const change of changes) for (const id of change.ids || []) model.nextId = Math.max(model.nextId, id + 1)
  const results = changes.map((change) => applyChange(model, change, { replay: true }))
  return { model, results, data: changes.length ? fromModel(model, notesFrom(changes, results, now)) : saved }
}

/** Undoing a change also undoes the later ones that built on it (they no longer apply without it). */
export function undoPlan(saved, changes, id) {
  const rest = changes.filter((c) => c.id !== id)
  const { results } = applyAll(saved, rest)
  return [id, ...rest.filter((c, i) => results[i].status >= 400).map((c) => c.id)]
}
