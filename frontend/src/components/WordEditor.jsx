import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Divider, Empty, Input, Modal, Popconfirm, Segmented, Select, Tag, Tooltip, Typography } from 'antd'
import {
  ApartmentOutlined,
  CheckOutlined,
  DeleteColumnOutlined,
  DeleteOutlined,
  DeleteRowOutlined,
  DisconnectOutlined,
  FileWordOutlined,
  InsertRowAboveOutlined,
  InsertRowBelowOutlined,
  InsertRowLeftOutlined,
  InsertRowRightOutlined,
  LinkOutlined,
  PlusOutlined,
  RedoOutlined,
  StarOutlined,
  StopOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import { ROLES, aliasesFrom, buildItems, cellId, effectiveGrid, pairCells } from '../importMapping'
import * as edit from '../importEdit'

const ROLE_ICON = { serial: '#', row_no: 'ت', field: 'A', accessory: <ApartmentOutlined />, ignore: <StopOutlined /> }

const parseId = (id) => id.split(':').map(Number)

/** Every cell id in the rectangle between two cells. */
function rectIds(a, b) {
  const ids = []
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) ids.push(cellId(r, c))
  }
  return ids
}

/** What the sheet shows for a table, worked out once per change of the document. */
function viewOf(table, mapping, doc, file) {
  const items = buildItems(table, mapping, { ...file, tables: doc.tables })
  const pairRoles = {}
  if (mapping.layout === 'pairs') {
    for (const pair of pairCells(table, doc)) {
      const role = mapping.pairRoles[pair.key] || 'field'
      pairRoles[cellId(...pair.keyCell)] = role
      if (pair.valueCell) pairRoles[cellId(...pair.valueCell)] = role
    }
  }
  return {
    grid: effectiveGrid(table, doc),
    used: new Set(items.flatMap((i) => (i.row ? [i.row - 1] : []))),
    items: items.length,
    accessories: items.reduce((n, i) => n + i.accessories.length, 0),
    noSerial: items.filter((i) => !i.serial).length,
    pairRoles,
  }
}

/**
 * The file's tables on one page, like the Word document itself, with the system's
 * additions on top: what each cell means, links between cells and the group.
 */
export default function WordEditor({ file, mappings, accessoryKeys, groups, onGroupCreated, onApply, onClose }) {
  const { t, dir } = useLang()
  const { settings } = useSettings()
  const { message, modal } = App.useApp()
  const aliases = useMemo(() => aliasesFrom(settings), [settings])
  const [history, setHistory] = useState({ doc: { tables: file.tables, mappings }, past: [], future: [] })
  const [sel, setSel] = useState(null)
  const [editing, setEditingState] = useState(null)
  const editingNow = useRef(null)
  const [linking, setLinking] = useState(null)
  const [newGroup, setNewGroup] = useState(null)
  const dragging = useRef(false)
  const end = useRef(null)
  const { doc } = history

  // The ref lets a blur that follows Enter or Esc see that the edit has already ended
  const setEditing = useCallback((value) => {
    editingNow.current = value
    setEditingState(value)
  }, [])

  const change = useCallback((fn) => {
    setHistory((h) => {
      const next = fn(h.doc)
      return next === h.doc ? h : { doc: next, past: [...h.past.slice(-49), h.doc], future: [] }
    })
  }, [])
  const undo = useCallback(() => {
    setSel(null)
    setHistory((h) => (h.past.length ? { doc: h.past.at(-1), past: h.past.slice(0, -1), future: [h.doc, ...h.future] } : h))
  }, [])
  const redo = useCallback(() => {
    setSel(null)
    setHistory((h) => (h.future.length ? { doc: h.future[0], past: [...h.past, h.doc], future: h.future.slice(1) } : h))
  }, [])

  const views = useMemo(() => doc.tables.map((table, ti) => viewOf(table, doc.mappings[ti], doc, file)), [doc, file])
  const total = views.reduce((acc, v) => ({ items: acc.items + v.items, accessories: acc.accessories + v.accessories }), { items: 0, accessories: 0 })

  useEffect(() => {
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
    }
  }, [])

  const cells = useMemo(() => (sel ? [...sel.ids].map(parseId) : []), [sel])
  const rows = useMemo(() => [...new Set(cells.map(([r]) => r))].sort((a, b) => a - b), [cells])
  const cols = useMemo(() => [...new Set(cells.map(([, c]) => c))].sort((a, b) => a - b), [cells])

  const select = useCallback((ti, r, c, e) => {
    setSel((s) => {
      if (e?.shiftKey && s?.ti === ti) return { ...s, ids: new Set(rectIds(s.anchor, { r, c })), focus: { r, c } }
      if ((e?.ctrlKey || e?.metaKey) && s?.ti === ti) return { ...s, ids: new Set([...s.ids, cellId(r, c)]), anchor: { r, c }, focus: { r, c } }
      return { ti, ids: new Set([cellId(r, c)]), anchor: { r, c }, focus: { r, c } }
    })
  }, [])

  const selectLine = useCallback(
    (ti, ids, e, at) => {
      setSel((s) => (s?.ti === ti && (e.ctrlKey || e.metaKey) ? { ...s, ids: new Set([...s.ids, ...ids]) } : { ti, ids: new Set(ids), anchor: at, focus: at }))
    },
    [],
  )

  const onCellDown = useCallback(
    (ti, r, c, e) => {
      if (e.button !== 0) return
      if (linking) {
        change((d) => edit.linkCells(d, linking.ti, linking.cells, { t: d.tables[ti].index, r, c }))
        setLinking(null)
        return
      }
      dragging.current = true
      select(ti, r, c, e)
    },
    [change, linking, select],
  )

  const onCellEnter = useCallback((ti, r, c) => {
    if (!dragging.current) return
    setSel((s) => (s?.ti === ti ? { ...s, ids: new Set(rectIds(s.anchor, { r, c })), focus: { r, c } } : s))
  }, [])

  const startEdit = useCallback(
    (ti, r, c, typed) => {
      const shown = String(views[ti].grid[r]?.[c] ?? '')
      setEditing({ ti, r, c, shown, value: typed ?? shown })
    },
    [setEditing, views],
  )

  const finishEdit = useCallback(
    (move) => {
      const current = editingNow.current
      if (!current) return
      setEditing(null)
      if (current.value !== current.shown) change((d) => edit.setCells(d, current.ti, [{ r: current.r, c: current.c, value: current.value }]))
      if (move) {
        const grid = doc.tables[current.ti].grid
        const r = Math.min(grid.length - 1, Math.max(0, current.r + move[0]))
        const c = Math.min((grid[0]?.length || 1) - 1, Math.max(0, current.c + move[1]))
        setSel({ ti: current.ti, ids: new Set([cellId(r, c)]), anchor: { r, c }, focus: { r, c } })
      }
    },
    [change, doc, setEditing],
  )

  useEffect(() => {
    const up = () => {
      dragging.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  useEffect(() => {
    const typingElsewhere = (e) => e.target.closest?.('input, textarea, .ant-select, .ant-modal')

    const onKey = (e) => {
      if (editing || typingElsewhere(e)) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (ctrl && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'Escape') {
        setLinking(null)
        return
      }
      if (!sel || ctrl) return

      const { ti, focus } = sel
      const grid = doc.tables[ti].grid
      const forward = dir === 'rtl' ? -1 : 1
      const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -forward], ArrowRight: [0, forward], Tab: [0, e.shiftKey ? -1 : 1] }[e.key]
      if (step) {
        e.preventDefault()
        const r = Math.min(grid.length - 1, Math.max(0, focus.r + step[0]))
        const c = Math.min((grid[0]?.length || 1) - 1, Math.max(0, focus.c + step[1]))
        if (e.shiftKey && e.key !== 'Tab') setSel((s) => ({ ...s, ids: new Set(rectIds(s.anchor, { r, c })), focus: { r, c } }))
        else setSel({ ti, ids: new Set([cellId(r, c)]), anchor: { r, c }, focus: { r, c } })
      } else if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault()
        startEdit(ti, focus.r, focus.c)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        change((d) => edit.setCells(d, ti, cells.map(([r, c]) => ({ r, c, value: '' }))))
      } else if (e.key.length === 1) {
        e.preventDefault()
        startEdit(ti, focus.r, focus.c, e.key)
      }
    }

    const onCopy = (e) => {
      if (editing || !sel || typingElsewhere(e)) return
      const grid = views[sel.ti].grid
      const text = rows.map((r) => cols.map((c) => (sel.ids.has(cellId(r, c)) ? String(grid[r][c] ?? '').replace(/\s*\n\s*/g, ' ') : '')).join('\t')).join('\n')
      e.clipboardData.setData('text/plain', text)
      e.preventDefault()
    }

    const onPaste = (e) => {
      if (editing || !sel || typingElsewhere(e)) return
      const text = e.clipboardData.getData('text/plain').replace(/\r?\n$/, '')
      if (!text) return
      e.preventDefault()
      const block = text.split(/\r?\n/).map((line) => line.split('\t'))
      if (block.length === 1 && block[0].length === 1) change((d) => edit.setCells(d, sel.ti, cells.map(([r, c]) => ({ r, c, value: text }))))
      else change((d) => edit.pasteBlock(d, sel.ti, rows[0], cols[0], block))
    }

    window.addEventListener('keydown', onKey)
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [cells, change, cols, dir, doc, editing, redo, rows, sel, startEdit, undo, views])

  const structural = (fn) => {
    change(fn)
    setSel(null)
  }

  const close = () => {
    if (!history.past.length) return onClose()
    modal.confirm({ title: t('we_discard'), okText: t('we_discard_ok'), cancelText: t('cancel'), okButtonProps: { danger: true }, onOk: onClose })
  }

  const addTable = () => {
    change((d) => edit.addTable(d, { title: t('we_new_table'), headers: [t('serial_number'), t('name_field'), t('we_new_column')], aliases }))
    setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  const createGroup = async () => {
    const name = newGroup.name.trim()
    if (!name) return
    try {
      const { data } = await api.post('/groups', { name })
      onGroupCreated(data)
      const { ti, rows: forRows } = newGroup
      change((d) => (forRows ? edit.setRowGroups(d, ti, forRows, data.id) : edit.setTableGroup(d, ti, data.id)))
      setNewGroup(null)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const ti = sel?.ti
  const mapping = sel ? doc.mappings[ti] : null
  const isRows = mapping?.layout === 'rows'
  const anyLinked = sel ? cells.some(([r, c]) => doc.tables[ti].links?.[cellId(r, c)]) : false
  const canRole = !!sel && mapping.layout !== 'ignore'
  // A group only means something on rows that become items; any other selection is about the table
  const itemRows = isRows ? rows.filter((r) => views[ti].used.has(r)) : []
  const forRows = itemRows.length > 0

  const tool = (label, icon, onClick, disabled) => (
    <Tooltip title={label}>
      <Button size="small" type="text" icon={icon} onClick={onClick} disabled={disabled} aria-label={label} />
    </Tooltip>
  )

  return (
    <div className="we-page">
      <header className="we-top">
        <div className="we-title">
          <FileWordOutlined /> <b>{file.file}</b>
          <div style={{ flex: 1 }} />
          <Typography.Text strong>{t('map_total', { n: total.items, a: total.accessories })}</Typography.Text>
          <Button onClick={close}>{t('cancel')}</Button>
          <Button type="primary" icon={<CheckOutlined />} onClick={() => onApply(doc.tables, doc.mappings)}>
            {t('map_apply')}
          </Button>
        </div>
        <div className="we-ribbon">
          {tool(t('we_undo'), <UndoOutlined />, undo, !history.past.length)}
          {tool(t('we_redo'), <RedoOutlined />, redo, !history.future.length)}
          <Divider orientation="vertical" />
          {tool(t('we_row_above'), <InsertRowAboveOutlined />, () => structural((d) => edit.insertRows(d, ti, rows[0])), !sel)}
          {tool(t('we_row_below'), <InsertRowBelowOutlined />, () => structural((d) => edit.insertRows(d, ti, rows.at(-1) + 1)), !sel)}
          {tool(t('we_col_before'), <InsertRowRightOutlined />, () => structural((d) => edit.insertColumn(d, ti, cols[0])), !sel)}
          {tool(t('we_col_after'), <InsertRowLeftOutlined />, () => structural((d) => edit.insertColumn(d, ti, cols.at(-1) + 1)), !sel)}
          {tool(t('we_delete_rows'), <DeleteRowOutlined />, () => structural((d) => edit.deleteRows(d, ti, rows)), !sel)}
          {tool(t('we_delete_cols'), <DeleteColumnOutlined />, () => structural((d) => edit.deleteColumns(d, ti, cols)), !sel)}
          <Divider orientation="vertical" />
          {ROLES.map((role) => (
            <Button key={role} size="small" className={`we-role-btn role-bg-${role}`} disabled={!canRole} onClick={() => change((d) => edit.setRole(d, ti, cells, role))}>
              <span className="role-icon">{ROLE_ICON[role]}</span> {t(`role_${role}`)}
            </Button>
          ))}
          <Divider orientation="vertical" />
          <Button size="small" type={linking ? 'primary' : 'default'} icon={<LinkOutlined />} disabled={!sel} onClick={() => setLinking(linking ? null : { ti, cells })}>
            {t('we_link')}
          </Button>
          {tool(t('we_unlink'), <DisconnectOutlined />, () => change((d) => edit.unlinkCells(d, ti, cells)), !anyLinked)}
          {tool(t('map_make_header'), <StarOutlined />, () => change((d) => edit.setHeaderRow(d, ti, rows[0], aliases, accessoryKeys)), !isRows)}
          {canRole && (
            <>
              <Divider orientation="vertical" />
              <Typography.Text type="secondary">{forRows ? t('we_rows_group', { n: itemRows.length }) : t('we_table_group')}</Typography.Text>
              <GroupChoice
                value={forRows ? (itemRows.length === 1 && itemRows[0] in (mapping.rowGroups || {}) ? mapping.rowGroups[itemRows[0]] : undefined) : mapping.group}
                groups={groups}
                inheritLabel={forRows ? t('we_group_table') : t('we_group_import')}
                onChange={(g) => change((d) => (forRows ? edit.setRowGroups(d, ti, itemRows, g) : edit.setTableGroup(d, ti, g)))}
                onNew={() => setNewGroup({ ti, rows: forRows ? itemRows : undefined, name: '' })}
              />
            </>
          )}
        </div>
        <div className={`we-hint${linking ? ' we-hint-link' : ''}`}>{linking ? t('we_link_hint') : t('we_help')}</div>
      </header>

      <main className="we-canvas">
        <div className="we-sheet" dir={dir}>
          {doc.tables.length === 0 && <Empty description={t('warn_no_tables')} />}
          {doc.tables.map((table, i) => (
            <TableSheet
              key={table.index}
              ti={i}
              table={table}
              mapping={doc.mappings[i]}
              view={views[i]}
              sel={sel?.ti === i ? sel : null}
              editing={editing?.ti === i ? editing : null}
              linking={!!linking}
              groups={groups}
              change={change}
              aliases={aliases}
              accessoryKeys={accessoryKeys}
              onCellDown={onCellDown}
              onCellEnter={onCellEnter}
              onCellDouble={startEdit}
              onSelectLine={selectLine}
              onEditChange={setEditing}
              onEditDone={finishEdit}
              onNewGroup={setNewGroup}
              onDeleted={() => setSel(null)}
            />
          ))}
          <Button type="dashed" block icon={<PlusOutlined />} onClick={addTable} style={{ marginTop: 8 }}>
            {t('we_add_table')}
          </Button>
          <div ref={end} />
        </div>
      </main>

      <Modal open={!!newGroup} title={t('we_new_group')} okText={t('add')} cancelText={t('cancel')} onOk={createGroup} onCancel={() => setNewGroup(null)} destroyOnHidden>
        <Input autoFocus value={newGroup?.name ?? ''} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} onPressEnter={createGroup} placeholder={t('we_group_name')} />
      </Modal>
    </div>
  )
}

/** A group, no group, or the choice one level up (`undefined`). */
function GroupChoice({ value, groups, inheritLabel, onChange, onNew }) {
  const { t } = useLang()
  const selected = value === undefined ? 'inherit' : value === null ? 'none' : value
  return (
    <Select
      size="small"
      showSearch
      optionFilterProp="label"
      value={selected}
      popupMatchSelectWidth={false}
      style={{ minWidth: 170 }}
      onChange={(v) => {
        if (v === 'new') onNew()
        else onChange(v === 'inherit' ? undefined : v === 'none' ? null : v)
      }}
      options={[
        { value: 'inherit', label: inheritLabel },
        { value: 'none', label: t('we_no_group') },
        ...groups.map((g) => ({ value: g.id, label: g.name })),
        { value: 'new', label: `+ ${t('we_new_group')}` },
      ]}
    />
  )
}

/** One table of the document: its bar, then the grid as it looks in Word. */
const TableSheet = memo(function TableSheet({ ti, table, mapping, view, sel, editing, linking, groups, change, aliases, accessoryKeys, onCellDown, onCellEnter, onCellDouble, onSelectLine, onEditChange, onEditDone, onNewGroup, onDeleted }) {
  const { t } = useLang()
  const width = table.grid[0]?.length || 0
  const isRows = mapping.layout === 'rows'
  const spanAt = useMemo(() => new Map(table.spans.map(([r, c, span]) => [cellId(r, c), span])), [table.spans])
  const covered = useMemo(() => new Set(table.spans.flatMap(([r, c, span]) => Array.from({ length: span - 1 }, (_, i) => cellId(r, c + i + 1)))), [table.spans])
  const vmerged = useMemo(() => new Set(table.vmerged.map(([r, c]) => cellId(r, c))), [table.vmerged])
  const groupName = (id) => (id === null ? t('we_no_group') : groups.find((g) => g.id === id)?.name)

  const roleAt = (r, c, id) => {
    if (mapping.layout === 'pairs') return view.pairRoles[id]
    if (!isRows || r <= mapping.headerRow || !view.used.has(r)) return null
    return mapping.cellRoles?.[id] ?? mapping.columns[c]?.role
  }

  return (
    <section className={`we-table${mapping.layout === 'ignore' ? ' we-table-ignored' : ''}`}>
      <div className="we-table-bar">
        <Tag>
          {t('table')} {table.index}
        </Tag>
        <Input variant="borderless" className="we-table-title" value={table.title ?? ''} placeholder={t('we_table_title')} onChange={(e) => change((d) => edit.setTitle(d, ti, e.target.value))} />
        <Segmented
          size="small"
          value={mapping.layout}
          onChange={(v) => change((d) => edit.setLayout(d, ti, v, aliases, accessoryKeys))}
          options={[
            { value: 'rows', label: t('we_layout_rows') },
            { value: 'pairs', label: t('we_layout_pairs') },
            { value: 'ignore', label: t('role_ignore') },
          ]}
        />
        {mapping.layout !== 'ignore' && (
          <>
            <GroupChoice value={mapping.group} groups={groups} inheritLabel={t('we_group_import')} onChange={(g) => change((d) => edit.setTableGroup(d, ti, g))} onNew={() => onNewGroup({ ti, name: '' })} />
            <Typography.Text type="secondary">{t('map_result', { n: view.items, a: view.accessories })}</Typography.Text>
            {view.noSerial > 0 && (
              <Tag color="red">
                {t('st_missing_serial')}: {view.noSerial}
              </Tag>
            )}
          </>
        )}
        <Popconfirm
          title={t('we_delete_table')}
          okText={t('delete')}
          cancelText={t('cancel')}
          onConfirm={() => {
            change((d) => edit.deleteTable(d, ti))
            onDeleted()
          }}
        >
          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('we_delete_table')} />
        </Popconfirm>
      </div>

      {isRows && view.items > 0 && !mapping.columns.some((col) => col.role === 'serial') && view.noSerial > 0 && <Alert type="warning" showIcon title={t('we_no_serial')} style={{ marginBottom: 8 }} />}

      <div className="word-grid-wrap">
        <table className={`word-grid we-grid${linking ? ' we-grid-linking' : ''}`}>
          <thead>
            <tr>
              <th className="row-num-head" />
              {Array.from({ length: width }, (_, c) => {
                const role = isRows ? mapping.columns[c]?.role : null
                return (
                  <th key={c} className={`we-col-head${role ? ` role-bg-${role}` : ''}`} onMouseDown={(e) => onSelectLine(ti, table.grid.map((_, r) => cellId(r, c)), e, { r: 0, c })}>
                    {role ? t(`role_${role}`) : ' '}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {table.grid.map((row, r) => {
              const isHeader = isRows && r === mapping.headerRow
              const above = isRows && r < mapping.headerRow
              const rowGroup = mapping.rowGroups && r in mapping.rowGroups ? groupName(mapping.rowGroups[r]) : null
              return (
                <tr key={r} className={isHeader ? 'grid-header-row' : above ? 'grid-row-above' : isRows && !view.used.has(r) ? 'grid-row-skipped' : ''}>
                  <td className={`row-num we-row-head${rowGroup ? ' we-row-grouped' : ''}`} title={rowGroup || undefined} onMouseDown={(e) => onSelectLine(ti, row.map((_, c) => cellId(r, c)), e, { r, c: 0 })}>
                    {isHeader ? '★' : r + 1}
                    {view.used.has(r) && <CheckOutlined className="row-used" />}
                  </td>
                  {Array.from({ length: width }, (_, c) => {
                    const id = cellId(r, c)
                    if (covered.has(id)) return null
                    const role = roleAt(r, c, id)
                    const link = table.links?.[id]
                    const classes = [
                      role ? `role-bg-${role}` : '',
                      vmerged.has(id) ? 'cell-vmerged' : '',
                      sel?.ids.has(id) ? 'cell-selected' : '',
                      sel && sel.focus.r === r && sel.focus.c === c ? 'cell-focus' : '',
                      mapping.cellRoles?.[id] ? 'cell-own-role' : '',
                      link ? 'cell-linked' : '',
                    ]
                    const isEditing = editing && editing.r === r && editing.c === c
                    return (
                      <td
                        key={c}
                        colSpan={spanAt.get(id) || 1}
                        className={classes.filter(Boolean).join(' ')}
                        title={link ? t('we_linked_to', { t: link.t, r: link.r + 1, c: link.c + 1 }) : undefined}
                        onMouseDown={(e) => !isEditing && onCellDown(ti, r, c, e)}
                        onMouseEnter={() => onCellEnter(ti, r, c)}
                        onDoubleClick={() => onCellDouble(ti, r, c)}
                      >
                        {isEditing ? (
                          <textarea
                            className="we-cell-input"
                            dir="auto"
                            autoFocus
                            rows={Math.max(1, editing.value.split('\n').length)}
                            value={editing.value}
                            onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
                            onChange={(e) => onEditChange({ ...editing, value: e.target.value })}
                            onBlur={() => onEditDone()}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') onEditChange(null)
                              else if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                onEditDone([1, 0])
                              } else if (e.key === 'Tab') {
                                e.preventDefault()
                                onEditDone([0, e.shiftKey ? -1 : 1])
                              }
                            }}
                          />
                        ) : (
                          <>
                            {link && <LinkOutlined className="cell-link-icon" />}
                            {view.grid[r]?.[c]}
                          </>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
})
