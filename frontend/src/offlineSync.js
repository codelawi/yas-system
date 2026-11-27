/*
 * Sending the changes made on this phone without a connection (kept by sw.js) to the server.
 *
 * The changes go in the order they were made, each to the same API the pages use, with:
 * X-Offline-Change (a key of its own: a sync cut off half way can start again, a change already
 * saved gets its first answer), X-Offline-User (who made it) and X-Offline-At (when). See
 * App\Http\Middleware\ApplyOfflineChange.
 *
 * The server may have changed since the phone saved its copy. Before each change the phone knows
 * the server's data (a fresh copy, with what this sync sent applied to it as the server applies
 * it, offlineEdit.js), so an edit only sends what the phone changed: what changed on the server
 * stays. When both changed the same field to different values, or an item is gone on one side,
 * or what the phone added already exists on the server, the person decides at the end: the
 * rest goes on meanwhile, and what depends on an open question waits for the answer.
 */
import { applyChange, boxState, equipmentLabel, equipmentState, groupState, isTempId, toModel } from './offlineEdit'
import { readSavedChanges, readSavedCopy, readSavedFile } from './offline'

/** The sync stopped (no connection, or the server refused): what was sent stays sent, the rest can be sent again. */
export class SyncStopped extends Error {
  constructor(reason, detail = '') {
    super(reason)
    this.reason = reason
    this.detail = detail
  }
}

/** Requests the service worker lets through to the server (sw.js). */
const DIRECT = { Accept: 'application/json', 'X-Repo-Direct': '1' }

async function call(method, path, { token, body, headers = {} } = {}) {
  const all = { ...DIRECT, ...headers }
  if (token) all.Authorization = `Bearer ${token}`
  let payload
  if (body instanceof FormData) payload = body
  else if (body !== undefined && method !== 'GET') {
    payload = JSON.stringify(body)
    all['Content-Type'] = 'application/json'
  }
  let response
  try {
    response = await fetch(path, { method, headers: all, body: payload, cache: 'no-store' })
  } catch {
    throw new SyncStopped('sync_unreachable')
  }
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (response.status === 401) throw new SyncStopped('offline_pin_again')
  if (response.status === 429) throw new SyncStopped('too_many_attempts')
  if (response.status >= 500) throw new SyncStopped('sync_server_error', `HTTP ${response.status}`)
  return { status: response.status, json, replayed: response.headers.get('X-Offline-Replayed') === '1' }
}

const errorOf = (res) => (res.json?.errors ? Object.values(res.json.errors)[0]?.[0] : res.json?.message) || `HTTP ${res.status}`
const ok = (res) => res.status >= 200 && res.status < 300

/** Whether the server answers (the phone itself checks, not its copy). */
export async function serverReachable() {
  try {
    return (await fetch('/api/network/ping', { headers: DIRECT, cache: 'no-store' })).ok
  } catch {
    return false
  }
}

/** Unlocks on the server with the PIN of whoever syncs: { token, user }. */
export async function signInToSync(pin) {
  const res = await call('POST', '/api/auth/login', { body: { pin } })
  if (res.status !== 200) throw new SyncStopped(errorOf(res))
  return res.json
}

/* ---------- What each change did on the phone */

const keyOf = (type, id) => `${type}:${id}`
/** A photo is told apart by the v= of its address (a new photo gets a new one). */
const photoToken = (url) => (url ? new URL(url, 'https://repo.local').searchParams.get('v') || url : null)

function stateOf(m, type, id) {
  if (type === 'equipment') {
    const e = m.equipment.get(id)
    return e ? { ...equipmentState(e), photo: photoToken(e.photo_url), parent_id: e.parent_id } : null
  }
  if (type === 'box') {
    const b = m.boxes.get(id)
    return b ? { ...boxState(b), items: [...(m.boxItems.get(id) || [])] } : null
  }
  if (type === 'group') {
    const g = m.groups.get(id)
    return g ? groupState(g) : null
  }
  return null
}

/** The changes applied again to the copy they were made on, each with what it touched before and after. */
function replay(saved, changes) {
  const m = toModel(saved)
  for (const change of changes) for (const id of change.ids || []) m.nextId = Math.max(m.nextId, id + 1)
  const current = new Map()
  for (const id of m.equipment.keys()) current.set(keyOf('equipment', id), stateOf(m, 'equipment', id))
  for (const id of m.boxes.keys()) current.set(keyOf('box', id), stateOf(m, 'box', id))
  for (const id of m.groups.keys()) current.set(keyOf('group', id), stateOf(m, 'group', id))
  const records = changes.map((change) => {
    const result = applyChange(m, change, { replay: true })
    const before = new Map()
    const after = new Map()
    for (const [type, id] of result.touched || []) {
      const key = keyOf(type, id)
      if (before.has(key)) continue
      before.set(key, current.has(key) ? current.get(key) : null)
      after.set(key, stateOf(m, type, id))
      current.set(key, after.get(key))
    }
    return { change, result, before, after }
  })
  return { records, final: m, last: current }
}

/* ---------- Merging an edit with the server's data */

const ABSENT = Symbol('absent')
const sameValue = (a, b) => (a === ABSENT) === (b === ABSENT) && String(a === ABSENT ? '' : (a ?? '')) === String(b === ABSENT ? '' : (b ?? ''))
const fieldValue = (state, key) => {
  const field = state.fields.find((f) => f.key === key)
  return field ? (field.value ?? null) : ABSENT
}
const valueOf = (state, attr) => (attr.startsWith('field:') ? fieldValue(state, attr.slice(6)) : (state[attr] ?? null))

/** Sets (or removes, ABSENT) a field, a new one after the field it follows on the phone. */
function setField(fields, key, value, phoneFields) {
  const at = fields.findIndex((f) => f.key === key)
  if (value === ABSENT) {
    if (at >= 0) fields.splice(at, 1)
    return
  }
  if (at >= 0) {
    fields[at] = { key, value }
    return
  }
  const before = phoneFields.slice(0, Math.max(0, phoneFields.findIndex((f) => f.key === key))).map((f) => f.key)
  const after = before.reverse().map((k) => fields.findIndex((f) => f.key === k)).find((i) => i >= 0)
  fields.splice(after === undefined ? (before.length ? fields.length : 0) : after + 1, 0, { key, value })
}

function setValue(state, attr, value, phoneFields = []) {
  if (attr.startsWith('field:')) setField(state.fields, attr.slice(6), value, phoneFields)
  else state[attr] = value === ABSENT ? null : value
}

const EQUIPMENT_ATTRS = ['serial_number', 'name', 'row_no', 'category', 'group_id']

/**
 * The server's data with what the phone changed (before → after) on top. A value the phone
 * changed that the server changed to something else is left as the server has it, and returned
 * as a conflict.
 */
function merge(before, after, server, attrs) {
  const conflicts = []
  const state = { ...server, ...(server.fields ? { fields: server.fields.map((f) => ({ ...f })) } : {}) }
  const all = [...attrs]
  if (before.fields) {
    const keys = new Set([...before.fields.map((f) => f.key), ...after.fields.map((f) => f.key)])
    for (const key of keys) all.push(`field:${key}`)
  }
  for (const attr of all) {
    const [b, a, s] = [valueOf(before, attr), valueOf(after, attr), valueOf(server, attr)]
    if (sameValue(b, a)) continue
    if (sameValue(s, b) || sameValue(s, a)) setValue(state, attr, a, after.fields)
    else conflicts.push({ attr, phone: a, server: s })
  }
  // Nothing else changed the fields: they keep the phone's order
  if (before.fields && JSON.stringify(server.fields) === JSON.stringify(before.fields) && !conflicts.some((c) => c.attr.startsWith('field:'))) state.fields = after.fields.map((f) => ({ ...f }))
  return { state, conflicts }
}

const sameState = (a, b, attrs) => attrs.every((attr) => sameValue(valueOf(a, attr), valueOf(b, attr))) && (!a.fields || JSON.stringify(a.fields) === JSON.stringify(b.fields))

const equipmentBody = (state) => ({ serial_number: state.serial_number, name: state.name, row_no: state.row_no, category: state.category, group_id: state.group_id, fields: state.fields })

/* ---------- The sync */

/** Which change goes where; bulk changes list the equipment they change in ids. */
const ROUTES = [
  ['POST', /^\/api\/equipment$/, 'createEquipment'],
  ['PUT', /^\/api\/equipment\/(\d+)$/, 'updateEquipment'],
  ['DELETE', /^\/api\/equipment\/(\d+)$/, 'deleteEquipment'],
  ['POST', /^\/api\/equipment\/bulk-delete$/, 'bulkDelete', true],
  ['POST', /^\/api\/equipment\/bulk-update$/, 'bulkUpdate', true],
  ['POST', /^\/api\/equipment\/(\d+)\/photo$/, 'photo'],
  ['DELETE', /^\/api\/equipment\/(\d+)\/photo$/, 'photo'],
  ['POST', /^\/api\/equipment\/(\d+)\/(maintenance|maintenance-records|issues)$/, 'addToEquipment'],
  ['PUT', /^\/api\/maintenance\/(\d+)$/, 'schedule'],
  ['DELETE', /^\/api\/maintenance\/(\d+)$/, 'schedule'],
  ['POST', /^\/api\/maintenance\/(\d+)\/complete$/, 'complete'],
  ['POST', /^\/api\/issues\/(\d+)\/close$/, 'closeIssue'],
  ['POST', /^\/api\/groups$/, 'createGroup'],
  ['PUT', /^\/api\/groups\/(\d+)$/, 'updateGroup'],
  ['DELETE', /^\/api\/groups\/(\d+)$/, 'deleteGroup'],
  ['POST', /^\/api\/groups\/assign$/, 'assign', true],
  ['POST', /^\/api\/boxes$/, 'createBox'],
  ['PUT', /^\/api\/boxes\/(\d+)$/, 'updateBox'],
  ['DELETE', /^\/api\/boxes\/(\d+)$/, 'deleteBox'],
  ['POST', /^\/api\/boxes\/(\d+)\/equipment$/, 'boxItems', true],
  ['DELETE', /^\/api\/boxes\/(\d+)\/equipment\/(\d+)$/, 'boxItems'],
  ['POST', /^\/api\/boxes\/(\d+)\/equipment\/remove$/, 'boxItems', true],
]

const routeOf = (change) => ROUTES.find(([method, pattern]) => method === change.method && pattern.test(change.path))
const pathIds = (change) => change.path.match(routeOf(change)[1]).slice(1).filter((part) => /^\d+$/.test(part)).map(Number)
/** An item added on the phone is known by its phone id; one from the copy by type and id. */
const depKey = (type, id) => (isTempId(id) ? `t:${id}` : keyOf(type, id))

/**
 * Sends the phone's changes. `ask(conflicts)` shows the open questions and resolves to the answers
 * ({ [id]: { choice, value } }); `onProgress({ step, done, total })`.
 * Returns what happened: { sent, skipped, dropped: [...], failed: [...] }.
 */
export async function syncChanges({ token, ask, onProgress = () => {} }) {
  return syncFrom({ token, ask, onProgress, saved: await readSavedCopy(), changes: await readSavedChanges() })
}

/** The same, for these changes made on this copy. */
export async function syncFrom({ token, ask, onProgress = () => {}, saved, changes }) {
  if (!saved || !changes.length) return { sent: 0, skipped: 0, dropped: [], failed: [] }
  const sync = new Sync(token, saved, changes, onProgress)
  await sync.run(ask)
  return sync.report
}

class Sync {
  constructor(token, saved, changes, onProgress) {
    this.token = token
    this.onProgress = onProgress
    this.base = toModel(saved)
    const { records, final, last } = replay(saved, changes)
    this.records = records
    this.final = final
    this.last = last
    /** Phone id → server id (added on the phone, or a box or group made again). */
    this.ids = new Map()
    /** Decided at the end: what depends on these waits. */
    this.waiting = new Set()
    this.dropped = new Set()
    this.deferred = []
    this.conflicts = []
    this.report = { sent: 0, skipped: 0, dropped: [], failed: [] }
    this.done = 0
  }

  async run(ask) {
    this.onProgress({ step: 'server' })
    this.serverAtStart = toModel(await this.loadServer())
    // A sync cut off before: what already went through is not asked about again
    const done = await call('POST', '/api/offline/done', { token: this.token, body: { keys: this.records.map((r) => r.change.key) } })
    if (!ok(done)) throw new SyncStopped('sync_server_error', errorOf(done))
    this.saved = new Set(done.json.done)
    for (const record of this.records) {
      this.onProgress({ step: 'send', done: this.done, total: this.records.length })
      await this.process(record)
      this.done++
    }
    while (this.conflicts.length) {
      const conflicts = this.conflicts
      this.conflicts = []
      const answers = await ask(conflicts.map((c) => c.question))
      this.onProgress({ step: 'send', done: this.done, total: this.records.length })
      await this.resolve(conflicts, answers)
      // Equipment brought back is not in the data the sync keeps up to date
      if (this.stale) await this.loadServer()
      this.stale = false
      const deferred = this.deferred
      this.deferred = []
      for (const record of deferred) await this.process(record)
    }
    for (const record of this.deferred) this.drop(record, 'sync_depends_on_dropped')
    this.onProgress({ step: 'send', done: this.records.length, total: this.records.length })
  }

  /** The server's data now (the same copy a phone downloads). */
  async loadServer() {
    const res = await call('GET', '/api/offline/snapshot', { token: this.token })
    if (!ok(res)) throw new SyncStopped('sync_server_error', errorOf(res))
    this.server = toModel(res.json)
    return res.json
  }

  serverId(id) {
    if (this.ids.has(id)) return this.ids.get(id)
    return isTempId(id) ? null : id
  }

  exists(type, id) {
    if (id == null) return false
    if (type === 'equipment') return this.server.equipment.has(id)
    if (type === 'box') return this.server.boxes.has(id)
    if (type === 'group') return this.server.groups.has(id)
    if (type === 'schedule') return [...this.server.maintenance.values()].some((m) => m.schedules.some((s) => s.id === id))
    if (type === 'issue') return [...this.server.issues.values()].some((list) => list.some((i) => i.id === id))
    return false
  }

  /** What must be settled before a change can go (must), and the items of a bulk change (items: one gone is left out). */
  deps(record) {
    const { change, result } = record
    const bulk = routeOf(change)[3]
    const must = new Set()
    const items = new Set()
    const temps = (value, into) => {
      if (typeof value === 'number' && isTempId(value)) into.add(`t:${value}`)
      else if (Array.isArray(value)) value.forEach((v) => temps(v, into))
    }
    for (const id of pathIds(change)) if (isTempId(id)) must.add(`t:${id}`)
    for (const [key, value] of Object.entries(change.body || {})) temps(value, bulk && (key === 'ids' || key === 'group_ids') ? items : must)
    for (const [type, id] of result.touched || []) (bulk && type === 'equipment' ? items : must).add(depKey(type, id))
    return { must, items }
  }

  async process(record) {
    const { must, items } = this.deps(record)
    if (record.result.status >= 400) return this.drop(record, 'sync_no_longer_applies')
    if ([...must].some((key) => this.dropped.has(key))) return this.drop(record, 'sync_depends_on_dropped')
    if ([...must, ...items].some((key) => this.waiting.has(key))) return this.defer(record)
    if (this.saved.has(record.change.key)) return this.again(record)
    await this[routeOf(record.change)[2]](record, ...pathIds(record.change))
  }

  /** Saved by a sync that was cut off: sent again only for its answer (the ids it gave). */
  async again(record) {
    const { change } = record
    const path = change.path.replace(/\d+/g, (id) => String(this.serverId(Number(id)) ?? id))
    const res = await this.send(record, change.method, path, change.method === 'DELETE' ? undefined : this.mapBody(change.body))
    if (ok(res)) this.created(record, res)
  }

  drop(record, reason) {
    this.report.dropped.push({ id: record.change.id, effect: record.result.effect, reason })
    for (const id of record.change.ids || []) this.dropped.add(`t:${id}`)
  }

  defer(record) {
    this.deferred.push(record)
    for (const id of record.change.ids || []) this.waiting.add(`t:${id}`)
  }

  skip() {
    this.report.skipped++
  }

  fail(record, res) {
    this.report.failed.push({ id: record.change.id, effect: record.result.effect, error: errorOf(res) })
    for (const id of record.change.ids || []) this.dropped.add(`t:${id}`)
  }

  /** Sends one request of a change, as the person who made it, when they made it. */
  async send(record, method, path, body, suffix = '') {
    const { change } = record
    const hasFile = body && Object.values(body).some((v) => v?.file)
    let payload = body
    if (hasFile) {
      payload = new FormData()
      for (const [key, value] of Object.entries(body)) {
        if (value == null) continue
        if (value.file) {
          const blob = await readSavedFile(value.file)
          if (blob) payload.append(key, blob, value.name || 'photo.jpg')
        } else if (Array.isArray(value)) value.forEach((v) => payload.append(`${key}[]`, String(v)))
        else payload.append(key, String(value))
      }
    }
    const res = await call(method, path, {
      token: this.token,
      body: method === 'DELETE' && !body ? undefined : payload,
      headers: { 'X-Offline-Change': change.key + suffix, 'X-Offline-User': String(change.user?.id ?? ''), 'X-Offline-At': change.at },
    })
    // Applied to the server's data here as the server applied it, for the next changes
    if (ok(res) && !res.replayed) applyChange(this.server, { ...change, method, path, body: body ?? {}, ids: this.createdIds(path, res) }, { replay: true })
    if (ok(res)) this.report.sent++
    return res
  }

  createdIds(path, res) {
    const id = res.json?.record?.id ?? res.json?.id
    return id == null ? [] : [id]
  }

  created(record, res) {
    const id = res.json?.record?.id ?? res.json?.id
    const phoneId = record.change.ids?.[0]
    if (phoneId != null && id != null) this.ids.set(phoneId, id)
  }

  /** A server id, or the change waits (an open question) or is dropped (gone). */
  target(record, type, phoneId) {
    const id = this.serverId(phoneId)
    if (this.exists(type, id)) return id
    if (isTempId(phoneId) || id == null) this.drop(record, 'sync_depends_on_dropped')
    else this.gone(record, type, id)
    return null
  }

  /** Changed on the phone, deleted on the server: bring it back, or leave it deleted. */
  gone(record, type, id) {
    // Deleted on the phone later too: nothing to ask
    const final = { equipment: this.final.equipment, box: this.final.boxes, group: this.final.groups }[type]
    if (!final.has(id)) return this.skip()
    const key = keyOf(type, id)
    if (!this.waiting.has(key)) {
      this.waiting.add(key)
      this.ask({ kind: `${type}_deleted`, type, id, label: this.label(type, id), record })
    }
    this.defer(record)
  }

  ask(conflict) {
    this.asked = (this.asked || 0) + 1
    const question = { id: String(this.asked), kind: conflict.kind, label: conflict.label, ...conflict.show }
    this.conflicts.push({ ...conflict, question })
  }

  label(type, id, phoneId = id) {
    if (type === 'equipment') {
      for (const [m, key] of [[this.final, phoneId], [this.server, id], [this.base, phoneId]]) {
        const e = m.equipment.get(key)
        if (e) return equipmentLabel(m, e)
      }
      return `#${id}`
    }
    if (type === 'box') return (this.final.boxes.get(phoneId) || this.server.boxes.get(id) || this.base.boxes.get(phoneId))?.number ?? `#${id}`
    return (this.final.groups.get(phoneId) || this.server.groups.get(id) || this.base.groups.get(phoneId))?.name ?? `#${id}`
  }

  groupName(m, id) {
    return id == null ? null : (m.groups.get(id)?.name ?? null)
  }

  /** Both sides changed these values: the person picks one at the end (the latest phone value counts). */
  conflictsOn(record, type, id, phoneId, conflicts) {
    for (const c of conflicts) {
      const same = this.conflicts.find((x) => x.kind === 'field' && x.type === type && x.id === id && x.attr === c.attr)
      const shown = (value) => (value === ABSENT ? null : c.attr === 'group_id' ? this.groupName(this.server, value) : value)
      const show = { type, attr: c.attr, phone: shown(c.phone), server: shown(c.server), removedOnPhone: c.phone === ABSENT, removedOnServer: c.server === ABSENT, user: record.change.user?.name ?? null }
      if (same) {
        Object.assign(same, { phone: c.phone, record })
        Object.assign(same.question, show)
      } else this.ask({ kind: 'field', type, id, attr: c.attr, phone: c.phone, record, label: this.label(type, id, phoneId), show })
    }
  }

  /** The states the phone had before and after a change, with its own ids as the server's. */
  states(record, type, phoneId) {
    const map = (state) => (state && type === 'equipment' && state.group_id != null ? { ...state, group_id: this.serverId(state.group_id) ?? state.group_id } : state)
    return [map(record.before.get(keyOf(type, phoneId))), map(record.after.get(keyOf(type, phoneId)))]
  }

  mapBody(body) {
    const map = (value, list) => {
      if (Array.isArray(value)) return value.map((v) => map(v, true)).filter((v) => !list || v != null)
      if (typeof value === 'number' && isTempId(value)) return this.serverId(value)
      return value
    }
    return Object.fromEntries(Object.entries(body || {}).map(([key, value]) => [key, map(value, false)]))
  }

  /* --- Equipment */

  async createEquipment(record) {
    const body = this.mapBody(record.change.body)
    const res = await this.send(record, 'POST', '/api/equipment', body)
    if (ok(res)) return this.created(record, res)
    if (errorOf(res) === 'serial_taken') {
      const phoneId = record.change.ids[0]
      this.waiting.add(`t:${phoneId}`)
      const owner = [...this.server.equipment.values()].find((e) => e.parent_id == null && String(e.serial_number).toLowerCase() === String(body.serial_number).trim().toLowerCase())
      return this.ask({ kind: 'serial_taken', type: 'equipment', phoneId, record, label: this.label('equipment', phoneId), owner: owner?.id, show: { value: String(body.serial_number ?? '').trim(), other: owner ? equipmentLabel(this.server, owner) : null } })
    }
    this.fail(record, res)
  }

  async updateEquipment(record, phoneId) {
    const id = this.target(record, 'equipment', phoneId)
    if (id == null) return
    const [before, after] = this.states(record, 'equipment', phoneId)
    const server = stateOf(this.server, 'equipment', id)
    const { state, conflicts } = merge(before, after, server, EQUIPMENT_ATTRS)
    this.conflictsOn(record, 'equipment', id, phoneId, conflicts)
    if (sameState(state, server, EQUIPMENT_ATTRS)) return this.skip()
    const res = await this.send(record, 'PUT', `/api/equipment/${id}`, equipmentBody(state))
    if (!ok(res)) this.fail(record, res)
  }

  /** Changed on the server since the phone saved its copy (by someone else: this sync is not counted). */
  changedOnServer(type, id) {
    const then = stateOf(this.base, type, id)
    const now = stateOf(this.serverAtStart, type, id)
    return !!then && !!now && JSON.stringify(then) !== JSON.stringify(now)
  }

  async deleteEquipment(record, phoneId) {
    const id = this.serverId(phoneId)
    if (!this.exists('equipment', id)) return this.skip()
    if (!isTempId(phoneId) && this.changedOnServer('equipment', id)) return this.ask({ kind: 'changed_deleted', type: 'equipment', ids: [id], record, label: this.label('equipment', id) })
    const res = await this.send(record, 'DELETE', `/api/equipment/${id}`)
    if (!ok(res)) this.fail(record, res)
  }

  async bulkDelete(record) {
    const ids = []
    for (const phoneId of record.change.body.ids || []) {
      const id = this.serverId(Number(phoneId))
      if (!this.exists('equipment', id) || ids.includes(id)) continue
      if (!isTempId(phoneId) && this.changedOnServer('equipment', id)) this.ask({ kind: 'changed_deleted', type: 'equipment', ids: [id], record, label: this.label('equipment', id) })
      else ids.push(id)
    }
    if (!ids.length) return this.skip()
    const res = await this.send(record, 'POST', '/api/equipment/bulk-delete', { ids })
    if (!ok(res)) this.fail(record, res)
  }

  /** A bulk change of one value (a field, the category, the group): each equipment merged on its own. */
  async bulk(record, attr, path, body) {
    const ids = []
    for (const phoneId of (record.change.body.ids || []).map(Number)) {
      const id = this.serverId(phoneId)
      if (!this.exists('equipment', id) || ids.includes(id)) continue
      const [before, after] = this.states(record, 'equipment', phoneId)
      // Not changed by it on the phone (already so, or an accessory)
      if (!before || !after || sameValue(valueOf(before, attr), valueOf(after, attr))) continue
      const server = stateOf(this.server, 'equipment', id)
      const now = valueOf(server, attr)
      if (sameValue(now, valueOf(after, attr))) continue
      if (sameValue(now, valueOf(before, attr))) ids.push(id)
      else this.conflictsOn(record, 'equipment', id, phoneId, [{ attr, phone: valueOf(after, attr), server: now }])
    }
    if (!ids.length) return this.skip()
    const res = await this.send(record, 'POST', path, { ...body, ids })
    if (!ok(res)) this.fail(record, res)
  }

  bulkUpdate(record) {
    const { action, key } = record.change.body
    return this.bulk(record, action === 'category' ? 'category' : `field:${String(key ?? '').trim()}`, '/api/equipment/bulk-update', this.mapBody(record.change.body))
  }

  assign(record) {
    const body = this.mapBody(record.change.body)
    if (body.group_id != null && !this.exists('group', body.group_id)) return this.drop(record, 'sync_depends_on_dropped')
    return this.bulk(record, 'group_id', '/api/groups/assign', body)
  }

  async photo(record, phoneId) {
    const id = this.target(record, 'equipment', phoneId)
    if (id == null) return
    const [before, after] = this.states(record, 'equipment', phoneId)
    const now = stateOf(this.server, 'equipment', id).photo
    if (now === after.photo) return this.skip()
    if (now !== before.photo) return this.ask({ kind: 'photo', type: 'equipment', id, record, label: this.label('equipment', id, phoneId), show: { removed: record.change.method === 'DELETE' } })
    await this.sendPhoto(record, id)
  }

  async sendPhoto(record, id) {
    const res = await this.send(record, record.change.method, `/api/equipment/${id}/photo`, record.change.method === 'DELETE' ? undefined : record.change.body)
    if (!ok(res)) this.fail(record, res)
  }

  async addToEquipment(record, phoneId) {
    const id = this.target(record, 'equipment', phoneId)
    if (id == null) return
    const what = record.change.path.split('/').pop()
    const res = await this.send(record, 'POST', `/api/equipment/${id}/${what}`, record.change.body)
    if (ok(res)) this.created(record, res)
    else this.fail(record, res)
  }

  async schedule(record, phoneId) {
    const id = this.serverId(phoneId)
    // Done or removed on the server meanwhile
    if (!this.exists('schedule', id)) return this.skip()
    const res = await this.send(record, record.change.method, `/api/maintenance/${id}`, record.change.method === 'DELETE' ? undefined : record.change.body)
    if (!ok(res)) this.fail(record, res)
  }

  /** The work was done: when the date is gone on the server, it is still logged. */
  async complete(record, phoneId) {
    const id = this.serverId(phoneId)
    if (this.exists('schedule', id)) {
      const res = await this.send(record, 'POST', `/api/maintenance/${id}/complete`, record.change.body)
      if (ok(res)) return this.created(record, res)
      return this.fail(record, res)
    }
    const [type, equipmentId] = (record.result.touched || []).find(([t]) => t === 'equipment') || []
    if (type == null) return this.skip()
    const target = this.target(record, 'equipment', equipmentId)
    if (target == null) return
    const { notes = null, cost = null } = record.change.body
    const done = record.change.body.done_at || record.change.at.slice(0, 10)
    const res = await this.send(record, 'POST', `/api/equipment/${target}/maintenance-records`, { title: record.result.effect.title, done_at: done, notes, cost })
    if (ok(res)) this.created(record, res)
    else this.fail(record, res)
  }

  async closeIssue(record, phoneId) {
    const id = this.serverId(phoneId)
    if (!this.exists('issue', id)) return this.skip()
    const res = await this.send(record, 'POST', `/api/issues/${id}/close`, record.change.body)
    // Closed on the server too
    if (!ok(res) && errorOf(res) !== 'already_closed') this.fail(record, res)
  }

  /* --- Groups and boxes */

  async create(record, type, path, taken) {
    const res = await this.send(record, 'POST', path, this.mapBody(record.change.body))
    if (ok(res)) return this.created(record, res)
    if (errorOf(res) === taken) {
      const phoneId = record.change.ids[0]
      this.waiting.add(`t:${phoneId}`)
      const field = type === 'box' ? 'number' : 'name'
      const value = String(record.change.body[field] ?? '').trim()
      const owner = type === 'box' ? [...this.server.boxes.values()].find((b) => b.number.toLowerCase() === value.toLowerCase()) : [...this.server.groups.values()].find((g) => g.name.toLowerCase() === value.toLowerCase())
      return this.ask({ kind: `${type}_taken`, type, phoneId, record, owner: owner?.id, label: value, show: { value } })
    }
    this.fail(record, res)
  }

  createGroup(record) {
    return this.create(record, 'group', '/api/groups', 'group_name_taken')
  }

  createBox(record) {
    return this.create(record, 'box', '/api/boxes', 'box_number_taken')
  }

  async update(record, type, phoneId, attrs, path) {
    const id = this.target(record, type, phoneId)
    if (id == null) return
    const [before, after] = this.states(record, type, phoneId)
    const server = stateOf(this.server, type, id)
    const { state, conflicts } = merge(before, after, server, attrs)
    this.conflictsOn(record, type, id, phoneId, conflicts)
    if (sameState(state, server, attrs)) return this.skip()
    const res = await this.send(record, 'PUT', `${path}/${id}`, Object.fromEntries(attrs.map((attr) => [attr, state[attr]])))
    if (!ok(res)) this.fail(record, res)
  }

  updateGroup(record, phoneId) {
    return this.update(record, 'group', phoneId, ['name', 'voucher_code', 'voucher_name'], '/api/groups')
  }

  updateBox(record, phoneId) {
    return this.update(record, 'box', phoneId, ['number', 'name', 'weight'], '/api/boxes')
  }

  async remove(record, type, phoneId, path) {
    const id = this.serverId(phoneId)
    if (!this.exists(type, id)) return this.skip()
    const res = await this.send(record, 'DELETE', `${path}/${id}`)
    if (!ok(res)) this.fail(record, res)
  }

  deleteGroup(record, phoneId) {
    return this.remove(record, 'group', phoneId, '/api/groups')
  }

  deleteBox(record, phoneId) {
    return this.remove(record, 'box', phoneId, '/api/boxes')
  }

  /** Into or out of a box: equipment gone on the server is left out. */
  async boxItems(record, phoneBox, phoneItem) {
    const adding = record.change.method === 'POST' && !record.change.path.endsWith('/remove')
    const box = adding ? this.target(record, 'box', phoneBox) : this.serverId(phoneBox)
    if (box == null || !this.exists('box', box)) return adding ? undefined : this.skip()
    let res
    if (phoneItem != null) {
      const item = this.serverId(phoneItem)
      if (!this.exists('equipment', item)) return this.skip()
      res = await this.send(record, 'DELETE', `/api/boxes/${box}/equipment/${item}`)
    } else {
      const body = this.mapBody(record.change.body)
      const ids = (body.ids || []).filter((id) => this.exists('equipment', id))
      const groups = (body.group_ids || []).filter((id) => this.exists('group', id))
      if (!ids.length && !groups.length) return this.skip()
      res = await this.send(record, 'POST', record.change.path.replace(/\/boxes\/\d+\//, `/boxes/${box}/`), adding ? { ids, group_ids: groups } : { ids })
    }
    if (!ok(res)) this.fail(record, res)
  }

  /* --- The answers */

  async resolve(conflicts, answers) {
    // Values: one edit per item, with every value the person chose from the phone
    const picked = new Map()
    for (const conflict of conflicts) {
      const answer = answers[conflict.question.id] || {}
      const { kind, type, record } = conflict
      if (kind === 'field') {
        if (answer.choice !== 'phone') continue
        const key = keyOf(type, conflict.id)
        if (!picked.has(key)) picked.set(key, { type, id: conflict.id, record, values: [] })
        picked.get(key).values.push(conflict)
      } else if (kind === 'photo') {
        if (answer.choice === 'phone') await this.sendPhoto(record, conflict.id)
      } else if (kind === 'changed_deleted') {
        if (answer.choice !== 'delete') continue
        for (const id of conflict.ids) {
          const res = await this.send(record, 'DELETE', `/api/equipment/${id}`, undefined, `:${id}`)
          if (!ok(res)) this.fail(record, res)
        }
      } else if (kind.endsWith('_taken')) {
        await this.resolveTaken(conflict, answer)
      } else if (kind.endsWith('_deleted')) {
        await this.resolveDeleted(conflict, answer)
      }
    }
    for (const { type, id, record, values } of picked.values()) {
      if (!this.exists(type, id)) continue
      const state = stateOf(this.server, type, id)
      const phoneFields = this.last.get(keyOf(type, id))?.fields || []
      for (const conflict of values) setValue(state, conflict.attr, conflict.phone, phoneFields)
      const path = { equipment: '/api/equipment', box: '/api/boxes', group: '/api/groups' }[type]
      const body = type === 'equipment' ? equipmentBody(state) : type === 'box' ? boxState(state) : groupState(state)
      const res = await this.send(record, 'PUT', `${path}/${id}`, body, ':chosen')
      if (!ok(res)) this.fail(record, res)
    }
  }

  /** What the phone added exists on the server: one with the other, another number or name, or not added. */
  async resolveTaken(conflict, answer) {
    const { record, phoneId, type } = conflict
    this.waiting.delete(`t:${phoneId}`)
    if (answer.choice === 'merge' && conflict.owner != null) {
      this.ids.set(phoneId, conflict.owner)
      if (type === 'equipment') await this.fillIn(record, phoneId, conflict.owner)
      return
    }
    if (answer.choice === 'rename' && String(answer.value ?? '').trim()) {
      const field = { equipment: 'serial_number', box: 'number', group: 'name' }[type]
      // The server kept nothing of the refused request: the same key goes again
      record.change = { ...record.change, body: { ...record.change.body, [field]: String(answer.value).trim() } }
      if (type === 'equipment') return this.createEquipment(record)
      return type === 'box' ? this.createBox(record) : this.createGroup(record)
    }
    this.dropped.add(`t:${phoneId}`)
    this.report.dropped.push({ id: record.change.id, effect: record.result.effect, reason: 'sync_dropped_by_choice' })
  }

  /** Joined with the existing equipment: what it has stays, what only the phone had is added. */
  async fillIn(record, phoneId, id) {
    const server = stateOf(this.server, 'equipment', id)
    const phone = record.after.get(keyOf('equipment', phoneId))
    if (!server || !phone) return
    const state = { ...server, fields: server.fields.map((f) => ({ ...f })) }
    for (const attr of ['name', 'row_no', 'category']) if (state[attr] == null && phone[attr] != null) state[attr] = phone[attr]
    for (const field of phone.fields) if (fieldValue(state, field.key) === ABSENT) state.fields.push({ ...field })
    if (sameState(state, server, EQUIPMENT_ATTRS)) return
    const res = await this.send(record, 'PUT', `/api/equipment/${id}`, equipmentBody(state), ':merge')
    if (!ok(res)) this.fail(record, res)
  }

  /** Changed on the phone, deleted on the server: brought back (as the phone has it), or left deleted. */
  async resolveDeleted(conflict, answer) {
    const { type, id, record } = conflict
    const key = keyOf(type, id)
    this.waiting.delete(key)
    if (answer.choice !== 'restore') {
      this.dropped.add(key)
      return
    }
    if (type === 'equipment') {
      const res = await this.send(record, 'POST', `/api/equipment/${id}/restore`, {}, ':restore')
      if (!ok(res)) {
        this.dropped.add(key)
        this.fail(record, res)
      }
      this.stale = true
      return
    }
    // A box or group is made again, as the phone last had it
    const last = this.last.get(key) || stateOf(this.base, type, id)
    const body = type === 'box' ? boxState(last) : groupState(last)
    const res = await this.send(record, 'POST', type === 'box' ? '/api/boxes' : '/api/groups', body, ':recreate')
    if (!ok(res)) {
      this.dropped.add(key)
      return this.fail(record, res)
    }
    this.ids.set(id, res.json.id)
    if (type === 'group') {
      // Its members on the phone join it again
      const members = [...this.final.equipment.values()].filter((e) => e.group_id === id && e.parent_id == null).map((e) => this.serverId(e.id)).filter((x) => x != null)
      const ids = members.filter((x) => this.exists('equipment', x))
      if (ids.length) {
        const sent = await this.send(record, 'POST', '/api/groups/assign', { ids, group_id: res.json.id }, ':members')
        if (!ok(sent)) this.fail(record, sent)
      }
    }
  }
}
