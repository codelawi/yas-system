// Edits made in the Word editor. A document is { tables, mappings }, one mapping per table.
// Every function returns a new document, so the editor can undo by keeping the old one.

import { cellId, cleanKey, columnsForHeader, firstNonEmptyRow, keysFromRow, pairCells, pairRolesFor } from './importMapping'

const replaceAt = (list, i, value) => list.map((item, n) => (n === i ? value : item))

function patch(doc, ti, tablePatch, mappingPatch) {
  return {
    tables: tablePatch ? replaceAt(doc.tables, ti, { ...doc.tables[ti], ...tablePatch }) : doc.tables,
    mappings: mappingPatch ? replaceAt(doc.mappings, ti, { ...doc.mappings[ti], ...mappingPatch }) : doc.mappings,
  }
}

/** Moves everything that points at a cell of table `ti` after its rows or columns changed; null means removed. */
function reshape(doc, ti, rowTo, colTo) {
  const index = doc.tables[ti].index
  const cellTo = (r, c) => {
    const row = rowTo(r)
    const col = colTo(c)
    return row === null || col === null ? null : [row, col]
  }
  const moved = (entries) =>
    Object.fromEntries(
      Object.entries(entries || {}).flatMap(([id, value]) => {
        const [r, c] = id.split(':').map(Number)
        const to = cellTo(r, c)
        return to ? [[cellId(...to), value]] : []
      }),
    )

  const tables = doc.tables.map((table, i) => {
    const targets = Object.entries(table.links || {}).flatMap(([id, link]) => {
      if (link.t !== index) return [[id, link]]
      const to = cellTo(link.r, link.c)
      return to ? [[id, { ...link, r: to[0], c: to[1] }]] : []
    })
    const links = Object.fromEntries(targets)
    if (i !== ti) return { ...table, links }
    return { ...table, links: moved(links), vmerged: table.vmerged.flatMap(([r, c]) => (cellTo(r, c) ? [cellTo(r, c)] : [])) }
  })

  const mapping = doc.mappings[ti]
  const rowGroups = Object.fromEntries(Object.entries(mapping.rowGroups || {}).flatMap(([r, group]) => (rowTo(Number(r)) === null ? [] : [[rowTo(Number(r)), group]])))
  return { tables, mappings: replaceAt(doc.mappings, ti, { ...mapping, cellRoles: moved(mapping.cellRoles), rowGroups }) }
}

export function insertRows(doc, ti, at, count = 1) {
  const next = reshape(doc, ti, (r) => (r >= at ? r + count : r), (c) => c)
  const table = next.tables[ti]
  const width = table.grid[0]?.length || 1
  const blank = Array.from({ length: count }, () => Array(width).fill(''))
  const headerRow = next.mappings[ti].headerRow
  return patch(
    next,
    ti,
    { grid: [...table.grid.slice(0, at), ...blank, ...table.grid.slice(at)], spans: table.spans.map(([r, c, span]) => [r >= at ? r + count : r, c, span]) },
    { headerRow: headerRow >= at ? headerRow + count : headerRow },
  )
}

export function deleteRows(doc, ti, rows) {
  const gone = new Set(rows)
  if (gone.size >= doc.tables[ti].grid.length) return doc
  const rowTo = (r) => (gone.has(r) ? null : r - [...gone].filter((g) => g < r).length)
  const next = reshape(doc, ti, rowTo, (c) => c)
  const table = next.tables[ti]
  const mapping = next.mappings[ti]
  const grid = table.grid.filter((_, r) => !gone.has(r))
  const spans = table.spans.flatMap(([r, c, span]) => (gone.has(r) ? [] : [[rowTo(r), c, span]]))
  const headerGone = gone.has(mapping.headerRow)
  const headerRow = headerGone ? firstNonEmptyRow(grid) : rowTo(mapping.headerRow)
  const keys = keysFromRow(grid[headerRow] || [])
  return patch(next, ti, { grid, spans }, { headerRow, columns: headerGone ? mapping.columns.map((col, c) => ({ ...col, key: keys[c] ?? col.key })) : mapping.columns })
}

export function insertColumn(doc, ti, at) {
  const next = reshape(doc, ti, (r) => r, (c) => (c >= at ? c + 1 : c))
  const table = next.tables[ti]
  const mapping = next.mappings[ti]
  const grid = table.grid.map((row) => [...row.slice(0, at), '', ...row.slice(at)])
  const spans = table.spans.map(([r, c, span]) => (c >= at ? [r, c + 1, span] : at < c + span ? [r, c, span + 1] : [r, c, span]))
  const key = keysFromRow(grid[mapping.headerRow] || [])[at] ?? `Column ${at + 1}`
  return patch(next, ti, { grid, spans }, { columns: [...mapping.columns.slice(0, at), { role: 'field', key }, ...mapping.columns.slice(at)] })
}

export function deleteColumns(doc, ti, cols) {
  const gone = new Set(cols)
  if (gone.size >= (doc.tables[ti].grid[0]?.length || 0)) return doc
  const colTo = (c) => (gone.has(c) ? null : c - [...gone].filter((g) => g < c).length)
  const next = reshape(doc, ti, (r) => r, colTo)
  const table = next.tables[ti]
  const spans = table.spans.flatMap(([r, c, span]) => {
    const left = Array.from({ length: span }, (_, i) => c + i).filter((col) => !gone.has(col))
    return left.length > 1 ? [[r, colTo(left[0]), left.length]] : []
  })
  return patch(
    next,
    ti,
    { grid: table.grid.map((row) => row.filter((_, c) => !gone.has(c))), spans },
    { columns: next.mappings[ti].columns.filter((_, c) => !gone.has(c)) },
  )
}

/** Typing replaces a cell, so its link and merged look go; names of fields follow their header or key cell. */
export function setCells(doc, ti, edits) {
  const table = doc.tables[ti]
  const mapping = doc.mappings[ti]
  const keyAt = mapping.layout === 'pairs' ? Object.fromEntries(pairCells(table, doc).map((p) => [cellId(...p.keyCell), p.key])) : {}
  const grid = table.grid.map((row) => [...row])
  const links = { ...table.links }
  const edited = new Set(edits.map(({ r, c }) => cellId(r, c)))
  for (const { r, c, value } of edits) {
    grid[r][c] = value
    delete links[cellId(r, c)]
  }

  const mappingPatch = {}
  const headerCols = edits.filter(({ r }) => r === mapping.headerRow).map(({ c }) => c)
  if (mapping.layout === 'rows' && headerCols.length) {
    const keys = keysFromRow(grid[mapping.headerRow])
    mappingPatch.columns = mapping.columns.map((col, c) => (headerCols.includes(c) ? { ...col, key: keys[c] } : col))
  }
  const pairRoles = { ...mapping.pairRoles }
  for (const { r, c, value } of edits) {
    const oldKey = keyAt[cellId(r, c)]
    const newKey = cleanKey(value)
    if (oldKey && newKey && oldKey !== newKey && oldKey in pairRoles) {
      pairRoles[newKey] = pairRoles[oldKey]
      delete pairRoles[oldKey]
    }
  }
  if (mapping.layout === 'pairs') mappingPatch.pairRoles = pairRoles

  return patch(doc, ti, { grid, links, vmerged: table.vmerged.filter(([r, c]) => !edited.has(cellId(r, c))) }, mappingPatch)
}

/** Pastes rows of cells at (r0, c0), adding rows and columns when the block is bigger than the table. */
export function pasteBlock(doc, ti, r0, c0, block) {
  let next = doc
  const height = next.tables[ti].grid.length
  if (r0 + block.length > height) next = insertRows(next, ti, height, r0 + block.length - height)
  const needed = c0 + Math.max(...block.map((row) => row.length))
  while ((next.tables[ti].grid[0]?.length || 0) < needed) next = insertColumn(next, ti, next.tables[ti].grid[0].length)
  return setCells(next, ti, block.flatMap((row, r) => row.map((value, c) => ({ r: r0 + r, c: c0 + c, value }))))
}

export function linkCells(doc, ti, cells, source) {
  const table = doc.tables[ti]
  const links = { ...table.links }
  for (const [r, c] of cells) {
    if (source.t !== table.index || source.r !== r || source.c !== c) links[cellId(r, c)] = source
  }
  return patch(doc, ti, { links })
}

export function unlinkCells(doc, ti, cells) {
  const links = { ...doc.tables[ti].links }
  for (const [r, c] of cells) delete links[cellId(r, c)]
  return patch(doc, ti, { links })
}

/**
 * Sets a role on the selected cells. A selection with the header cell, or with every
 * item in a column, is about the column; anything less is about those cells only.
 */
export function setRole(doc, ti, cells, role) {
  const table = doc.tables[ti]
  const mapping = doc.mappings[ti]
  const single = role === 'serial' || role === 'row_no'

  if (mapping.layout === 'pairs') {
    const chosen = new Set(cells.map(([r, c]) => cellId(r, c)))
    const keys = pairCells(table, doc)
      .filter((p) => chosen.has(cellId(...p.keyCell)) || (p.valueCell && chosen.has(cellId(...p.valueCell))))
      .map((p) => p.key)
    if (!keys.length) return doc
    const roles = Object.fromEntries(Object.entries(mapping.pairRoles).map(([key, old]) => [key, single && old === role ? 'field' : old]))
    for (const key of single ? keys.slice(0, 1) : keys) roles[key] = role
    return patch(doc, ti, null, { pairRoles: roles })
  }
  if (mapping.layout !== 'rows') return doc

  const headerRow = mapping.headerRow
  const dataRows = table.grid.flatMap((row, r) => (r > headerRow && row.some((v) => String(v).trim()) ? [r] : []))
  const byColumn = new Map()
  for (const [r, c] of cells) byColumn.set(c, [...(byColumn.get(c) || []), r])

  let columns = mapping.columns
  const cellRoles = { ...mapping.cellRoles }
  for (const [c, rows] of byColumn) {
    const wholeColumn = rows.includes(headerRow) || (dataRows.length > 1 && dataRows.every((r) => rows.includes(r)))
    if (wholeColumn) {
      columns = columns.map((col, i) => (i === c ? { ...col, role } : single && col.role === role ? { ...col, role: 'field' } : col))
      table.grid.forEach((_, r) => delete cellRoles[cellId(r, c)])
    } else {
      for (const r of rows) {
        if (r <= headerRow) continue
        if (role === columns[c]?.role) delete cellRoles[cellId(r, c)]
        else cellRoles[cellId(r, c)] = role
      }
    }
  }
  return patch(doc, ti, null, { columns, cellRoles })
}

export function setLayout(doc, ti, layout, aliases, accessoryKeys) {
  const table = doc.tables[ti]
  const mapping = doc.mappings[ti]
  if (layout === 'rows' && !mapping.rowsReady) {
    const headerRow = firstNonEmptyRow(table.grid)
    return patch(doc, ti, null, { layout, rowsReady: true, headerRow, columns: columnsForHeader(table.grid, headerRow, aliases, accessoryKeys) })
  }
  if (layout === 'pairs' && !mapping.pairsReady) {
    return patch(doc, ti, null, { layout, pairsReady: true, pairRoles: pairRolesFor(table.grid, aliases, accessoryKeys) })
  }
  return patch(doc, ti, null, { layout })
}

export function setHeaderRow(doc, ti, headerRow, aliases, accessoryKeys) {
  return patch(doc, ti, null, { headerRow, columns: columnsForHeader(doc.tables[ti].grid, headerRow, aliases, accessoryKeys) })
}

export const setTitle = (doc, ti, title) => patch(doc, ti, { title })

/** `group`: a group id, null for no group, undefined for the one chosen for the whole import. */
export const setTableGroup = (doc, ti, group) => patch(doc, ti, null, { group })

export function setRowGroups(doc, ti, rows, group) {
  const rowGroups = { ...doc.mappings[ti].rowGroups }
  for (const r of rows) {
    if (group === undefined) delete rowGroups[r]
    else rowGroups[r] = group
  }
  return patch(doc, ti, null, { rowGroups })
}

/** A new table with a header row and three empty rows, after the last one. */
export function addTable(doc, { title, headers, aliases }) {
  const index = Math.max(0, ...doc.tables.map((tb) => tb.index)) + 1
  const grid = [headers, ...Array.from({ length: 3 }, () => headers.map(() => ''))]
  const columns = columnsForHeader(grid, 0, aliases)
  if (!columns.some((col) => col.role === 'serial')) columns[0] = { ...columns[0], role: 'serial' }
  return {
    tables: [...doc.tables, { index, title, grid, spans: [], vmerged: [], links: {}, detected: {} }],
    mappings: [...doc.mappings, { layout: 'rows', rowsReady: true, pairsReady: false, headerRow: 0, columns, pairRoles: {}, cellRoles: {}, rowGroups: {} }],
  }
}

export function deleteTable(doc, ti) {
  const index = doc.tables[ti].index
  return {
    tables: doc.tables
      .filter((_, i) => i !== ti)
      .map((table) => ({ ...table, links: Object.fromEntries(Object.entries(table.links || {}).filter(([, link]) => link.t !== index)) })),
    mappings: doc.mappings.filter((_, i) => i !== ti),
  }
}
