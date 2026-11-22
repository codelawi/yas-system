import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Alert, App, Button, Card, Col, Form, Input, Modal, Popconfirm, Progress, Result, Row, Spin, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { AuditOutlined, CameraOutlined, DeleteOutlined, ScanOutlined, FileExcelOutlined, PlusOutlined, StopOutlined, UndoOutlined, UnlockOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { beep, downloadFile } from '../download'
import FieldFilter, { filterLabel } from '../components/FieldFilter'
import { decodePhoto } from './ScanLabelPage'
import CodeScanner from '../components/CodeScanner'
import { usePhone } from '../nav'
import { Fab, PhoneActions, PhoneHeader, PhoneList, PhoneRow, PhoneSkeleton } from '../components/PhoneUI'

function NeedPin() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  return (
    <div className="page">
      <Result
        icon={<AuditOutlined />}
        title={t('import_need_pin')}
        extra={
          <Button type="primary" size="large" icon={<UnlockOutlined />} onClick={requirePin}>
            {t('unlock')}
          </Button>
        }
      />
    </div>
  )
}

/** List of stocktakes + "new stocktake". */
export function StocktakesPage() {
  const { t } = useLang()
  const { user } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [list, setList] = useState(null)
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState([])
  const [form] = Form.useForm()
  const phone = usePhone()

  useEffect(() => {
    if (user) api.get('/stocktakes').then(({ data }) => setList(data))
  }, [user])

  if (!user) return <NeedPin />

  const create = async () => {
    const v = await form.validateFields()
    try {
      const { data } = await api.post('/stocktakes', { ...v, filters })
      navigate(`/stocktakes/${data.id}`)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const remove = async (sid) => {
    try {
      await api.delete(`/stocktakes/${sid}`)
      setList((l) => l.filter((s) => s.id !== sid))
      message.success(t('deleted'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const startNew = () => {
    form.setFieldsValue({ name: `${t('stocktake')} ${dayjs().format('YYYY-MM-DD')}`, include_accessories: true })
    setFilters([])
    setOpen(true)
  }

  const newStocktake = (
    <Modal open={open} title={t('new_stocktake')} okText={t('confirm')} cancelText={t('cancel')} onOk={create} onCancel={() => setOpen(false)} forceRender>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label={t('stocktake_name')} rules={[{ required: true, whitespace: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label={t('stocktake_scope')}>
          <FieldFilter onAdd={(f) => setFilters((fs) => [...fs.filter((x) => x.key !== f.key), f])} />
          <div style={{ marginTop: 8 }}>
            {filters.map((f) => (
              <Tag key={f.key} closable onClose={() => setFilters((fs) => fs.filter((x) => x.key !== f.key))}>
                <bdi>{filterLabel(f, t)}</bdi>
              </Tag>
            ))}
          </div>
        </Form.Item>
        <Form.Item name="include_accessories" label={t('include_accessories')} valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  )

  if (phone)
    return (
      <div className="page">
        <PhoneHeader title={t('stocktake')} subtitle={list ? t('stocktakes_n', { n: list.length }) : '\u00a0'} />
        {!list ? (
          <PhoneSkeleton rows={3} />
        ) : list.length ? (
          <PhoneList>
            {list.map((r) => {
              const open = r.status === 'open'
              const percent = r.expected_count ? Math.min(100, Math.round((r.scans_count / r.expected_count) * 100)) : 0
              return (
                <PhoneRow
                  key={r.id}
                  to={`/stocktakes/${r.id}`}
                  icon={<AuditOutlined />}
                  tone={open ? 'green' : 'slate'}
                  title={r.name}
                  subtitle={
                    <>
                      <span>{`${t('scanned')} ${r.scans_count} / ${r.expected_count}`}</span>
                      <span>{dayjs(r.created_at).format('YYYY-MM-DD')}</span>
                    </>
                  }
                  meta={<Progress percent={percent} size="small" showInfo={false} strokeColor={open ? '#16a34a' : '#94a3b8'} className="phone-row-progress" />}
                  end={<Tag color={open ? 'green' : 'default'}>{t(open ? 'open_status' : 'closed_status')}</Tag>}
                />
              )
            })}
          </PhoneList>
        ) : (
          <div className="phone-empty">
            <AuditOutlined className="phone-empty-icon" />
            <b>{t('no_stocktakes')}</b>
          </div>
        )}
        <Fab icon={<PlusOutlined />} label={t('new_stocktake')} onClick={startNew} />
        {newStocktake}
      </div>
    )

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <AuditOutlined /> {t('stocktake')}
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={startNew}>
          {t('new_stocktake')}
        </Button>
      </div>
      <Table
        rowKey="id"
        loading={!list}
        dataSource={list || []}
        onRow={(r) => ({ onClick: () => navigate(`/stocktakes/${r.id}`), style: { cursor: 'pointer' } })}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('stocktake_name'), dataIndex: 'name', render: (v, r) => <Link to={`/stocktakes/${r.id}`}>{v}</Link> },
          { title: '', dataIndex: 'status', render: (s) => <Tag color={s === 'open' ? 'blue' : 'default'}>{t(s === 'open' ? 'open_status' : 'closed_status')}</Tag> },
          { title: t('expected'), dataIndex: 'expected_count', align: 'center' },
          { title: t('scanned'), dataIndex: 'scans_count', align: 'center' },
          { title: t('backup_date'), dataIndex: 'created_at', render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm') },
          { title: t('by'), dataIndex: ['started_by', 'name'], render: (v) => v || '—' },
          {
            key: 'delete',
            render: (_, r) => (
              <span onClick={(e) => e.stopPropagation()}>
                <Popconfirm title={t('delete_stocktake_confirm')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={() => remove(r.id)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('delete')} />
                </Popconfirm>
              </span>
            ),
          },
        ]}
      />
      {newStocktake}
    </div>
  )
}

const RESULT_TYPE = { found: 'success', already: 'info', unexpected: 'warning', unknown: 'error' }

/** Scanning page of one stocktake (works on phones and with a USB barcode reader). */
export function StocktakePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t } = useLang()
  const { user } = useAuth()
  const { message } = App.useApp()
  const [report, setReport] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState(null)
  const [scanning, setScanning] = useState(false)
  const input = useRef(null)
  const photo = useRef(null)
  const phone = usePhone()

  const load = useCallback(() => api.get(`/stocktakes/${id}`).then(({ data }) => setReport(data)), [id])
  useEffect(() => {
    if (user) load()
  }, [user, load])

  if (!user) return <NeedPin />
  if (!report) return <Spin size="large" className="page-spin" />

  const isOpen = report.stocktake.status === 'open'
  const c = report.counts

  const submit = async (value) => {
    const text = (value ?? code).trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const { data } = await api.post(`/stocktakes/${id}/scan`, { code: text })
      setLast({ ...data, code: text })
      beep(data.status === 'found')
      setCode('')
      load()
    } catch (e) {
      beep(false)
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  const onPhoto = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await decodePhoto(file).catch(() => null)
    if (text) submit(text)
    else {
      beep(false)
      message.error(t('scan_failed'))
    }
  }

  /** The live camera (codes, or numbers read as text): each one is scanned, the result shown on the camera. */
  const onCameraCode = async (text) => {
    try {
      const { data } = await api.post(`/stocktakes/${id}/scan`, { code: text })
      setLast({ ...data, code: text })
      beep(data.status === 'found')
      load()
      return { type: data.status === 'found' ? 'success' : RESULT_TYPE[data.status] === 'error' ? 'error' : 'warning', text: `${data.scan.serial_number}\n${resultText(data)}` }
    } catch (e) {
      beep(false)
      return { type: 'error', text: t(errorKey(e) || 'error') }
    }
  }

  const undo = async (scanId) => {
    await api.delete(`/stocktakes/${id}/scans/${scanId}`)
    setLast(null)
    load()
  }

  const close = async () => {
    const { data } = await api.post(`/stocktakes/${id}/close`)
    setReport(data)
  }

  const remove = async () => {
    try {
      await api.delete(`/stocktakes/${id}`)
      message.success(t('deleted'))
      navigate('/stocktakes')
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const resultText = (r) => {
    if (r.status === 'unexpected') return t('res_unexpected', { loc: r.scan.equipment ? report.unexpected.find((u) => u.scan_id === r.scan.id)?.location || '—' : '—' })
    return t(`res_${r.status}`)
  }

  const listColumns = (withScan) => [
    {
      title: t('serial_number'),
      dataIndex: 'serial_number',
      render: (v, r) => (r.id ? <Link to={`/equipment/${r.id}`} className="serial">{v || '—'}</Link> : <span className="serial">{v}</span>),
    },
    { title: t('name_field'), dataIndex: 'name', render: (v) => v || '—' },
    { title: t('recorded_location'), dataIndex: 'location', render: (v) => v || '—' },
    ...(withScan
      ? [
          { title: t('scanned_at'), dataIndex: 'scanned_at' },
          {
            key: 'undo',
            render: (_, r) =>
              isOpen && (
                <Button size="small" type="text" icon={<UndoOutlined />} onClick={() => undo(r.scan_id)}>
                  {t('undo')}
                </Button>
              ),
          },
        ]
      : []),
  ]

  const exportExcel = () => downloadFile(`/stocktakes/${id}/export`, {}, `stocktake-${id}.xlsx`)
  const tags = (
    <>
      <Tag color={isOpen ? 'blue' : 'default'}>{t(isOpen ? 'open_status' : 'closed_status')}</Tag>
      {(report.stocktake.filters || []).map((f) => (
        <Tag key={f.key}>
          <bdi>{filterLabel(f, t)}</bdi>
        </Tag>
      ))}
    </>
  )
  const stats = [
    ['expected', c.expected, null],
    ['found', c.found, '#16a34a'],
    ['missing', c.missing, '#dc2626'],
    ['unexpected', c.unexpected, '#d97706'],
    ['unknown', c.unknown, '#6b7280'],
  ]

  return (
    <div className="page">
      {phone && (
        <>
          <PhoneHeader icon={<AuditOutlined />} title={report.stocktake.name} subtitle={<div className="phone-tags">{tags}</div>} />
          <PhoneActions
            actions={[
              { key: 'excel', icon: <FileExcelOutlined />, label: t('export_excel'), onClick: exportExcel },
              {
                key: 'close',
                icon: <StopOutlined />,
                label: t('close_stocktake'),
                danger: true,
                hidden: !isOpen,
                onClick: close,
                confirm: { title: t('close_stocktake_confirm'), okText: t('close_stocktake') },
              },
              { key: 'delete', icon: <DeleteOutlined />, label: t('delete'), danger: true, onClick: remove, confirm: { title: t('delete_stocktake_confirm') } },
            ]}
          />
          <div className="phone-stats">
            {stats.map(([key, value, color]) => (
              <div key={key} className="phone-stat">
                <span className="phone-stat-label">{t(key)}</span>
                <span className="phone-stat-value" style={color ? { color } : undefined}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {!phone && (
        <div className="page-head">
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              <AuditOutlined /> {report.stocktake.name}
            </Typography.Title>
            <div style={{ marginTop: 4 }}>{tags}</div>
          </div>
          <div className="page-actions">
            <Button icon={<FileExcelOutlined />} onClick={exportExcel}>
              {t('export_excel')}
            </Button>
            {isOpen && (
              <Popconfirm title={t('close_stocktake_confirm')} okText={t('close_stocktake')} cancelText={t('cancel')} onConfirm={close}>
                <Button danger icon={<StopOutlined />}>
                  {t('close_stocktake')}
                </Button>
              </Popconfirm>
            )}
            <Popconfirm title={t('delete_stocktake_confirm')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={remove}>
              <Button danger icon={<DeleteOutlined />}>
                {t('delete')}
              </Button>
            </Popconfirm>
          </div>
        </div>
      )}
      {!phone && (
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          {stats.map(([key, value, color]) => (
            <Col xs={12} md={8} lg={4} key={key} flex="1">
              <div className="stat-tile">
                <span className="stat-label">{t(key)}</span>
                <span className="stat-value" style={color ? { color } : undefined}>
                  {value}
                </span>
              </div>
            </Col>
          ))}
        </Row>
      )}
      <Progress percent={c.expected ? Math.round((c.found / c.expected) * 100) : 0} style={{ marginBottom: 16 }} />

      {isOpen ? (
        <Card style={{ marginBottom: 16 }}>
          <div className="scan-bar">
            <Input
              ref={input}
              size="large"
              dir="ltr"
              autoFocus
              value={code}
              disabled={busy}
              placeholder={t('scan_placeholder')}
              onChange={(e) => setCode(e.target.value)}
              onPressEnter={() => submit()}
            />
            <Button size="large" type="primary" onClick={() => submit()} loading={busy}>
              {t('scan_open')}
            </Button>
            <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
            <Button size="large" icon={<CameraOutlined />} onClick={() => photo.current?.click()}>
              {t('scan_photo')}
            </Button>
            <Button size="large" icon={<ScanOutlined />} onClick={() => setScanning(true)}>
              {t('stocktake_camera')}
            </Button>
          </div>
          <CodeScanner open={scanning} onClose={() => setScanning(false)} onCode={onCameraCode} title={report.stocktake.name} />
          {last && (
            <Alert
              className="scan-result"
              type={RESULT_TYPE[last.status]}
              showIcon
              title={
                <span>
                  <b className="serial">{last.scan.serial_number}</b> — {resultText(last)}
                </span>
              }
              description={last.scan.equipment?.display_name}
            />
          )}
        </Card>
      ) : (
        <Alert type="info" showIcon title={t('stocktake_closed')} style={{ marginBottom: 16 }} />
      )}

      <Tabs
        items={[
          { key: 'missing', label: `${t('missing')} (${report.missing.length})`, children: <Table rowKey="id" size="small" dataSource={report.missing} columns={listColumns(false)} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 'max-content' }} /> },
          { key: 'found', label: `${t('found')} (${report.found.length})`, children: <Table rowKey="scan_id" size="small" dataSource={report.found} columns={listColumns(true)} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 'max-content' }} /> },
          { key: 'unexpected', label: `${t('unexpected')} (${report.unexpected.length})`, children: <Table rowKey="scan_id" size="small" dataSource={report.unexpected} columns={listColumns(true)} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 'max-content' }} /> },
          { key: 'unknown', label: `${t('unknown')} (${report.unknown.length})`, children: <Table rowKey="scan_id" size="small" dataSource={report.unknown} columns={listColumns(true)} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 'max-content' }} /> },
        ]}
      />
    </div>
  )
}
