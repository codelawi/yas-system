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

/**
 * The accessories in a cell, one per line. A short number is how many there are, and any
 * Arabic text after it a note ("1حقيبة كتان"); their serial is made once the equipment's is
 * known. Anything else is the accessory's own serial. A count of 0 or a line with no letter
 * or digit ("-") means there is none.
 */
export function accessoriesFrom(name, value) {
  return splitLines(value).flatMap((line) => {
    if (!/[\p{L}\p{N}]/u.test(line)) return []
    const match = line.match(/^([0-9٠-٩۰-۹]{1,3})[.\-)]?\s*([\u0600-\u06FF].*)?$/u)
    if (!match) return [{ name, serial: line }]
    const quantity = parseRowNo(match[1])
    return quantity ? [{ name, quantity, note: match[2]?.trim() || null, raw: line }] : []
  })
}

/** 5501 + the third accessory in its row → 5501ACC03. */
export function withAccessorySerials(serial, accessories) {
  if (!serial) return accessories
  return accessories.map((a, i) => (a.quantity ? { ...a, serial: `${serial}ACC${String(i + 1).padStart(2, '0')}` } : a))
}

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

export const cellId = (r, c) => `${r}:${c}`

/** Text of a cell: its own, or the text of the cell it is linked to (a loop of links gives nothing). */
export function cellValue(file, table, r, c, seen = new Set()) {
  const here = `${table.index}:${r}:${c}`
  if (seen.has(here)) return ''
  seen.add(here)
  const link = table.links?.[cellId(r, c)]
  if (!link) return String(table.grid[r]?.[c] ?? '')
  const source = link.t === table.index ? table : file.tables?.find((tb) => tb.index === link.t)
  return source ? cellValue(file, source, link.r, link.c, seen) : ''
}

/** The table's cells as they read after links. */
export function effectiveGrid(table, file) {
  const ids = Object.keys(table.links || {})
  if (!ids.length) return table.grid
  const grid = table.grid.map((row) => [...row])
  for (const id of ids) {
    const [r, c] = id.split(':').map(Number)
    if (grid[r]) grid[r][c] = cellValue(file, table, r, c)
  }
  return grid
}

/**
 * Key and value cells of a Key | Value table, in reading order.
 * A link on the key cell gives that key its value; a link on the value cell works as usual.
 */
export function pairCells(table, file) {
  const pairs = []
  table.grid.forEach((row, r) => {
    const used = row.flatMap((cell, c) => (String(cell).trim() || table.links?.[cellId(r, c)] ? [c] : []))
    for (let i = 0; i < used.length; i += 2) {
      const keyCol = used[i]
      const valueCol = used[i + 1] ?? null
      const key = cleanKey(row[keyCol])
      if (!key) continue
      const from = table.links?.[cellId(r, keyCol)] ? keyCol : valueCol
      pairs.push({ key, value: from === null ? '' : cellValue(file, table, r, from).trim(), keyCell: [r, keyCol], valueCell: valueCol === null ? null : [r, valueCol] })
    }
  })
  return pairs
}

/** Group chosen for one item: undefined means the one chosen for the whole import. */
function groupOf(mapping, r) {
  return r !== null && mapping.rowGroups && r in mapping.rowGroups ? mapping.rowGroups[r] : mapping.group
}

/**
 * A link on a cell outside the item rows (the header or a title) adds that field to every item:
 * the cell's text is the field name, the linked cell its value.
 */
function tableFields(table, mapping, file) {
  const headerRow = mapping.headerRow ?? 0
  return Object.keys(table.links || {}).flatMap((id) => {
    const [r, c] = id.split(':').map(Number)
    if (r > headerRow || (r === headerRow && mapping.columns[c]?.role !== 'field')) return []
    const key = r === headerRow ? mapping.columns[c]?.key : cleanKey(table.grid[r]?.[c])
    const value = cellValue(file, table, r, c).trim()
    return key && value ? [{ key, value }] : []
  })
}

/**
 * Items of one table. Each item: { uid, import_id, file, table, title, row, row_no, serial, fields, accessories, group }.
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
    for (const { key, value } of pairCells(table, file)) {
      const role = mapping.pairRoles[key] || 'field'
      if (role === 'serial' && !serial) serial = value
      else if (role === 'row_no' && rowNo === null && parseRowNo(value) !== null) rowNo = parseRowNo(value)
      else if (role === 'accessory') accessories.push(...accessoriesFrom(key, value))
      else if (role === 'field' && value) fields.push({ key, value })
    }
    if (!serial && !fields.length && !accessories.length) return []
    return [{ ...base, uid: `${file.import_id}:${table.index}:p`, row: null, row_no: rowNo, serial: serial || null, fields, accessories, group: groupOf(mapping, null) }]
  }

  // rows: one equipment per row below the header row
  const headerRow = mapping.headerRow ?? 0
  const headerSig = (table.grid[headerRow] || []).map(normalize).join('|')
  const shared = tableFields(table, mapping, file)
  const items = []
  effectiveGrid(table, file).forEach((row, r) => {
    if (r <= headerRow || isEmptyRow(row)) return
    if (row.map(normalize).join('|') === headerSig) return // header repeated on a new page

    let serial = ''
    let rowNo = null
    let serialPinned = false
    const fields = []
    const accessories = []
    mapping.columns.forEach((col, c) => {
      const value = String(row[c] ?? '').trim()
      if (!value) return
      // A role chosen for this one cell comes before its column's role
      const cellRole = mapping.cellRoles?.[cellId(r, c)]
      const role = cellRole ?? col.role
      if (role === 'serial') {
        if (cellRole === 'serial' && !serialPinned) {
          serial = value
          serialPinned = true
        } else if (!serial) serial = value
      } else if (role === 'row_no') {
        // Text that is not a number is kept as a normal field
        if (parseRowNo(value) !== null) rowNo = parseRowNo(value)
        else fields.push({ key: col.key, value })
      } else if (role === 'accessory') accessories.push(...accessoriesFrom(col.key, value))
      else if (role === 'field') fields.push({ key: col.key, value })
    })
    if (!serial && !fields.length && !accessories.length) return
    const merged = [...fields.filter((f) => !shared.some((s) => s.key === f.key)), ...shared]
    items.push({ ...base, uid: `${file.import_id}:${table.index}:${r}`, row: r + 1, row_no: rowNo, serial: serial || null, fields: merged, accessories, group: groupOf(mapping, r) })
  })
  return items
}

/** Which grid rows become items (for highlighting in the viewer). */
export function itemRows(table, mapping, file) {
  return new Set(
    buildItems(table, mapping, file)
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

/** The serial column by name: an exact match, or else a longer name such as «الرقم التسلسلي للجهاز». */
function serialColumn(header, aliases) {
  const names = header.map(normalize)
  const exact = names.findIndex((n) => aliases.serial.includes(n))
  return exact >= 0 ? exact : names.findIndex((n) => aliases.serial.some((a) => n.startsWith(`${a} `)))
}

/** Columns when `headerRow` is the header: serial / ت found by name, the rest are fields. */
export function columnsForHeader(grid, headerRow, aliases, accessoryKeys = []) {
  const header = grid[headerRow] || []
  const serialCol = serialColumn(header, aliases)
  let rowNoSeen = false
  return keysFromRow(header).map((key, c) => {
    const n = normalize(header[c])
    let role = 'field'
    if (c === serialCol) role = 'serial'
    else if (!rowNoSeen && aliases.rowNo.includes(n)) {
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
