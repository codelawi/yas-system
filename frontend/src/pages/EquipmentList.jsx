import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { App, Button, Input, Popconfirm, Segmented, Spin, Table, Tag, Typography } from 'antd'
import { ApartmentOutlined, ClusterOutlined, DeleteOutlined, ExportOutlined, EditOutlined, FileExcelOutlined, FilePdfOutlined, PlusOutlined, PrinterOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import EquipmentForm from '../components/EquipmentForm'
import FieldFilter, { CATEGORY_KEY, filterLabel } from '../components/FieldFilter'
import { useLargeDelete } from '../largeDelete'
import BulkEditModal from '../components/BulkEditModal'
import { downloadFile } from '../download'

function parseFilters(params) {
  let filters = []
  try {
    filters = JSON.parse(params.get('filters') || '[]')
  } catch {
    /* ignore a broken URL */
  }
  return Array.isArray(filters) ? filters : []
}

/** The units of one group in the grouped list, with the list's search / filters. */
function GroupRows({ group, listParams, columns, selected, setSelected, reloadKey }) {
  const { t } = useLang()
  const [rows, setRows] = useState(null)
  const paramsKey = JSON.stringify(listParams)

  useEffect(() => {
    api.get('/equipment', { params: { ...JSON.parse(paramsKey), group_id: group.id, per_page: 200 } }).then(({ data }) => setRows(data))
  }, [group.id, paramsKey, reloadKey])

  if (!rows) return <Spin size="small" />
  const ids = rows.data.map((r) => r.id)

  return (
    <>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows.data}
        pagination={false}
        showHeader={false}
        // Shares the selection with the main list
        rowSelection={{
          selectedRowKeys: selected.filter((id) => ids.includes(id)),
          onChange: (keys) => setSelected([...selected.filter((id) => !ids.includes(id)), ...keys]),
        }}
        scroll={{ x: 'max-content' }}
      />
      {rows.total > rows.data.length && (
        <Link to={`/groups/${group.id}`}>{t('group_show_all', { n: rows.total })}</Link>
      )}
    </>
  )
}

export default function EquipmentList() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState({ data: [], total: 0 })
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState([])
  const [deleting, setDeleting] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const { message } = App.useApp()
  const [formOpen, setFormOpen] = useState(false)
  const [search, setSearch] = useState(params.get('q') || '')
  const [groups, setGroups] = useState([])
  const [expanded, setExpanded] = useState([])
  const [reloadKey, setReloadKey] = useState(0)

  const page = Number(params.get('page') || 1)
  const perPage = Number(params.get('per_page') || 20)
  const q = params.get('q') || ''
  const filtersParam = params.get('filters') || ''
  const filters = parseFilters(params)
  const importId = params.get('import_id') || undefined
  const type = params.get('type') || 'all'
  const sort = params.get('sort') || undefined
  const dir = params.get('dir') || undefined
  // Grouped list: each group is one row that opens to its units (accessories are never grouped)
  const grouped = params.get('view') !== 'flat' && type !== 'accessory'

  const setParam = (patch) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  const load = useCallback(() => {
    setLoading(true)
    const listQuery = { q, filters: filtersParam || undefined, import_id: importId, type, sort, dir }
    setReloadKey((k) => k + 1)
    Promise.all([
      api.get('/equipment', { params: { ...listQuery, page, per_page: perPage, ungrouped: grouped ? 1 : undefined } }),
      grouped ? api.get('/equipment/group-summary', { params: listQuery }) : Promise.resolve({ data: [] }),
    ])
      .then(([list, summary]) => {
        setData(list.data)
        setGroups(summary.data)
      })
      .finally(() => setLoading(false))
  }, [page, perPage, q, filtersParam, importId, type, sort, dir, grouped])

  const sortOrder = (key) => (sort === key ? (dir === 'asc' ? 'ascend' : 'descend') : null)

  const setFilters = (next) => setParam({ filters: next.length ? JSON.stringify(next) : null, page: null })

  useEffect(load, [load])

  // Same search / filters / sorting as on screen
  const listParams = { q, filters: filtersParam || undefined, import_id: importId, type, sort, dir }
  const exportExcel = async () => {
    if (!(await requirePin())) return
    setExporting(true)
    try {
      await downloadFile('/equipment/export', listParams, 'equipment.xlsx')
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setExporting(false)
    }
  }
  const printList = () => {
    const query = new URLSearchParams(Object.entries(listParams).filter(([, v]) => v && v !== 'all'))
    window.open(`/print/list?${query}`, '_blank')
  }
  const bulkEdit = async () => {
    if (await requirePin()) setBulkOpen(true)
  }

  const deleteWithPin = useLargeDelete()
  const removeSelected = async () => {
    if (!(await requirePin())) return
    setDeleting(true)
    try {
      const res = await deleteWithPin((pin) => api.post('/equipment/bulk-delete', { ids: selected, pin }))
      if (!res) return
      message.success(t('deleted_n', { n: res.data.deleted }))
      setSelected([])
      load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setDeleting(false)
    }
  }

  const add = async () => {
    if (await requirePin()) setFormOpen(true)
  }

  // Quick action on the home page: /equipment?add=1
  useEffect(() => {
    if (params.get('add') !== '1') return
    setParam({ add: null })
    add()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when arriving with ?add=1
  }, [])

  const toggleGroup = (key) => setExpanded(expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key])

  const columns = [
    {
      title: <span title={t('row_no_long')}>{t('row_no')}</span>,
      dataIndex: 'row_no',
      width: 64,
      align: 'center',
      sorter: true,
      sortOrder: sortOrder('row_no'),
      render: (v) => (v ?? <Typography.Text type="secondary">—</Typography.Text>),
    },
    {
      title: t('serial_number'),
      dataIndex: 'serial_number',
      sorter: true,
      sortOrder: sortOrder('serial_number'),
      render: (v, r) => (
        <Link to={`/equipment/${r.id}`} className="serial list-big">
          {v}
        </Link>
      ),
    },
    {
      title: t('name_field'),
      dataIndex: 'display_name',
      render: (v, r) =>
        v ? (
          <Link to={`/equipment/${r.id}`} className="list-big list-title">
            {v}
          </Link>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '',
      key: 'kind',
      render: (_, r) =>
        r.parent ? (
          <Link to={`/equipment/${r.parent.id}`}>
            <Tag color="purple" icon={<ApartmentOutlined />}>
              {t('accessory_of')} <span className="serial">{r.parent.serial_number}</span>
            </Tag>
          </Link>
        ) : r.accessories_count > 0 ? (
          <Tag icon={<ApartmentOutlined />}>{t('accessories_n', { n: r.accessories_count })}</Tag>
        ) : null,
    },
    {
      title: t('fields'),
      dataIndex: 'fields',
      render: (fields) => (
        <div className="field-preview">
          {fields.slice(0, 4).map((f, i) => (
            <span key={i}>
              <b><bdi>{f.key}</bdi>:</b> <bdi>{f.value.split("\n")[0]}</bdi>
            </span>
          ))}
          {fields.length > 4 && <Typography.Text type="secondary">+{fields.length - 4}</Typography.Text>}
        </div>
      ),
    },
    { title: t('updated_at'), dataIndex: 'updated_at', render: (v) => dayjs(v).format('YYYY-MM-DD'), responsive: ['lg'], width: 120 },
  ]

  // A group row: its name (click to open its units) and how many match, spanning the other columns
  const groupColumns = columns.map((col, i) => ({
    ...col,
    onCell: (r) => (r.isGroup ? { colSpan: i === 1 ? columns.length - 1 : i === 0 ? 1 : 0 } : {}),
    render: (v, r, index) => {
      if (!r.isGroup) return col.render ? col.render(v, r, index) : v
      if (i === 0) return <ClusterOutlined className="group-row-icon" />
      return (
        <span className="group-row">
          <a className="list-big list-title" onClick={() => toggleGroup(`g${r.id}`)}>
            {r.name}
          </a>
          <Tag color="cyan">{t('n_items', { n: r.count })}</Tag>
          <Link to={`/groups/${r.id}`} title={t('open_group')}>
            <ExportOutlined />
          </Link>
        </span>
      )
    },
  }))
  const rows = grouped && page === 1 ? [...groups.map((g) => ({ ...g, isGroup: true })), ...data.data] : data.data

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>{t('equipment')}</Typography.Title>
        <div className="page-actions">
          <Button icon={<FileExcelOutlined />} loading={exporting} onClick={exportExcel}>
            {t('export_excel')}
          </Button>
          <Button icon={<FilePdfOutlined />} onClick={printList}>
            {t('print_pdf')}
          </Button>
          {selected.length > 0 && (
            <Button icon={<EditOutlined />} onClick={bulkEdit}>
              {t('bulk_edit', { n: selected.length })}
            </Button>
          )}
          {selected.length > 0 && (
            <Popconfirm
              title={t('delete_selected_confirm', { n: selected.length })}
              description={
                <>
                  {t('delete_selected_hint')}
                  {selected.length > 5 && <div>{t('big_delete_hint')}</div>}
                </>
              }
              okText={t('delete')}
              cancelText={t('cancel')}
              okButtonProps={{ danger: true }}
              onConfirm={removeSelected}
            >
              <Button danger icon={<DeleteOutlined />} loading={deleting}>
                {t('delete_selected', { n: selected.length })}
              </Button>
            </Popconfirm>
          )}
          <Button icon={<PrinterOutlined />} disabled={!selected.length} onClick={() => window.open(`/labels?ids=${selected.join(',')}`, '_blank')}>
            {t('print_labels', { n: selected.length })}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={add}>
            {t('add_equipment')}
          </Button>
        </div>
      </div>

      <div className="toolbar">
        <Input.Search
          allowClear
          value={search}
          placeholder={t('search')}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(v) => setParam({ q: v.trim(), page: null })}
          style={{ maxWidth: 420 }}
        />
        <Segmented
          value={grouped ? 'grouped' : 'flat'}
          disabled={type === 'accessory'}
          onChange={(v) => setParam({ view: v === 'flat' ? 'flat' : null, page: null })}
          options={[
            { value: 'grouped', label: t('view_grouped') },
            { value: 'flat', label: t('view_flat') },
          ]}
        />
        <Segmented
          value={type}
          onChange={(v) => setParam({ type: v === 'all' ? null : v, page: null })}
          options={['all', 'main', 'accessory'].map((v) => ({ value: v, label: t(`type_${v}`) }))}
        />
        <FieldFilter
          onAdd={(f) => {
            // Same field again replaces its old value
            setFilters([...filters.filter((x) => x.key !== f.key), f])
          }}
        />
        {filters.map((f) => (
          <Tag key={f.key} color={f.key === CATEGORY_KEY ? 'blue' : 'geekblue'} closable onClose={() => setFilters(filters.filter((x) => x.key !== f.key))}>
            <bdi>{filterLabel(f, t)}</bdi>
          </Tag>
        ))}
        {filters.length > 1 && (
          <Button size="small" type="link" onClick={() => setFilters([])}>
            {t('clear_filters')}
          </Button>
        )}
        {importId && (
          <Tag closable onClose={() => setParam({ import_id: null })}>
            {t('import')} #{importId}
          </Tag>
        )}
      </div>

      <Table
        rowKey={(r) => (r.isGroup ? `g${r.id}` : r.id)}
        loading={loading}
        columns={grouped ? groupColumns : columns}
        dataSource={rows}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.filter((k) => typeof k === 'number')),
          preserveSelectedRowKeys: true,
          getCheckboxProps: (r) => ({ disabled: !!r.isGroup }),
        }}
        rowClassName={(r) => (r.isGroup ? 'group-row-line' : '')}
        expandable={
          grouped
            ? {
                expandedRowKeys: expanded,
                onExpandedRowsChange: (keys) => setExpanded(keys),
                rowExpandable: (r) => !!r.isGroup,
                expandedRowRender: (r) => (
                  <GroupRows group={r} listParams={listParams} columns={columns} selected={selected} setSelected={setSelected} reloadKey={reloadKey} />
                ),
              }
            : undefined
        }
        onRow={(r) => ({ onDoubleClick: () => (r.isGroup ? navigate(`/groups/${r.id}`) : navigate(`/equipment/${r.id}`)) })}
        onChange={(_, __, sorter, extra) => {
          if (extra.action !== 'sort') return
          const order = sorter.order
          setParam({ sort: order ? sorter.field : null, dir: order === 'ascend' ? 'asc' : order ? 'desc' : null, page: null })
        }}
        pagination={{
          current: page,
          pageSize: perPage,
          total: data.total,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (total) => (grouped && groups.length ? `${total} + ${t('groups_n', { n: groups.length })}` : `${total}`),
          onChange: (p, size) => setParam({ page: p > 1 ? p : null, per_page: size !== 20 ? size : null }),
        }}
        scroll={{ x: 'max-content' }}
      />

      <BulkEditModal
        ids={selected}
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={() => {
          setBulkOpen(false)
          load()
        }}
      />
      <EquipmentForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={(eq) => {
          setFormOpen(false)
          navigate(`/equipment/${eq.id}`)
        }}
      />
    </div>
  )
}
