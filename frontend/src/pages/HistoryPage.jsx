import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, DatePicker, Input, Result, Select, Table, Tag, Typography } from 'antd'
import { FileExcelOutlined, HistoryOutlined, UnlockOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api'
import { downloadFile } from '../download'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { ACTION_COLORS, Changes } from '../components/HistoryTimeline'

const ACTIONS = ['created', 'imported', 'updated', 'deleted', 'accessory_added', 'accessory_removed', 'custody_out', 'custody_in', 'maintenance_done', 'issue_reported', 'issue_closed']

/** Every change in the system. Only after entering a PIN. */
export default function HistoryPage() {
  const { t } = useLang()
  const { user, requirePin } = useAuth()
  const [filters, setFilters] = useState({ q: '', action: undefined, user_id: undefined, range: null })
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState({ data: [], total: 0, users: [] })
  const [loading, setLoading] = useState(false)

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
  const hasChanges = (r) => r.changes && !r.changes.accessory && !(r.changes.summary && !r.changes.changed && !r.changes.added && !r.changes.removed) && r.action !== 'created' && !(r.action === 'imported' && !r.changes?.overwrite)

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
        <Button
          icon={<FileExcelOutlined />}
          onClick={() =>
            downloadFile(
              '/activity/export',
              { q: filters.q || undefined, action: filters.action, user_id: filters.user_id, from: filters.range?.[0]?.format('YYYY-MM-DD'), to: filters.range?.[1]?.format('YYYY-MM-DD') },
              'history.xlsx',
            )
          }
        >
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
              const c = r.changes || {}
              if (c.summary && !c.changed && !c.added && !c.removed) return <span>{c.summary}</span>
              if (c.accessory) return <span>{[c.accessory.name, c.accessory.serial_number].filter(Boolean).join(' · ')}</span>
              if (!hasChanges(r)) return <Typography.Text type="secondary">—</Typography.Text>
              const parts = [c.changed?.length && `${t('ch_changed')} ${c.changed.length}`, c.added?.length && `${t('ch_added')} ${c.added.length}`, c.removed?.length && `${t('ch_removed')} ${c.removed.length}`].filter(Boolean)
              return <span>{parts.join(' · ')}</span>
            },
          },
        ]}
      />
    </div>
  )
}
