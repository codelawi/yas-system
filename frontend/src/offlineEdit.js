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
export const canChangeOffline = (method, path) => CHANGES.some(([m, pattern]) => m === method && pattern.test(path))

/**
 * Applies one change to the records, as the server would. A refused change answers 4xx and
 * changes nothing. `replay`: the change was made before, it takes the ids it was given then.
 * Returns { status, body, effect, touched }: effect describes it for the list of changes, touched
 * is what it changed ([type, id, 'new' | 'changed']).
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
