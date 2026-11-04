import { useMemo, useState } from 'react'
import { Alert, Button, Empty, Input, Modal, Segmented, Select, Tabs, Tag, Tooltip, Typography } from 'antd'
import { ApartmentOutlined, CheckOutlined, FileWordOutlined, StopOutlined } from '@ant-design/icons'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import { ROLES, aliasesFrom, buildItems, columnsForHeader, firstNonEmptyRow, itemRows, pairKeys, pairRolesFor } from '../importMapping'

const ROLE_ICON = { serial: '#', row_no: 'ت', field: '', accessory: <ApartmentOutlined />, ignore: <StopOutlined /> }

/**
 * Full-screen viewer of a Word file's tables. For each table the user picks the
 * layout, the header row and what every column (or key) means.
 */
export default function TableMapper({ open, file, mappings, accessoryKeys, onApply, onClose }) {
  const { t } = useLang()
  const { settings } = useSettings()
  const aliases = useMemo(() => aliasesFrom(settings), [settings])
  // The parent remounts this component for every file it opens, so the draft starts from the current mappings
  const [draft, setDraft] = useState(mappings)
  const [active, setActive] = useState('0')

  if (!file || draft.length !== file.tables.length) return null

  const update = (ti, patch) => setDraft((d) => d.map((m, i) => (i === ti ? { ...m, ...patch } : m)))

  const setLayout = (ti, layout) => {
    const table = file.tables[ti]
    const m = draft[ti]
    if (layout === 'rows' && !m.rowsReady) {
      const headerRow = firstNonEmptyRow(table.grid)
      update(ti, { layout, rowsReady: true, headerRow, columns: columnsForHeader(table.grid, headerRow, aliases, accessoryKeys) })
    } else if (layout === 'pairs' && !m.pairsReady) {
      update(ti, { layout, pairsReady: true, pairRoles: pairRolesFor(table.grid, aliases, accessoryKeys) })
    } else {
      update(ti, { layout })
    }
  }

  const setHeaderRow = (ti, headerRow) => update(ti, { headerRow, columns: columnsForHeader(file.tables[ti].grid, headerRow, aliases, accessoryKeys) })

  const setColumn = (ti, c, patch) => {
    let columns = draft[ti].columns.map((col, i) => (i === c ? { ...col, ...patch } : col))
    // Only one serial and one ت column per table
    if (patch.role === 'serial' || patch.role === 'row_no') {
      columns = columns.map((col, i) => (i !== c && col.role === patch.role ? { ...col, role: 'field' } : col))
    }
    update(ti, { columns })
  }

  const setPairRole = (ti, key, role) => {
    let pairRoles = { ...draft[ti].pairRoles, [key]: role }
    if (role === 'serial' || role === 'row_no') {
      pairRoles = Object.fromEntries(Object.entries(pairRoles).map(([k, r]) => [k, k !== key && r === role ? 'field' : r]))
    }
    update(ti, { pairRoles })
  }

  const counts = (ti) => {
    const items = buildItems(file.tables[ti], draft[ti], file)
    return { items: items.length, accessories: items.reduce((n, i) => n + i.accessories.length, 0), noSerial: items.filter((i) => !i.serial).length }
  }
  const total = file.tables.reduce(
    (acc, _, ti) => {
      const c = counts(ti)
      return { items: acc.items + c.items, accessories: acc.accessories + c.accessories }
    },
    { items: 0, accessories: 0 },
  )

  const roleOptions = ROLES.map((r) => ({
    value: r,
    label: (
      <span className={`role-option role-${r}`}>
        {ROLE_ICON[r] && <span className="role-icon">{ROLE_ICON[r]}</span>}
        {t(`role_${r}`)}
      </span>
    ),
  }))

  const tabs = file.tables.map((table, ti) => {
    const m = draft[ti]
    const c = counts(ti)
    return {
      key: String(ti),
      label: (
        <span className={m.layout === 'ignore' ? 'tab-ignored' : ''}>
          {t('table')} {table.index}{' '}
          <Tag color={m.layout === 'ignore' ? 'default' : c.noSerial ? 'red' : 'green'} style={{ marginInlineStart: 4 }}>
            {m.layout === 'ignore' ? t('map_ignored') : c.items}
          </Tag>
        </span>
      ),
      children: (
        <div className="mapper-table">
          {table.title && (
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {table.title}
            </Typography.Title>
          )}
          <div className="toolbar">
            <Segmented
              value={m.layout}
              onChange={(v) => setLayout(ti, v)}
              options={[
                { value: 'rows', label: t('map_layout_rows') },
                { value: 'pairs', label: t('map_layout_pairs') },
                { value: 'ignore', label: t('map_layout_ignore') },
              ]}
            />
            <div style={{ flex: 1 }} />
            {m.layout !== 'ignore' && (
              <Typography.Text>
                {t('map_result', { n: c.items, a: c.accessories })}
                {c.noSerial > 0 && (
                  <Tag color="red" style={{ marginInlineStart: 8 }}>
                    {t('st_missing_serial')}: {c.noSerial}
                  </Tag>
                )}
              </Typography.Text>
            )}
          </div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            {t(`map_help_${m.layout}`)}
          </Typography.Paragraph>
          {m.layout === 'rows' && m.columns.length > 0 && !m.columns.some((col) => col.role === 'serial') && (
            <Alert type="warning" showIcon title={t('map_no_serial_column')} style={{ marginBottom: 8 }} />
          )}
          {m.layout === 'pairs' ? (
            <div className="mapper-pairs">
              <GridView table={table} />
              <div className="pair-roles">
                {pairKeys(table.grid).map((key) => (
                  <div key={key} className={`pair-role-row role-bg-${m.pairRoles[key] || 'field'}`}>
                    <bdi className="pair-key">{key}</bdi>
                    <Select size="small" value={m.pairRoles[key] || 'field'} options={roleOptions} onChange={(r) => setPairRole(ti, key, r)} style={{ width: 150 }} popupMatchSelectWidth={false} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <GridView
              table={table}
              mapping={m.layout === 'rows' ? m : null}
              ignored={m.layout === 'ignore'}
              roleOptions={roleOptions}
              onHeaderRow={(r) => setHeaderRow(ti, r)}
              onColumn={(col, patch) => setColumn(ti, col, patch)}
            />
          )}
        </div>
      ),
    }
  })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width="96vw"
      style={{ top: 16, maxWidth: 1600 }}
      title={
        <span>
          <FileWordOutlined /> {file.file}
        </span>
      }
      footer={
        <div className="mapper-footer">
          <Typography.Text strong>{t('map_total', { n: total.items, a: total.accessories })}</Typography.Text>
          <div className="page-actions">
            <Button onClick={onClose}>{t('cancel')}</Button>
            <Button type="primary" icon={<CheckOutlined />} onClick={() => onApply(draft)}>
              {t('map_apply')}
            </Button>
          </div>
        </div>
      }
      destroyOnHidden
    >
      {file.tables.length ? <Tabs activeKey={active} onChange={setActive} items={tabs} /> : <Empty description={t('warn_no_tables')} />}
    </Modal>
  )
}

/** The Word table drawn as HTML, with role controls above the columns in "rows" layout. */
function GridView({ table, mapping, ignored, roleOptions, onHeaderRow, onColumn }) {
  const { t } = useLang()
  const width = table.grid[0]?.length || 0
  const spanAt = useMemo(() => {
    const map = new Map()
    for (const [r, c, span] of table.spans) map.set(`${r}:${c}`, span)
    return map
  }, [table.spans])
  const covered = useMemo(() => {
    const set = new Set()
    for (const [r, c, span] of table.spans) for (let i = 1; i < span; i++) set.add(`${r}:${c + i}`)
    return set
  }, [table.spans])
  const vmerged = useMemo(() => new Set(table.vmerged.map(([r, c]) => `${r}:${c}`)), [table.vmerged])
  const rowsUsed = mapping ? itemRows(table, mapping) : new Set()

  return (
    <div className={`word-grid-wrap${ignored ? ' grid-ignored' : ''}`}>
      <table className="word-grid">
        {mapping && (
          <thead>
            <tr>
              <th className="row-num-head" />
              {mapping.columns.map((col, c) => (
                <th key={c} className={`role-bg-${col.role}`}>
                  <Select size="small" value={col.role} options={roleOptions} onChange={(role) => onColumn(c, { role })} style={{ width: '100%', minWidth: 110 }} popupMatchSelectWidth={false} />
                  {(col.role === 'field' || col.role === 'accessory') && (
                    <Input size="small" value={col.key} onChange={(e) => onColumn(c, { key: e.target.value })} style={{ marginTop: 4 }} title={t('map_key_name')} />
                  )}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {table.grid.map((row, r) => {
            const isHeader = mapping && r === mapping.headerRow
            const above = mapping && r < mapping.headerRow
            const used = rowsUsed.has(r)
            return (
              <tr key={r} className={isHeader ? 'grid-header-row' : above ? 'grid-row-above' : mapping && !used ? 'grid-row-skipped' : ''}>
                <td className="row-num">
                  {mapping ? (
                    <Tooltip title={isHeader ? t('map_header_row') : t('map_make_header')}>
                      <button type="button" className={`row-num-btn${isHeader ? ' active' : ''}`} onClick={() => onHeaderRow(r)}>
                        {isHeader ? '★' : r + 1}
                      </button>
                    </Tooltip>
                  ) : (
                    r + 1
                  )}
                  {used && <CheckOutlined className="row-used" />}
                </td>
                {Array.from({ length: width }, (_, c) => {
                  const key = `${r}:${c}`
                  if (covered.has(key)) return null
                  const span = spanAt.get(key) || 1
                  const role = mapping && !isHeader && !above ? mapping.columns[c]?.role : null
                  return (
                    <td key={c} colSpan={span} className={[role ? `role-bg-${role}` : '', vmerged.has(key) ? 'cell-vmerged' : ''].join(' ')}>
                      {row[c]}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
