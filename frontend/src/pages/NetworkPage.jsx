import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Badge, Button, Card, Col, Input, Modal, Popconfirm, Popover, Row, Table, Tag, Tooltip, Typography } from 'antd'
import {
  AndroidOutlined,
  AppleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DesktopOutlined,
  EditOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  StopOutlined,
  WifiOutlined,
  WindowsOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { useSettings } from '../settings'
import QrCode from '../components/QrCode'
import { useQrAddressSaver } from '../qrAddress'
import SetupGuide from '../components/SetupGuide'

dayjs.extend(relativeTime)

const STATUS_TYPE = { ok: 'success', not_set: 'warning', localhost: 'warning', mismatch: 'error' }
const ONLINE_MINUTES = 5

/** Port the system is opened on right now (5173 in development, 80 on the server). */
function currentPort() {
  return window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
}

function urlFor(host) {
  const port = window.location.port
  return `${window.location.protocol}//${host}${port ? `:${port}` : ''}`
}

/** Short device description from a browser user agent. */
function describeDevice(ua = '') {
  const os = /iPhone/.test(ua)
    ? ['iPhone', <AppleOutlined key="i" />]
    : /iPad/.test(ua)
      ? ['iPad', <AppleOutlined key="i" />]
      : /Android/.test(ua)
        ? ['Android', <AndroidOutlined key="i" />]
        : /Windows/.test(ua)
          ? ['Windows', <WindowsOutlined key="i" />]
          : /Mac OS X|Macintosh/.test(ua)
            ? ['Mac', <AppleOutlined key="i" />]
            : [ua.split(/[\s/]/)[0] || '?', <DesktopOutlined key="i" />]
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return { os: os[0], icon: os[1], browser }
}

export default function NetworkPage() {
  const { t } = useLang()
  const { isAdmin, requirePin } = useAuth()
  const { setSettings } = useSettings()
  const { message } = App.useApp()
  const [info, setInfo] = useState(null)
  const [tests, setTests] = useState({})
  const [renaming, setRenaming] = useState(null)

  const load = useCallback(() => api.get('/network').then(({ data }) => setInfo(data)), [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [load])

  /** Admin-only actions: ask for the PIN, then check the role. */
  const asAdmin = async (fn) => {
    const user = await requirePin()
    if (!user) return
    if (user.role !== 'admin') return message.error(t('Admins only.'))
    try {
      await fn()
      await load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const saveQrAddress = useQrAddressSaver()
  const applyQrAddress = (url) =>
    asAdmin(async () => {
      const data = await saveQrAddress('/network/base-url', { base_url: url }, url, info.base_url)
      if (data) {
        setSettings(data)
        message.success(t('saved'))
      }
    })

  const test = async (url) => {
    setTests((s) => ({ ...s, [url]: 'testing' }))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      // no-cors: we only need to know the address answers
      await fetch(`${url}/api/network/ping`, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' })
      setTests((s) => ({ ...s, [url]: 'ok' }))
    } catch {
      setTests((s) => ({ ...s, [url]: 'fail' }))
    } finally {
      clearTimeout(timer)
    }
  }

  const updateDevice = (device, patch) => asAdmin(() => api.put(`/network/devices/${device.id}`, patch))
  const removeDevice = (device) => asAdmin(() => api.delete(`/network/devices/${device.id}`))

  if (!info) return <Card loading />

  const port = currentPort()
  const hostnameLocal = info.hostname ? info.hostname.toLowerCase().replace(/\.local$/, '') + '.local' : null
  const rows = [
    ...info.addresses.map((a) => ({ ...a, url: urlFor(a.ip) })),
    ...(hostnameLocal ? [{ interface: t('net_hostname'), ip: hostnameLocal, kind: 'hostname', url: urlFor(hostnameLocal) }] : []),
  ]

  const addressColumns = [
    { title: t('net_interface'), dataIndex: 'interface', responsive: ['md'] },
    {
      title: t('net_address'),
      dataIndex: 'ip',
      render: (ip, r) => (
        <div>
          <span className="serial">{ip}</span>{' '}
          {r.kind === 'hostname' ? (
            <Tooltip title={t('net_hostname_help')}>
              <Tag>{t('net_hostname')}</Tag>
            </Tooltip>
          ) : (
            <Tag color={r.kind === 'lan' ? 'green' : r.kind === 'link_local' ? 'default' : 'orange'}>{t(`net_kind_${r.kind}`)}</Tag>
          )}
        </div>
      ),
    },
    {
      title: t('net_link'),
      dataIndex: 'url',
      render: (url) => (
        <Typography.Text copyable={{ tooltips: [t('copy'), '✓'] }} className="serial" style={{ fontWeight: 400 }}>
          {url}
        </Typography.Text>
      ),
    },
    {
      key: 'actions',
      render: (_, r) => {
        const state = tests[r.url]
        const inUse = info.base_url === r.url
        return (
          <div className="page-actions" style={{ flexWrap: 'nowrap' }}>
            <Popover
              trigger="click"
              content={
                <div className="qr-box">
                  <QrCode value={r.url} size={180} />
                  <Typography.Text type="secondary">{t('net_scan_to_open')}</Typography.Text>
                </div>
              }
            >
              <Button size="small" icon={<QrcodeOutlined />} />
            </Popover>
            <Button
              size="small"
              loading={state === 'testing'}
              icon={state === 'ok' ? <CheckCircleOutlined style={{ color: '#16a34a' }} /> : state === 'fail' ? <CloseCircleOutlined style={{ color: '#dc2626' }} /> : null}
              onClick={() => test(r.url)}
            >
              {state === 'ok' ? t('net_reachable') : state === 'fail' ? t('net_unreachable') : t('net_test')}
            </Button>
            {r.kind !== 'link_local' &&
              (inUse ? (
                <Tag color="blue" icon={<QrcodeOutlined />}>
                  {t('net_in_use')}
                </Tag>
              ) : (
                <Button size="small" type="primary" ghost onClick={() => applyQrAddress(r.url)}>
                  {t('net_use_for_qr')}
                </Button>
              ))}
          </div>
        )
      },
    },
  ]

  const deviceColumns = [
    {
      title: t('net_device'),
      key: 'device',
      render: (_, d) => {
        const { os, icon, browser } = describeDevice(d.user_agent || '')
        const online = d.last_seen_at && dayjs().diff(dayjs(d.last_seen_at), 'minute') < ONLINE_MINUTES
        return (
          <div className="device-cell">
            <Badge status={d.blocked ? 'error' : online ? 'success' : 'default'} />
            <span className="device-icon">{icon}</span>
            <div>
              <div>
                <b>{d.name || `${os}${browser ? ` · ${browser}` : ''}`}</b>{' '}
                {d.ip === info.your_ip && <Tag color="blue">{t('net_this_device')}</Tag>}
                {d.blocked && <Tag color="red">{t('net_blocked')}</Tag>}
              </div>
              {d.name && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {os}
                  {browser && ` · ${browser}`}
                </Typography.Text>
              )}
            </div>
          </div>
        )
      },
    },
    { title: t('net_address'), dataIndex: 'ip', render: (ip) => <span className="serial">{ip}</span> },
    { title: t('by'), dataIndex: ['last_user', 'name'], render: (v) => v || '—', responsive: ['md'] },
    {
      title: t('net_last_seen'),
      dataIndex: 'last_seen_at',
      render: (v) => (
        <Tooltip title={v && dayjs(v).format('YYYY-MM-DD HH:mm')}>
          {v && dayjs().diff(dayjs(v), 'minute') < ONLINE_MINUTES ? <Tag color="green">{t('net_online')}</Tag> : v ? dayjs(v).fromNow() : '—'}
        </Tooltip>
      ),
    },
    { title: t('net_requests'), dataIndex: 'hits', responsive: ['lg'] },
    {
      key: 'actions',
      align: 'end',
      render: (_, d) => (
        <div className="page-actions" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
          <Tooltip title={t('net_rename')}>
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setRenaming({ ...d, newName: d.name || '' })} />
          </Tooltip>
          {d.blocked ? (
            <Button size="small" onClick={() => updateDevice(d, { blocked: false })}>
              {t('net_unblock')}
            </Button>
          ) : (
            d.ip !== info.your_ip && (
              <Popconfirm title={t('net_block_confirm')} okText={t('net_block')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={() => updateDevice(d, { blocked: true })}>
                <Button size="small" danger icon={<StopOutlined />}>
                  {t('net_block')}
                </Button>
              </Popconfirm>
            )
          )}
          <Popconfirm title={`${t('delete')}?`} okText={t('delete')} cancelText={t('cancel')} onConfirm={() => removeDevice(d)}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <WifiOutlined /> {t('network')}
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={load}>
          {t('refresh')}
        </Button>
      </div>

      <Alert
        type={STATUS_TYPE[info.base_url_status]}
        showIcon
        style={{ marginBottom: 16 }}
        title={
          <span>
            <b>{t('net_qr_address')}:</b> <span className="serial">{info.base_url || '—'}</span>
          </span>
        }
        description={
          <span>
            {t(`net_status_${info.base_url_status}`)}
            {(info.labels_printed?.[info.base_url] || 0) > 0 && <> · {t('qr_locked_info', { n: info.labels_printed[info.base_url] })}</>}
          </span>
        }
      />

      <Card title={t('net_addresses')} style={{ marginBottom: 16 }}>
        <Typography.Paragraph type="secondary">{t('net_addresses_help')}</Typography.Paragraph>
        <Table rowKey="ip" columns={addressColumns} dataSource={rows} pagination={false} size="middle" scroll={{ x: 'max-content' }} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('net_your_device')}: <span className="serial">{info.your_ip}</span> · {t('net_tip_port', { port })}
        </Typography.Paragraph>
      </Card>

      <SetupGuide info={info} onUseAddress={applyQrAddress} />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card title={`${t('net_devices')} (${info.devices.length})`}>
            <Typography.Paragraph type="secondary">{t('net_devices_help')}</Typography.Paragraph>
            <Table rowKey="id" columns={isAdmin ? deviceColumns : deviceColumns.slice(0, -1)} dataSource={info.devices} pagination={{ pageSize: 20, hideOnSinglePage: true }} size="middle" scroll={{ x: 'max-content' }} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title={t('net_tips')}>
            <ul className="tips">
              <li>{t('net_tip_static')}</li>
              <li>{t('net_tip_wifi')}</li>
              <li>{t('net_tip_firewall', { port })}</li>
            </ul>
          </Card>
        </Col>
      </Row>

      <Modal
        open={!!renaming}
        title={t('net_rename')}
        okText={t('save')}
        cancelText={t('cancel')}
        onCancel={() => setRenaming(null)}
        onOk={async () => {
          await updateDevice(renaming, { name: renaming.newName.trim() || null })
          setRenaming(null)
        }}
        destroyOnHidden
        width={380}
      >
        {renaming && (
          <>
            <Typography.Paragraph type="secondary" className="serial">
              {renaming.ip}
            </Typography.Paragraph>
            <Input autoFocus value={renaming.newName} placeholder={t('net_name_placeholder')} onChange={(e) => setRenaming({ ...renaming, newName: e.target.value })} maxLength={100} />
          </>
        )}
      </Modal>
    </div>
  )
}
