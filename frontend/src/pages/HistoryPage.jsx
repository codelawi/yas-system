import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, DatePicker, Empty, Input, Modal, Pagination, Result, Select, Table, Tag, Typography } from 'antd'
import {
  ApartmentOutlined,
  CameraOutlined,
  CheckCircleOutlined,
  ClusterOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  DownOutlined,
  EditOutlined,
  FileExcelOutlined,
  FileWordOutlined,
  FilterOutlined,
  HistoryOutlined,
  ImportOutlined,
  InboxOutlined,
  PlusOutlined,
  ToolOutlined,
  UnlockOutlined,
  UserSwitchOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api'
import { downloadFile } from '../download'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { ACTION_COLORS, Changes } from '../components/HistoryTimeline'
import { usePhone } from '../nav'
import { ChipRow, PhoneHeader, PhoneList, PhoneRow, PhoneSearch, PhoneSkeleton } from '../components/PhoneUI'

/* Phones: each kind of change with its own icon, tinted like its tag */
const ACTION_ICONS = {
  created: <PlusOutlined />,
  imported: <FileWordOutlined />,
  updated: <EditOutlined />,
  deleted: <DeleteOutlined />,
  accessory_added: <ApartmentOutlined />,
  accessory_removed: <DisconnectOutlined />,
  custody_out: <UserSwitchOutlined />,
  custody_in: <ImportOutlined />,
  maintenance_done: <ToolOutlined />,
  issue_reported: <WarningOutlined />,
  issue_closed: <CheckCircleOutlined />,
  box_added: <InboxOutlined />,
  box_removed: <InboxOutlined />,
  photo_changed: <CameraOutlined />,
  photo_removed: <CameraOutlined />,
  group_changed: <ClusterOutlined />,
}
const TONES = { green: 'green', lime: 'green', blue: 'blue', geekblue: 'blue', orange: 'amber', gold: 'amber', red: 'red', volcano: 'red', purple: 'violet', cyan: 'cyan' }

const hasChanges = (r) => r.changes && !r.changes.accessory && !(r.changes.summary && !r.changes.changed && !r.changes.added && !r.changes.removed) && r.action !== 'created' && !(r.action === 'imported' && !r.changes?.overwrite)

/** One line about what changed, or null */
function summaryOf(r, t) {
  const c = r.changes || {}
  if (c.summary && !c.changed && !c.added && !c.removed) return c.summary
  if (c.accessory) return [c.accessory.name, c.accessory.serial_number].filter(Boolean).join(' · ')
  if (!hasChanges(r)) return null
  return [c.changed?.length && `${t('ch_changed')} ${c.changed.length}`, c.added?.length && `${t('ch_added')} ${c.added.length}`, c.removed?.length && `${t('ch_removed')} ${c.removed.length}`].filter(Boolean).join(' · ')
}

/** A change on a phone: tapping it shows what changed (or opens the equipment when there is nothing to show). */
function PhoneEntry({ r }) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const expandable = hasChanges(r)
  const link = r.equipment_id && r.action !== 'deleted' ? `/equipment/${r.equipment_id}` : null
  const summary = summaryOf(r, t)
  return (
    <div className={`phone-entry${open ? ' is-open' : ''}`}>
      <PhoneRow
        to={expandable ? undefined : link}
        onClick={expandable ? () => setOpen(!open) : undefined}
        icon={ACTION_ICONS[r.action] || <HistoryOutlined />}
        tone={TONES[ACTION_COLORS[r.action]] || 'slate'}
        title={<span className="serial">{r.serial_number || '—'}</span>}
        subtitle={
          <>
            <span className="phone-entry-action">{t(`act_${r.action}`)}</span>
            {r.user?.name && <span>{r.user.name}</span>}
          </>
        }
        meta={summary ? <span className="phone-row-details">{summary}</span> : null}
        end={
          <>
            <span className="phone-row-time">{dayjs(r.created_at).format('HH:mm')}</span>
            {expandable && <DownOutlined className="phone-entry-caret" />}
          </>
        }
        chevron={!expandable && !!link}
      />
      {open && (
        <div className="phone-entry-changes">
          <Changes changes={r.changes} t={t} />
          {link && (
            <Link to={link} className="phone-entry-link">
              {t('open_equipment')}
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

const ACTIONS = ['created', 'imported', 'updated', 'deleted', 'accessory_added', 'accessory_removed', 'custody_out', 'custody_in', 'maintenance_done', 'issue_reported', 'issue_closed', 'box_added', 'box_removed', 'photo_changed', 'photo_removed', 'group_changed']

/** Every change in the system. Only after entering a PIN. */
export default function HistoryPage() {
  const { t } = useLang()
  const { user, requirePin } = useAuth()
  const [filters, setFilters] = useState({ q: '', action: undefined, user_id: undefined, range: null })
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState({ data: [], total: 0, users: [] })
  const [loading, setLoading] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const phone = usePhone()

  useEffect(() => {
    if (!user) return
    setLoading(true)
    api
      .get('/activity', {
        params: {
          page,
          per_page: 50,
          q: filters.q || undefined,
          action: filters.action,
          user_id: filters.user_id,
          from: filters.range?.[0]?.format('YYYY-MM-DD'),
          to: filters.range?.[1]?.format('YYYY-MM-DD'),
        },
      })
      .then(({ data }) => setData(data))
      .finally(() => setLoading(false))
  }, [user, filters, page])

  if (!user) {
    return (
      <div className="page">
        <Result
          icon={<HistoryOutlined />}
          title={t('history_locked')}
          extra={
            <Button type="primary" size="large" icon={<UnlockOutlined />} onClick={requirePin}>
              {t('unlock')}
            </Button>
          }
        />
      </div>
    )
  }

  const setFilter = (patch) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(1)
  }
  const exportExcel = () =>
    downloadFile(
      '/activity/export',
      { q: filters.q || undefined, action: filters.action, user_id: filters.user_id, from: filters.range?.[0]?.format('YYYY-MM-DD'), to: filters.range?.[1]?.format('YYYY-MM-DD') },
      'history.xlsx',
    )

  if (phone) {
    const dayOf = (d) => {
      const day = dayjs(d)
      if (day.isSame(dayjs(), 'day')) return t('today')
      if (day.isSame(dayjs().subtract(1, 'day'), 'day')) return t('yesterday')
      return day.format('YYYY-MM-DD')
    }
    // Changes under the day they were made
    const days = []
    for (const r of data.data) {
      const label = dayOf(r.created_at)
      if (days.at(-1)?.label !== label) days.push({ label, rows: [] })
      days.at(-1).rows.push(r)
    }
    const userName = data.users.find((u) => u.id === filters.user_id)?.name
    const active = [
      filters.action && { key: 'action', label: t(`act_${filters.action}`), clear: { action: undefined } },
      filters.user_id && { key: 'user', label: userName || '…', clear: { user_id: undefined } },
      filters.range && { key: 'range', label: `${filters.range[0].format('MM-DD')} – ${filters.range[1].format('MM-DD')}`, clear: { range: null } },
    ].filter(Boolean)
    const setRange = (i, day) => {
      const range = [...(filters.range || [day, day])]
      range[i] = day
      if (!day) return setFilter({ range: null })
      if (range[0] && range[1] && range[0].isAfter(range[1])) range[1 - i] = day
      setFilter({ range })
    }

    return (
      <div className="page">
        <PhoneHeader
          title={t('history')}
          subtitle={t('history_n', { n: data.total })}
          more={[{ key: 'excel', icon: <FileExcelOutlined />, label: t('export_excel'), onClick: exportExcel }]}
        />
        <PhoneSearch value={search} placeholder={t('serial_number')} onChange={setSearch} onSearch={(v) => setFilter({ q: v })} />
        <ChipRow>
          <button type="button" className={`phone-chip${active.length ? ' is-on' : ''}`} onClick={() => setFiltering(true)}>
            <FilterOutlined /> {active.length ? `${t('filter_short')} (${active.length})` : t('filter_short')}
          </button>
          {active.map((f) => (
            <Tag key={f.key} className="phone-chip-tag" closable onClose={() => setFilter(f.clear)}>
              {f.label}
            </Tag>
          ))}
        </ChipRow>

        {loading && !data.data.length ? (
          <PhoneSkeleton />
        ) : days.length ? (
          days.map((day) => (
            <section key={day.label} className="phone-day">
              <h2 className="phone-day-label">{day.label}</h2>
              <PhoneList className={loading ? 'is-busy' : ''}>
                {day.rows.map((r) => (
                  <PhoneEntry key={r.id} r={r} />
                ))}
              </PhoneList>
            </section>
          ))
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_data')} />
        )}

        {data.total > 50 && <Pagination simple className="phone-pagination" current={page} pageSize={50} total={data.total} onChange={setPage} />}

        <Modal open={filtering} title={t('filter_short')} footer={null} onCancel={() => setFiltering(false)} destroyOnHidden>
          <div className="phone-filter-sheet">
            <label className="phone-field">
              <span>{t('action')}</span>
              <Select allowClear value={filters.action} placeholder={t('all_actions')} onChange={(v) => setFilter({ action: v })} options={ACTIONS.map((a) => ({ value: a, label: t(`act_${a}`) }))} />
            </label>
            <label className="phone-field">
              <span>{t('by')}</span>
              <Select allowClear value={filters.user_id} placeholder={t('all_users')} onChange={(v) => setFilter({ user_id: v })} options={data.users.map((u) => ({ value: u.id, label: u.name }))} />
            </label>
            <div className="phone-field-pair">
              <label className="phone-field">
                <span>{t('date_from')}</span>
                <DatePicker inputReadOnly value={filters.range?.[0]} onChange={(d) => setRange(0, d)} placement="bottomRight" />
              </label>
              <label className="phone-field">
                <span>{t('date_to')}</span>
                <DatePicker inputReadOnly value={filters.range?.[1]} onChange={(d) => setRange(1, d)} placement="bottomLeft" />
              </label>
            </div>
            <Button type="primary" block size="large" onClick={() => setFiltering(false)}>
              {t('show_results')}
            </Button>
          </div>
        </Modal>
      </div>
    )
  }

  return (
    <div className="page">
      <Typography.Title level={3}>
        <HistoryOutlined /> {t('history')}
      </Typography.Title>

      <div className="toolbar">
        <Input.Search
          allowClear
          value={search}
          placeholder={t('serial_number')}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(v) => setFilter({ q: v.trim() })}
          style={{ maxWidth: 260 }}
          dir="ltr"
        />
        <Select allowClear value={filters.action} placeholder={t('all_actions')} onChange={(v) => setFilter({ action: v })} options={ACTIONS.map((a) => ({ value: a, label: t(`act_${a}`) }))} style={{ minWidth: 160 }} />
        <Select allowClear value={filters.user_id} placeholder={t('all_users')} onChange={(v) => setFilter({ user_id: v })} options={data.users.map((u) => ({ value: u.id, label: u.name }))} style={{ minWidth: 160 }} />
        <DatePicker.RangePicker value={filters.range} onChange={(range) => setFilter({ range })} />
        <Button icon={<FileExcelOutlined />} onClick={exportExcel}>
          {t('export_excel')}
        </Button>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={data.data}
        scroll={{ x: 'max-content' }}
        pagination={{ current: page, pageSize: 50, total: data.total, showSizeChanger: false, onChange: setPage, showTotal: (n) => `${n}` }}
        expandable={{ expandedRowRender: (r) => <Changes changes={r.changes} t={t} />, rowExpandable: hasChanges }}
        columns={[
          { title: t('backup_date'), dataIndex: 'created_at', width: 150, render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm') },
          { title: t('action'), dataIndex: 'action', render: (a) => <Tag color={ACTION_COLORS[a]}>{t(`act_${a}`)}</Tag> },
          {
            title: t('serial_number'),
            dataIndex: 'serial_number',
            render: (v, r) =>
              r.equipment_id && r.action !== 'deleted' ? (
                <Link to={`/equipment/${r.equipment_id}`} className="serial">
                  {v}
                </Link>
              ) : (
                <span className="serial">{v || '—'}</span>
              ),
          },
          { title: t('by'), dataIndex: ['user', 'name'], render: (v) => v || '—' },
          {
            title: t('details'),
            key: 'summary',
            render: (_, r) => {
              const summary = summaryOf(r, t)
              return summary ? <span>{summary}</span> : <Typography.Text type="secondary">—</Typography.Text>
            },
          },
        ]}
      />
    </div>
  )
}
