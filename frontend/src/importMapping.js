// Turns Word tables (as returned by /api/imports/preview) into equipment items,
// following a per-table "mapping" the user can edit in the table viewer.
// Mirrors the detection rules of app/Services/WordTableParser.php.

export const ROLES = ['serial', 'row_no', 'field', 'accessory', 'ignore']

/** Same normalization as the PHP parser: Arabic letter variants, case, spacing. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s:：.\-_]+|[\s:：.\-_]+$/g, '')
}

const DIGITS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9, '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 }

/** "١٢" / "12." → 12; anything else → null */
export function parseRowNo(text) {
  const western = String(text ?? '')
    .trim()
    .replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d])
    .replace(/[.\-)]+$/, '')
  return /^\d{1,9}$/.test(western) ? Number(western) : null
}

export const cleanKey = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:：]+|[\s:：]+$/g, '')

const isEmptyRow = (row) => row.every((c) => !String(c).trim())
const splitLines = (value) =>
  String(value)
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean)

/** Mapping to start from: what the server detected, plus remembered accessory columns. */
export function initialMapping(table, accessoryKeys = []) {
  const d = table.detected
  const asAccessory = (role, key) => (role === 'field' && accessoryKeys.includes(key) ? 'accessory' : role)
  return {
    layout: d.layout,
    // Whether columns / pair roles have been worked out for that layout yet
    rowsReady: d.layout === 'rows',
    pairsReady: d.layout === 'pairs',
    headerRow: d.header_row ?? firstNonEmptyRow(table.grid),
    columns: (table.grid[0] || []).map((_, c) => {
      const col = d.columns?.[c] ?? { role: 'field', key: `Column ${c + 1}` }
      return { role: asAccessory(col.role, col.key), key: col.key }
    }),
    pairRoles: Object.fromEntries(Object.entries(d.pair_roles || {}).map(([k, r]) => [k, asAccessory(r, k)])),
  }
}

export function firstNonEmptyRow(grid) {
  const r = grid.findIndex((row) => !isEmptyRow(row))
  return r < 0 ? 0 : r
}

/** Header cells → unique single-line keys (same as the PHP parser). */
export function keysFromRow(row) {
  const seen = {}
  return row.map((cell, c) => {
    let key = cleanKey(cell) || `Column ${c + 1}`
    const n = normalize(key)
    seen[n] = (seen[n] || 0) + 1
    if (seen[n] > 1) key += ` (${seen[n]})`
    return key
  })
}

/** Keys of a Key | Value table, in reading order. */
export function pairKeys(grid) {
  const keys = []
  for (const row of grid) {
    const cells = row.filter((c) => String(c).trim())
    for (let i = 0; i < cells.length; i += 2) {
      const key = cleanKey(cells[i])
      if (key && !keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

/**
 * Items of one table. Each item: { uid, import_id, file, table, title, row, row_no, serial, fields, accessories }.
 * `row` is the 1-based row in the Word table (null for Key | Value tables).
 */
export function buildItems(table, mapping, file) {
  const base = { import_id: file.import_id, file: file.file, table: table.index, title: table.title }
  if (!mapping || mapping.layout === 'ignore') return []

  if (mapping.layout === 'pairs') {
    let serial = ''
    let rowNo = null
    const fields = []
    const accessories = []
    for (const row of table.grid) {
      const cells = row.filter((c) => String(c).trim())
      for (let i = 0; i < cells.length; i += 2) {
        const key = cleanKey(cells[i])
        const value = String(cells[i + 1] ?? '').trim()
        if (!key) continue
        const role = mapping.pairRoles[key] || 'field'
        if (role === 'serial' && !serial) serial = value
        else if (role === 'row_no' && rowNo === null && parseRowNo(value) !== null) rowNo = parseRowNo(value)
        else if (role === 'accessory') splitLines(value).forEach((s) => accessories.push({ name: key, serial: s }))
        else if (role === 'field' && value) fields.push({ key, value })
      }
    }
    if (!serial && !fields.length && !accessories.length) return []
    return [{ ...base, uid: `${file.import_id}:${table.index}:p`, row: null, row_no: rowNo, serial: serial || null, fields, accessories }]
  }

  // rows: one equipment per row below the header row
  const headerRow = mapping.headerRow ?? 0
  const headerSig = (table.grid[headerRow] || []).map(normalize).join('|')
  const items = []
  table.grid.forEach((row, r) => {
    if (r <= headerRow || isEmptyRow(row)) return
    if (row.map(normalize).join('|') === headerSig) return // header repeated on a new page

    let serial = ''
    let rowNo = null
    const fields = []
    const accessories = []
    mapping.columns.forEach((col, c) => {
      const value = String(row[c] ?? '').trim()
      if (!value) return
      if (col.role === 'serial' && !serial) serial = value
      else if (col.role === 'row_no') {
        // Text that is not a number is kept as a normal field
        if (parseRowNo(value) !== null) rowNo = parseRowNo(value)
        else fields.push({ key: col.key, value })
      } else if (col.role === 'accessory') splitLines(value).forEach((s) => accessories.push({ name: col.key, serial: s }))
      else if (col.role === 'field') fields.push({ key: col.key, value })
    })
    if (!serial && !fields.length && !accessories.length) return
    items.push({ ...base, uid: `${file.import_id}:${table.index}:${r}`, row: r + 1, row_no: rowNo, serial: serial || null, fields, accessories })
  })
  return items
}

/** Which grid rows become items (for highlighting in the viewer). */
export function itemRows(table, mapping) {
  return new Set(
    buildItems(table, mapping, { import_id: 0, file: '' })
      .map((i) => (i.row ? i.row - 1 : null))
      .filter((r) => r !== null),
  )
}

/** Every key the user could mark as an accessory column, across all tables. */
export function accessoryCandidates(files, mappings) {
  const keys = new Set()
  files.forEach((f) =>
    f.tables.forEach((t, ti) => {
      const m = mappings[f.import_id]?.[ti]
      if (!m || m.layout === 'ignore') return
      if (m.layout === 'rows') m.columns.forEach((c) => ['field', 'accessory'].includes(c.role) && keys.add(c.key))
      else Object.entries(m.pairRoles).forEach(([k, r]) => ['field', 'accessory'].includes(r) && keys.add(k))
    }),
  )
  return [...keys]
}

/** Keys currently used as accessory columns anywhere. */
export function activeAccessoryKeys(files, mappings) {
  const keys = new Set()
  files.forEach((f) =>
    (mappings[f.import_id] || []).forEach((m) => {
      if (m.layout === 'rows') m.columns.forEach((c) => c.role === 'accessory' && keys.add(c.key))
      if (m.layout === 'pairs') Object.entries(m.pairRoles).forEach(([k, r]) => r === 'accessory' && keys.add(k))
    }),
  )
  return [...keys]
}

/** Sets the accessory role on exactly the given keys, in every table. */
export function applyAccessoryKeys(mappings, keys) {
  const flip = (role, key) => (keys.includes(key) ? (role === 'field' || role === 'accessory' ? 'accessory' : role) : role === 'accessory' ? 'field' : role)
  return Object.fromEntries(
    Object.entries(mappings).map(([id, list]) => [
      id,
      list.map((m) => ({
        ...m,
        columns: m.columns.map((c) => ({ ...c, role: flip(c.role, c.key) })),
        pairRoles: Object.fromEntries(Object.entries(m.pairRoles).map(([k, r]) => [k, flip(r, k)])),
      })),
    ]),
  )
}

/** Serial / ت header names from the settings, normalized. */
export function aliasesFrom(settings) {
  const list = (text) => String(text || '').split(/\r?\n/).map(normalize).filter(Boolean)
  return { serial: list(settings.serial_aliases), rowNo: list(settings.row_no_aliases) }
}

/** Columns when `headerRow` is the header: serial / ت found by name, the rest are fields. */
export function columnsForHeader(grid, headerRow, aliases, accessoryKeys = []) {
  const header = grid[headerRow] || []
  let serialSeen = false
  let rowNoSeen = false
  return keysFromRow(header).map((key, c) => {
    const n = normalize(header[c])
    let role = 'field'
    if (!serialSeen && aliases.serial.includes(n)) {
      role = 'serial'
      serialSeen = true
    } else if (!rowNoSeen && aliases.rowNo.includes(n)) {
      role = 'row_no'
      rowNoSeen = true
    } else if (accessoryKeys.includes(key)) role = 'accessory'
    return { role, key }
  })
}

/** Roles for the keys of a Key | Value table. */
export function pairRolesFor(grid, aliases, accessoryKeys = []) {
  const roles = {}
  for (const key of pairKeys(grid)) {
    const n = normalize(key)
    const used = Object.values(roles)
    roles[key] = !used.includes('serial') && aliases.serial.includes(n) ? 'serial' : !used.includes('row_no') && aliases.rowNo.includes(n) ? 'row_no' : accessoryKeys.includes(key) ? 'accessory' : 'field'
  }
  return roles
}
