import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, App, Button, Card, Col, Empty, Row, Select, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd'
import {
  ApartmentOutlined,
  AppstoreOutlined,
  CameraOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  ExclamationCircleFilled,
  FileWordOutlined,
  HistoryOutlined,
  InboxOutlined,
  PlusOutlined,
  PrinterOutlined,
  QrcodeOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import api, { equipmentUrl } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { useSettings } from '../settings'
import QrCode from '../components/QrCode'
import HistoryLocked from '../components/HistoryLocked'
import { CATEGORY_KEY } from '../components/FieldFilter'
import { DUE_COLOR, dueState } from '../components/MaintenanceCard'

dayjs.extend(relativeTime)

const MAX_BARS = 10
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n))
const filterLink = (key, value) => `/equipment?filters=${encodeURIComponent(JSON.stringify([{ key, value }]))}`

export default function Dashboard() {
  const { t } = useLang()
  const { user } = useAuth()
  const [stats, setStats] = useState(null)
  const [reload, setReload] = useState(0)

  // Reload after the PIN is entered: the activity chart is only sent then
  useEffect(() => {
    api.get('/stats').then(({ data }) => setStats(data))
  }, [user, reload])

  // Labels printed in another tab leave the «waiting for a label» list
  useEffect(() => {
    const again = () => setReload((n) => n + 1)
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [])

  if (!stats) return <Spin size="large" className="page-spin" />

  return (
    <div className="page dashboard">
      <Typography.Title level={3}>{t('dashboard')}</Typography.Title>

      <QuickActions />

      <PendingLabelsCard pending={stats.pending_labels} onDone={() => setReload((n) => n + 1)} />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {[
          ['dash_main', stats.main, '/equipment?type=main', <AppstoreOutlined key="i" />],
          ['dash_accessories', stats.accessories, '/equipment?type=accessory', <ApartmentOutlined key="i" />],
          ['imports_count', stats.imports, '/import', <FileWordOutlined key="i" />],
          ['added_this_month', stats.added_this_month, '/equipment?sort=created_at&dir=desc', <PlusOutlined key="i" />],
          ['dash_labels_printed', stats.labels_printed, '/qr', <PrinterOutlined key="i" />],
          ['dash_without_data', stats.without_data, '/equipment?type=main', <WarningOutlined key="i" />],
        ].map(([key, value, to, icon]) => (
          <Col xs={12} md={8} xl={4} key={key}>
            <Link to={to} className="stat-tile">
              <span className="stat-icon">{icon}</span>
              <span className="stat-label">{t(key)}</span>
              <span className="stat-value">{compact(value)}</span>
            </Link>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <BreakdownCard />
        </Col>
        <Col xs={24} xl={8}>
          <HealthCard health={stats.health} />
        </Col>
        <Col xs={24} lg={12}>
          <FollowUpCard stats={stats} />
        </Col>
        <Col xs={24} lg={12}>
          <AttentionCard attention={stats.attention} />
        </Col>
        <Col xs={24} xl={16}>
          <RecentCard stats={stats} />
        </Col>
        <Col xs={24} xl={8}>
          <PhoneQrCard />
        </Col>
        <Col xs={24}>
          {stats.activity_by_day ? <ActivityCard days={stats.activity_by_day} /> : <HistoryLocked title={t('dash_activity')} />}
        </Col>
      </Row>
    </div>
  )
}

function QuickActions() {
  const { t } = useLang()
  const actions = [
    ['/scan', <CameraOutlined key="i" />, 'scan_title', 'dash_qa_scan'],
    ['/import', <FileWordOutlined key="i" />, 'import', 'dash_qa_import'],
    ['/equipment?add=1', <PlusOutlined key="i" />, 'add_equipment', 'dash_qa_add'],
    ['/qr', <PrinterOutlined key="i" />, 'print_labels_title', 'dash_qa_print'],
  ]
  return (
    <div className="quick-actions">
      {actions.map(([to, icon, title, hint]) => (
        <Link key={to} to={to} className="quick-action">
          <span className="quick-action-icon">{icon}</span>
          <span>
            <b>{t(title)}</b>
            <small>{t(hint)}</small>
          </span>
        </Link>
      ))}
    </div>
  )
}

/** Horizontal bars: how many equipment have each value of a chosen field. */
function BreakdownCard() {
  const { t } = useLang()
  const navigate = useNavigate()
  const [keys, setKeys] = useState([])
  const [key, setKey] = useState(null)
  const [values, setValues] = useState(null)

  useEffect(() => {
    api.get('/equipment/keys').then(({ data }) => {
      setKeys(data)
      // Start with a location-like field when there is one
      setKey(data.find((k) => /مكان|موقع|location/i.test(k)) || data[0] || CATEGORY_KEY)
    })
  }, [])

  useEffect(() => {
    if (!key) return
    setValues(null)
    api.get('/equipment/values', { params: { key } }).then(({ data }) => setValues(data))
  }, [key])

  const bars = useMemo(() => {
    if (!values) return []
    const top = values.slice(0, MAX_BARS).map((v) => ({ label: v.value.split('\n')[0], value: v.value, count: v.uses }))
    const rest = values.slice(MAX_BARS).reduce((n, v) => n + v.uses, 0)
    return rest ? [...top, { label: t('dash_others'), count: rest, other: true }] : top
  }, [values, t])
  const max = Math.max(1, ...bars.map((b) => b.count))

  return (
    <Card
      title={t('dash_breakdown')}
      extra={
        <Select
          showSearch
          value={key}
          onChange={setKey}
          optionFilterProp="label"
          options={[{ value: CATEGORY_KEY, label: t('category') }, ...keys.map((k) => ({ value: k, label: k }))]}
          style={{ minWidth: 180 }}
          popupMatchSelectWidth={false}
        />
      }
    >
      {!values ? (
        <Spin />
      ) : !bars.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_data')} />
      ) : (
        <div className="hbars" role="table" aria-label={t('dash_breakdown')}>
          {bars.map((b) => (
            <Tooltip key={b.label} title={`${b.label}: ${b.count}`} placement="top">
              <button type="button" className="hbar-row" role="row" disabled={b.other} onClick={() => navigate(filterLink(key, b.value))}>
                <span className="hbar-label" role="cell">
                  <bdi>{b.label}</bdi>
                </span>
                <span className="hbar-track" role="cell">
                  <span className="hbar" style={{ width: `${(b.count / max) * 100}%` }} />
                  <span className="hbar-value">{b.count}</span>
                </span>
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('dash_breakdown_hint')}
      </Typography.Text>
    </Card>
  )
}

function HealthCard({ health }) {
  const { t } = useLang()
  const backupHours = health.last_backup_at ? dayjs().diff(dayjs(health.last_backup_at), 'hour') : null
  const rows = [
    {
      ok: health.qr_status === 'ok',
      warn: health.qr_status !== 'mismatch',
      title: t('net_qr_address'),
      body: (
        <>
          <span className="serial" style={{ fontWeight: 400 }}>{health.qr_address || '—'}</span>
          <div>{t(`net_status_${health.qr_status}`)}</div>
        </>
      ),
      to: '/network',
    },
    {
      ok: true,
      title: t('dash_labels_printed'),
      body: health.labels_printed_here ? t('qr_locked_info', { n: health.labels_printed_here }) : t('dash_no_labels'),
      to: '/qr',
    },
    {
      ok: backupHours !== null && backupHours <= 30,
      warn: backupHours !== null,
      title: t('backup_title'),
      body: backupHours === null ? t('backup_never') : t('backup_last', { when: dayjs(health.last_backup_at).fromNow(), date: dayjs(health.last_backup_at).format('YYYY-MM-DD HH:mm') }),
      to: '/settings',
    },
  ]
  return (
    <Card
      title={
        <span>
          <DatabaseOutlined /> {t('dash_health')}
        </span>
      }
    >
      <div className="health-list">
        {rows.map((r) => (
          <Link key={r.title} to={r.to} className="health-row">
            {r.ok ? <CheckCircleFilled className="health-ok" /> : r.warn ? <ExclamationCircleFilled className="health-warn" /> : <CloseCircleFilled className="health-bad" />}
            <span>
              <b>{r.title}</b>
              <div className="health-body">{r.body}</div>
            </span>
          </Link>
        ))}
      </div>
    </Card>
  )
}

/** Maintenance due and open problem reports. */
function FollowUpCard({ stats }) {
  const { t } = useLang()
  const { maintenance, issues } = stats
  const badge = (n, color) => (n > 0 ? <Tag color={color} style={{ marginInlineStart: 6 }}>{n}</Tag> : null)
  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_data')} />

  return (
    <Card title={t('follow_up')} styles={{ body: { paddingTop: 0 } }}>
      <Tabs
        items={[
          {
            key: 'maintenance',
            label: (
              <span>
                {t('maintenance')}
                {badge(maintenance.overdue, 'red')}
                {badge(maintenance.soon, 'orange')}
              </span>
            ),
            children: maintenance.items.length ? (
              <div className="mini-list">
                {maintenance.items.map((m) => (
                  <Link key={m.id} to={`/equipment/${m.equipment.id}`} className="mini-row">
                    <Tag color={DUE_COLOR[dueState(m.due_date)]}>{dayjs(m.due_date).format('YYYY-MM-DD')}</Tag>
                    <span className="mini-sub">
                      <b className="serial">{m.equipment.serial_number || '—'}</b>
                      {m.equipment.display_name && ` · ${m.equipment.display_name}`} · {m.title}
                    </span>
                    <span className="mini-date">{dayjs(m.due_date).fromNow()}</span>
                  </Link>
                ))}
              </div>
            ) : (
              empty
            ),
          },
          {
            key: 'issues',
            label: (
              <span>
                {t('open_issues')}
                {badge(issues.open, 'volcano')}
              </span>
            ),
            children: issues.items.length ? (
              <div className="mini-list">
                {issues.items.map((i) => (
                  <Link key={i.id} to={`/equipment/${i.equipment.id}`} className="mini-row">
                    <span className="serial">{i.equipment.serial_number || '—'}</span>
                    <span className="mini-sub">{[i.equipment.display_name, i.description].filter(Boolean).join(' · ')}</span>
                    <span className="mini-date">{dayjs(i.created_at).fromNow()}</span>
                  </Link>
                ))}
              </div>
            ) : (
              empty
            ),
          },
        ]}
      />
    </Card>
  )
}

/** Shown on the first rows of the list; the print pages take all of them. */
const PENDING_SHOWN = 6

/**
 * Equipment and boxes added on a phone without a connection: their labels were never printed.
 * Printing them (or «Done») takes them off the list, on every device.
 */
function PendingLabelsCard({ pending, onDone }) {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const equipment = pending?.equipment || []
  const boxes = pending?.boxes || []
  if (!equipment.length && !boxes.length) return null

  const done = async () => {
    if (!(await requirePin())) return
    setBusy(true)
    try {
      await api.post('/labels/pending/clear', { equipment_ids: equipment.map((e) => e.id), box_ids: boxes.map((b) => b.id) })
      onDone()
    } catch {
      message.error(t('error'))
    } finally {
      setBusy(false)
    }
  }

  const rows = [
    ...equipment.map((e) => ({ key: `e${e.id}`, to: `/equipment/${e.id}`, code: e.serial_number, name: e.display_name })),
    ...boxes.map((b) => ({ key: `b${b.id}`, to: `/boxes/${b.id}`, code: `${t('box')} ${b.number}`, name: b.name })),
  ]
  return (
    <Card
      className="pending-labels"
      style={{ marginBottom: 16 }}
      title={
        <span>
          <PrinterOutlined /> {t('pending_labels_title')} <Tag color="orange">{rows.length}</Tag>
        </span>
      }
    >
      <Typography.Paragraph type="secondary">{t('pending_labels_hint')}</Typography.Paragraph>
      <div className="mini-list">
        {rows.slice(0, PENDING_SHOWN).map((row) => (
          <Link key={row.key} to={row.to} className="mini-row">
            <span className="serial">{row.code}</span>
            {row.name && <span className="mini-sub">{row.name}</span>}
          </Link>
        ))}
        {rows.length > PENDING_SHOWN && <Typography.Text type="secondary">{t('and_n_more', { n: rows.length - PENDING_SHOWN })}</Typography.Text>}
      </div>
      <Space wrap style={{ marginTop: 12 }}>
        {equipment.length > 0 && (
          <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.open(`/labels?ids=${equipment.map((e) => e.id).join(',')}`, '_blank')}>
            {t('pending_labels_print_equipment', { n: equipment.length })}
          </Button>
        )}
        {boxes.length > 0 && (
          <Button icon={<InboxOutlined />} onClick={() => window.open(`/boxes/labels?ids=${boxes.map((b) => b.id).join(',')}`, '_blank')}>
            {t('pending_labels_print_boxes', { n: boxes.length })}
          </Button>
        )}
        <Button icon={<CheckCircleFilled />} loading={busy} onClick={done}>
          {t('pending_labels_done')}
        </Button>
      </Space>
    </Card>
  )
}

function AttentionCard({ attention }) {
  const { t } = useLang()
  return (
    <Card
      title={
        <span>
          <WarningOutlined /> {t('dash_attention')} {attention.total > 0 && <Tag color="orange">{attention.total}</Tag>}
        </span>
      }
    >
      {!attention.items.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dash_attention_none')} />
      ) : (
        <div className="mini-list">
          {attention.items.map((i) => (
            <Link key={i.id} to={`/equipment/${i.id}`} className="mini-row">
              <span className="serial">{i.serial_number || '—'}</span>
              <span className="mini-sub">
                <bdi>{i.key}</bdi>: <bdi>{i.value}</bdi>
              </span>
            </Link>
          ))}
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        {t('dash_attention_words')}: {attention.words.join('، ') || '—'}
      </Typography.Text>
    </Card>
  )
}

function RecentCard({ stats }) {
  const { t } = useLang()
  return (
    <Card styles={{ body: { paddingTop: 0 } }}>
      <Tabs
        items={[
          {
            key: 'eq',
            label: t('dash_recent_equipment'),
            children: stats.recent_equipment.length ? (
              <div className="mini-list">
                {stats.recent_equipment.map((e) => (
                  <Link key={e.id} to={`/equipment/${e.id}`} className="mini-row">
                    <span className="serial">{e.serial_number}</span>
                    <span className="mini-sub">
                      {e.display_name}
                      {e.accessories_count > 0 && ` · ${t('accessories_n', { n: e.accessories_count })}`}
                    </span>
                    <span className="mini-date">{dayjs(e.created_at).fromNow()}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_data')} />
            ),
          },
          {
            key: 'imports',
            label: t('dash_recent_imports'),
            children: stats.recent_imports.length ? (
              <div className="mini-list">
                {stats.recent_imports.map((i) => (
                  <Link key={i.id} to={`/equipment?import_id=${i.id}`} className="mini-row">
                    <span>
                      <FileWordOutlined /> {i.original_name}
                    </span>
                    <span className="mini-sub">
                      {t('dash_import_counts', { c: i.created_count, u: i.updated_count })}
                      {i.user && ` · ${i.user}`}
                    </span>
                    <span className="mini-date">{dayjs(i.committed_at).fromNow()}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_data')} />
            ),
          },
        ]}
      />
    </Card>
  )
}

/** Columns: changes per day, last 30 days (only with a PIN). */
function ActivityCard({ days }) {
  const { t } = useLang()
  const max = Math.max(1, ...days.map((d) => d.count))
  const total = days.reduce((n, d) => n + d.count, 0)
  const top = Math.ceil(max / 5) * 5 || 5
  return (
    <Card
      title={
        <span>
          <HistoryOutlined /> {t('dash_activity')}
        </span>
      }
      extra={<Link to="/history">{t('history')}</Link>}
    >
      <Typography.Text type="secondary">{t('dash_activity_total', { n: total })}</Typography.Text>
      <div className="vchart">
        <div className="vchart-axis">
          <span>{top}</span>
          <span>{Math.round(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="vchart-plot">
          {days.map((d, i) => (
            <Tooltip key={d.date} title={`${dayjs(d.date).format('YYYY-MM-DD')}: ${d.count}`}>
              <div className="vbar-slot">
                <div className="vbar" style={{ height: `${(d.count / top) * 100}%` }} />
                {(i % 5 === 0 || i === days.length - 1) && <span className="vbar-tick">{dayjs(d.date).format('D/M')}</span>}
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
    </Card>
  )
}

/** A QR phones scan to open the system on the current network. */
function PhoneQrCard() {
  const { t } = useLang()
  const { settings } = useSettings()
  const url = equipmentUrl(settings, 'x').replace(/\/eq\/x$/, '')
  return (
    <Card
      title={
        <span>
          <QrcodeOutlined /> {t('dash_phone_qr')}
        </span>
      }
    >
      <div className="qr-box">
        <QrCode value={url} size={150} />
        <span className="serial qr-url" style={{ fontWeight: 400 }}>
          {url}
        </span>
        <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
          {t('dash_phone_qr_help')}
        </Typography.Text>
        {['localhost', '127.0.0.1'].includes(new URL(url).hostname) && <Alert type="warning" showIcon title={t('localhost_warning')} />}
      </div>
    </Card>
  )
}
