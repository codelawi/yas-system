import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, App, Button, Card, Empty, Input, Segmented, Select, Table, Tag, Typography, Upload } from 'antd'
import { ClusterOutlined, InboxOutlined, ReloadOutlined, SaveOutlined, TagsOutlined, UploadOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { usePhone } from '../nav'
import { normalize } from '../importMapping'
import { Fab, PhoneHeader, PhoneList, PhoneSearch, PhoneSkeleton } from '../components/PhoneUI'

const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

/** Words for comparing names: «الكشاف اليدوي» and «كشاف يدوي» share both words. */
const words = (text) =>
  normalize(text)
    .split(' ')
    .map((w) => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w))
    .filter(Boolean)

/** How alike two names are, from 0 to 1 (1 = the same name). */
function nameScore(a, b) {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const wx = new Set(words(a))
  const wy = new Set(words(b))
  let shared = 0
  wx.forEach((w) => wy.has(w) && shared++)
  const dice = (2 * shared) / (wx.size + wy.size || 1)
  return Math.min(0.99, Math.max(dice, x.includes(y) || y.includes(x) ? 0.6 : 0))
}

const CODE_HEADERS = ['الحرف', 'رمز', 'كود', 'code']
const NAME_HEADERS = ['النوع', 'اسم', 'الصنف', 'البيان', 'المعده', 'الماده', 'name', 'item', 'description']

/** The name and code columns, from a header row near the top («النوع», «الحرف والرقم»). */
function guessColumns(grid) {
  for (let r = 0; r < Math.min(grid.length, 6); r++) {
    const cells = grid[r].map(normalize)
    const code = cells.findIndex((c) => CODE_HEADERS.some((w) => c.includes(w)))
    const name = cells.findIndex((c, i) => i !== code && NAME_HEADERS.some((w) => c.includes(w)))
    if (code >= 0 || name >= 0) return { name: name >= 0 ? name : undefined, code: code >= 0 ? code : undefined, header: r }
  }
  return { name: undefined, code: undefined, header: -1 }
}

/** Voucher codes of every group: one table, saved together. */
export function VoucherCodesPage() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const phone = usePhone()
  const [groups, setGroups] = useState(null)
  const [edits, setEdits] = useState({})
  const [q, setQ] = useState('')
  const [show, setShow] = useState('all')
  const [saving, setSaving] = useState(false)

  const load = () =>
    api.get('/groups').then(({ data }) => {
      setGroups(data)
      setEdits({})
    })
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, [])

  const value = (g, key) => edits[g.id]?.[key] ?? g[key] ?? ''
  const change = (g, key, v) => setEdits((all) => ({ ...all, [g.id]: { ...all[g.id], [key]: v } }))
  const changed = (groups || []).filter((g) => edits[g.id] && ['voucher_code', 'voucher_name'].some((key) => clean(value(g, key)) !== clean(g[key])))

  // Typed codes are lost when the page is closed
  useEffect(() => {
    if (!changed.length) return undefined
    const warn = (e) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [changed.length])

  const save = async () => {
    if (!(await requirePin())) return
    setSaving(true)
    try {
      const { data } = await api.put('/groups/voucher-codes', {
        groups: changed.map((g) => ({ id: g.id, voucher_code: clean(value(g, 'voucher_code')) || null, voucher_name: clean(value(g, 'voucher_name')) || null })),
      })
      message.success(t('voucher_saved_n', { n: data.changed }))
      await load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const missing = (groups || []).filter((g) => !g.voucher_code).length
  const term = normalize(q)
  const shown = (groups || [])
    .filter((g) => show === 'all' || !g.voucher_code)
    .filter((g) => !term || [g.name, g.voucher_name, g.voucher_code].some((v) => normalize(v).includes(term)))

  const codeInput = (g) => <Input value={value(g, 'voucher_code')} onChange={(e) => change(g, 'voucher_code', e.target.value)} placeholder={t('voucher_code_example')} aria-label={t('voucher_code')} />
  const nameInput = (g) => <Input value={value(g, 'voucher_name')} onChange={(e) => change(g, 'voucher_name', e.target.value)} placeholder={g.name} aria-label={t('voucher_name')} />
  const filter = (
    <Segmented
      value={show}
      onChange={setShow}
      block={phone}
      options={[
        { value: 'all', label: t('voucher_show_all') },
        { value: 'missing', label: t('voucher_show_missing', { n: missing }) },
      ]}
    />
  )

  if (phone)
    return (
      <div className="page">
        <PhoneHeader
          title={t('voucher_codes')}
          subtitle={groups ? t('groups_n', { n: groups.length }) : ' '}
          more={[{ key: 'import', icon: <UploadOutlined />, label: t('voucher_import'), onClick: () => navigate('/groups/codes/import') }]}
        />
        <PhoneSearch value={q} placeholder={t('search_groups')} onChange={setQ} />
        <div style={{ marginBottom: 12 }}>{filter}</div>
        {!groups ? (
          <PhoneSkeleton />
        ) : shown.length ? (
          <PhoneList>
            {shown.map((g) => (
              <div key={g.id} className="voucher-code-row">
                <Link to={`/groups/${g.id}`} className="voucher-code-title">
                  <ClusterOutlined /> {g.name}
                </Link>
                <label>
                  <span>{t('voucher_code')}</span>
                  {codeInput(g)}
                </label>
                <label>
                  <span>{t('voucher_name')}</span>
                  {nameInput(g)}
                </label>
              </div>
            ))}
          </PhoneList>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_groups')} />
        )}
        {changed.length > 0 && <Fab icon={<SaveOutlined />} label={t('voucher_save_n', { n: changed.length })} onClick={save} loading={saving} />}
      </div>
    )

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/groups">
            <ClusterOutlined /> {t('groups')}
          </Link>
          <Typography.Title level={3} style={{ margin: 0 }}>
            <TagsOutlined /> {t('voucher_codes')}
          </Typography.Title>
        </div>
        <div className="page-actions">
          <Button icon={<UploadOutlined />} onClick={() => navigate('/groups/codes/import')}>
            {t('voucher_import')}
          </Button>
          <Button type="primary" icon={<SaveOutlined />} disabled={!changed.length} loading={saving} onClick={save}>
            {t('voucher_save_n', { n: changed.length })}
          </Button>
        </div>
      </div>
      <Typography.Paragraph type="secondary">{t('voucher_codes_intro')}</Typography.Paragraph>
      <div className="page-actions" style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder={t('search_groups')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        {filter}
      </div>
      <Table
        rowKey="id"
        loading={!groups}
        dataSource={shown}
        pagination={{ pageSize: 100, hideOnSinglePage: true }}
        locale={{ emptyText: t('no_groups') }}
        columns={[
          {
            title: t('group_name'),
            dataIndex: 'name',
            render: (name, g) => (
              <Link to={`/groups/${g.id}`} className="list-title">
                {name}
              </Link>
            ),
          },
          { title: t('voucher_code'), key: 'code', width: 240, render: (_, g) => codeInput(g) },
          { title: t('voucher_name'), key: 'name', render: (_, g) => nameInput(g) },
          { title: t('count'), dataIndex: 'equipment_count', width: 110, render: (n) => t('n_items', { n }) },
        ]}
      />
    </div>
  )
}

/**
 * Voucher codes from a Word/Excel table: choose the name and code columns (the rest is ignored),
 * then the group of each row. Rows left without a group are ignored.
 */
export function VoucherCodeImportPage() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const phone = usePhone()
  const [file, setFile] = useState(null)
  const [reading, setReading] = useState(false)
  const [tableIndex, setTableIndex] = useState(0)
  const [cols, setCols] = useState({ name: undefined, code: undefined, header: -1 })
  const [choice, setChoice] = useState({})
  const [groups, setGroups] = useState([])
  const [show, setShow] = useState('all')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.get('/groups').then(({ data }) => setGroups(data))
  }, [])

  const pickTable = (tables, index) => {
    setTableIndex(index)
    setCols(guessColumns(tables[index].grid))
    setChoice({})
  }

  const read = async (raw) => {
    if (!(await requirePin())) return
    setReading(true)
    try {
      const body = new FormData()
      body.append('file', raw)
      const { data } = await api.post('/groups/voucher-codes/read', body)
      // A PHP warning in front of the JSON leaves plain text here
      if (!Array.isArray(data?.tables)) throw new Error('voucher_file_bad')
      setFile(data)
      pickTable(data.tables, 0)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setReading(false)
    }
  }

  const table = file?.tables[tableIndex]
  const width = table ? Math.max(0, ...table.grid.map((row) => row.length)) : 0

  const rows = useMemo(() => {
    if (!table || (cols.name === undefined && cols.code === undefined)) return []
    const cell = (row, c) => (c === undefined ? '' : clean(row[c]))
    const header = cols.header >= 0 ? table.grid[cols.header] : null
    const headerSig = header ? normalize(`${cell(header, cols.name)}|${cell(header, cols.code)}`) : null
    return table.grid.flatMap((row, r) => {
      const name = cell(row, cols.name)
      const code = cell(row, cols.code)
      if (r <= cols.header || (!name && !code)) return []
      // The header repeated on a new page
      if (headerSig && normalize(`${name}|${code}`) === headerSig) return []
      return [{ r, name, code }]
    })
  }, [table, cols])

  // Groups for each row, the most alike first; the same name (or code) is chosen by itself
  const ranked = useMemo(
    () =>
      Object.fromEntries(
        rows.map((row) => [
          row.r,
          groups
            .map((g) => ({
              g,
              score: Math.max(nameScore(row.name, g.name), nameScore(row.name, g.voucher_name), row.code && g.voucher_code && normalize(row.code) === normalize(g.voucher_code) ? 1 : 0),
            }))
            .sort((a, b) => b.score - a.score),
        ]),
      ),
    [rows, groups],
  )
  const groupOf = (row) => (row.r in choice ? choice[row.r] : ranked[row.r]?.[0]?.score === 1 ? ranked[row.r][0].g.id : null)
  const byId = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g])), [groups])

  const picks = rows.map((row) => ({ row, id: groupOf(row) })).filter((p) => p.id)
  const uses = picks.reduce((n, p) => ({ ...n, [p.id]: (n[p.id] || 0) + 1 }), {})
  const duplicates = Object.values(uses).filter((n) => n > 1).length
  const shown = rows.filter((row) => show === 'all' || (show === 'matched' ? groupOf(row) : !groupOf(row)))

  const save = async () => {
    if (!(await requirePin())) return
    setSaving(true)
    try {
      const { data } = await api.put('/groups/voucher-codes', { groups: picks.map(({ row, id }) => ({ id, voucher_code: row.code || null, voucher_name: row.name || null })) })
      message.success(t('voucher_saved_n', { n: data.changed }))
      navigate('/groups/codes')
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const columnOptions = Array.from({ length: width }, (_, c) => {
    const sample = (cols.header >= 0 ? clean(table.grid[cols.header][c]) : '') || table.grid.map((row) => clean(row[c])).find(Boolean) || ''
    return { value: c, label: `${t('voucher_col_n', { n: c + 1 })}${sample ? ` — ${sample.slice(0, 40)}` : ''}` }
  })

  const groupSelect = (row) => {
    const id = groupOf(row)
    const current = id && byId[id]
    return (
      <div className="voucher-import-group">
        <Select
          value={id ?? undefined}
          onChange={(v) => setChoice({ ...choice, [row.r]: v ?? null })}
          allowClear
          showSearch={{ filterOption: (input, option) => option.search.includes(normalize(input)) }}
          placeholder={t('voucher_choose_group')}
          status={id && uses[id] > 1 ? 'error' : undefined}
          style={{ width: '100%' }}
          options={(ranked[row.r] || []).map(({ g }) => ({
            value: g.id,
            search: normalize(`${g.name} ${g.voucher_name || ''} ${g.voucher_code || ''}`),
            label: (
              <span>
                {g.name}
                {g.voucher_code && <Typography.Text type="secondary">{` · ${g.voucher_code}`}</Typography.Text>}
              </span>
            ),
          }))}
        />
        {current?.voucher_code && clean(current.voucher_code) !== row.code && (
          <Typography.Text type="secondary" className="voucher-import-current">
            {t('voucher_current', { code: current.voucher_code })}
          </Typography.Text>
        )}
      </div>
    )
  }

  const head = phone ? (
    <PhoneHeader title={t('voucher_import_title')} subtitle={file ? file.file : t('voucher_codes')} />
  ) : (
    <div className="page-head">
      <div>
        <Link to="/groups/codes">
          <TagsOutlined /> {t('voucher_codes')}
        </Link>
        <Typography.Title level={3} style={{ margin: 0 }}>
          <UploadOutlined /> {t('voucher_import_title')}
        </Typography.Title>
      </div>
      {file && (
        <div className="page-actions">
          <Button icon={<ReloadOutlined />} onClick={() => setFile(null)}>
            {t('voucher_other_file')}
          </Button>
          <Button type="primary" icon={<SaveOutlined />} disabled={!picks.length || duplicates > 0} loading={saving} onClick={save}>
            {t('voucher_save_n', { n: picks.length })}
          </Button>
        </div>
      )}
    </div>
  )

  if (!file)
    return (
      <div className="page">
        {head}
        <Card>
          <Upload.Dragger
            accept=".docx,.xlsx"
            showUploadList={false}
            disabled={reading}
            beforeUpload={(raw) => {
              read(raw)
              return false
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">{reading ? t('voucher_reading') : t('voucher_import_drop')}</p>
            <p className="ant-upload-hint">{t('voucher_import_drop_hint')}</p>
          </Upload.Dragger>
        </Card>
      </div>
    )

  const preview = table.grid.slice(0, 6)

  return (
    <div className="page">
      {head}
      <Card size={phone ? 'small' : undefined} style={{ marginBottom: 16 }}>
        {file.tables.length > 1 && (
          <div className="voucher-import-field">
            <span>{t('voucher_table')}</span>
            <Select
              value={tableIndex}
              onChange={(i) => pickTable(file.tables, i)}
              style={{ width: '100%' }}
              options={file.tables.map((tb, i) => ({ value: i, label: `${tb.title || `${t('voucher_table')} ${tb.index}`} (${t('voucher_sheet_rows', { n: tb.grid.length })})` }))}
            />
          </div>
        )}
        <Typography.Paragraph type="secondary">{t('voucher_choose_cols')}</Typography.Paragraph>
        <div className="voucher-import-cols">
          <div className="voucher-import-field">
            <span>{t('voucher_col_name')}</span>
            <Select allowClear value={cols.name} onChange={(name) => setCols({ ...cols, name })} options={columnOptions} placeholder={t('voucher_col_name')} style={{ width: '100%' }} />
          </div>
          <div className="voucher-import-field">
            <span>{t('voucher_col_code')}</span>
            <Select allowClear value={cols.code} onChange={(code) => setCols({ ...cols, code })} options={columnOptions} placeholder={t('voucher_col_code')} style={{ width: '100%' }} />
          </div>
        </div>
        <div className="voucher-import-preview">
          <table>
            <thead>
              <tr>
                {columnOptions.map((o) => (
                  <th key={o.value} className={o.value === cols.name || o.value === cols.code ? 'is-picked' : ''}>
                    {o.value === cols.name ? t('voucher_name') : o.value === cols.code ? t('voucher_code') : t('voucher_col_n', { n: o.value + 1 })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((row, r) => (
                <tr key={r} className={r <= cols.header ? 'is-header' : ''}>
                  {columnOptions.map((o) => (
                    <td key={o.value} className={o.value === cols.name || o.value === cols.code ? 'is-picked' : ''}>
                      {row[o.value]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Typography.Paragraph type="secondary">{t('voucher_rows_hint')}</Typography.Paragraph>
      {duplicates > 0 && <Alert type="error" showIcon title={t('voucher_duplicate')} style={{ marginBottom: 12 }} />}
      <div className="page-actions" style={{ marginBottom: 12, alignItems: 'center' }}>
        <Segmented
          value={show}
          onChange={setShow}
          block={phone}
          className="voucher-filter"
          options={[
            { value: 'all', label: t('voucher_show_all') },
            { value: 'matched', label: t('voucher_show_matched', { n: picks.length }) },
            { value: 'unmatched', label: t('voucher_show_unmatched', { n: rows.length - picks.length }) },
          ]}
        />
        {!phone && <Tag>{t('voucher_rows_with_group', { n: picks.length, total: rows.length })}</Tag>}
      </div>

      {phone ? (
        shown.length ? (
          <PhoneList>
            {shown.map((row) => (
              <div key={row.r} className="voucher-code-row">
                <b>{row.name || '—'}</b>
                <span className="voucher-import-code">{row.code || '—'}</span>
                {groupSelect(row)}
              </div>
            ))}
          </PhoneList>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('voucher_no_rows')} />
        )
      ) : (
        <Table
          rowKey="r"
          size="middle"
          dataSource={shown}
          pagination={{ pageSize: 100, hideOnSinglePage: true }}
          locale={{ emptyText: t('voucher_no_rows') }}
          columns={[
            { title: t('voucher_name'), dataIndex: 'name', render: (v) => v || '—' },
            { title: t('voucher_code'), dataIndex: 'code', width: 220, render: (v) => v || '—' },
            { title: t('group'), key: 'group', width: 360, render: (_, row) => groupSelect(row) },
          ]}
        />
      )}

      {phone && (
        <>
          <Button block icon={<ReloadOutlined />} onClick={() => setFile(null)} style={{ marginTop: 12 }}>
            {t('voucher_other_file')}
          </Button>
          {picks.length > 0 && <Fab icon={<SaveOutlined />} label={t('voucher_save_n', { n: picks.length })} onClick={duplicates ? () => message.error(t('voucher_duplicate')) : save} loading={saving} />}
        </>
      )}
    </div>
  )
}
