import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, AutoComplete, Button, Card, Form, Input, Segmented, Space, Table, Tag, Typography } from 'antd'
import { BgColorsOutlined, LockOutlined, PrinterOutlined, QrcodeOutlined, SaveOutlined, WifiOutlined } from '@ant-design/icons'
import api, { equipmentUrl, errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { useSettings } from '../settings'
import { useQrAddressSaver } from '../qrAddress'
import FieldFilter, { filterLabel } from '../components/FieldFilter'
import LabelDesigner from '../components/LabelDesigner'
import { templateFrom } from '../labelTemplate'

const STATUS_TYPE = { ok: 'success', not_set: 'warning', localhost: 'warning', mismatch: 'error' }
/** Upper limit for one print job (keeps the print URL and the browser happy) */
const MAX_LABELS = 500

/** Shown in the designer when there is no equipment yet */
const SAMPLE = {
  serial_number: 'PMP-7701',
  display_name: 'مضخة يدوية',
  row_no: 1,
  parent_serial: 'LKS-2018-001',
  category: 'LUKAS',
  fields: [{ key: 'المكان', value: 'المستودع الرئيسي' }],
}

export default function QrPage() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { settings, setSettings } = useSettings()
  const { message } = App.useApp()
  const [addressForm] = Form.useForm()
  const [status, setStatus] = useState(null)
  const [savingAddress, setSavingAddress] = useState(false)
  const [savingDesign, setSavingDesign] = useState(false)
  const [template, setTemplate] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [sample, setSample] = useState(SAMPLE)
  const [sampleSearch, setSampleSearch] = useState('')
  const [sampleOptions, setSampleOptions] = useState([])
  const [company, setCompany] = useState('')

  const baseUrlDraft = Form.useWatch('base_url', addressForm)

  const loadStatus = useCallback(() => api.get('/network').then(({ data }) => setStatus(data.base_url_status)), [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (!settings.label_width_mm) return
    addressForm.setFieldsValue({ base_url: settings.base_url })
    setCompany(settings.company_name || '')
    if (!dirty) setTemplate(templateFrom(settings))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset the design when settings load, not on every edit
  }, [settings, addressForm])

  // Preview the design with a real equipment (the first one, until another is picked)
  const loadSample = useCallback((id) => api.get('/equipment/labels', { params: { ids: [id] } }).then(({ data }) => data[0] && setSample(data[0])), [])
  useEffect(() => {
    api.get('/equipment', { params: { per_page: 1, type: 'main' } }).then(({ data }) => data.data[0] && loadSample(data.data[0].id))
  }, [loadSample])
  useEffect(() => {
    const timer = setTimeout(() => {
      api.get('/equipment', { params: { q: sampleSearch || undefined, per_page: 10 } }).then(({ data }) =>
        setSampleOptions(data.data.map((e) => ({ value: String(e.id), label: `${e.serial_number}${e.display_name ? ` · ${e.display_name}` : ''}` }))),
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [sampleSearch])

  /** Saving needs an admin PIN */
  const asAdmin = async () => {
    const user = await requirePin()
    if (!user) return false
    if (user.role !== 'admin') {
      message.error(t('Admins only.'))
      return false
    }
    return true
  }

  const saveQrAddress = useQrAddressSaver()
  const saveAddress = async () => {
    const { base_url } = await addressForm.validateFields()
    if (!(await asAdmin())) return
    setSavingAddress(true)
    const url = (base_url || '').replace(/\/+$/, '')
    const data = await saveQrAddress('/settings', { base_url: url }, url, settings.base_url)
    setSavingAddress(false)
    if (data) {
      setSettings(data)
      await loadStatus()
      message.success(t('saved'))
    } else {
      addressForm.setFieldValue('base_url', settings.base_url)
    }
  }
  const printedHere = (() => {
    try {
      return JSON.parse(settings.labels_printed || '{}')[settings.base_url] || 0
    } catch {
      return 0
    }
  })()

  const saveDesign = async () => {
    if (!(await asAdmin())) return
    setSavingDesign(true)
    try {
      const { data } = await api.put('/settings', {
        label_template: JSON.stringify(template),
        label_width_mm: template.width,
        label_height_mm: template.height,
        company_name: company,
      })
      setSettings(data)
      setDirty(false)
      message.success(t('saved'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSavingDesign(false)
    }
  }

  const previewSettings = useMemo(() => ({ ...settings, company_name: company, base_url: baseUrlDraft ?? settings.base_url }), [settings, company, baseUrlDraft])

  return (
    <div className="page">
      <Typography.Title level={3}>
        <QrcodeOutlined /> {t('qr_codes')}
      </Typography.Title>

      <Card title={t('qr_address_title')} style={{ marginBottom: 16 }} extra={<Link to="/network"><WifiOutlined /> {t('qr_see_network')}</Link>}>
        {status && <Alert type={STATUS_TYPE[status]} showIcon title={t(`net_status_${status}`)} style={{ marginBottom: 16 }} />}
        <Typography.Paragraph type="secondary">{t('qr_address_help')}</Typography.Paragraph>
        {printedHere > 0 && <Alert type="info" showIcon icon={<LockOutlined />} title={t('qr_locked_info', { n: printedHere })} style={{ marginBottom: 12 }} />}
        <Form form={addressForm} layout="vertical">
          <Form.Item
            extra={
              <span>
                {t('qr_example')}: <span className="serial" style={{ fontWeight: 400 }}>{equipmentUrl(previewSettings, 'LKS-2018-001')}</span>
              </span>
            }
          >
            <Space.Compact style={{ width: '100%', maxWidth: 640 }}>
              <Form.Item name="base_url" noStyle rules={[{ pattern: /^(https?:\/\/[^\s/]+)?\/?$/i, message: 'http://192.168.1.10' }]}>
                <Input placeholder="http://repo.local" dir="ltr" />
              </Form.Item>
              <Button onClick={() => addressForm.setFieldValue('base_url', window.location.origin)}>{t('use_current')}</Button>
            </Space.Compact>
          </Form.Item>
          <Button type="primary" onClick={saveAddress} loading={savingAddress}>
            {t('save')}
          </Button>
        </Form>
      </Card>

      <Card
        title={
          <span>
            <BgColorsOutlined /> {t('label_design')}
          </span>
        }
        style={{ marginBottom: 16 }}
        extra={
          <div className="page-actions" style={{ alignItems: 'center' }}>
            {dirty && <Tag color="orange">{t('ld_unsaved')}</Tag>}
            <Button type="primary" icon={<SaveOutlined />} loading={savingDesign} disabled={!template} onClick={saveDesign}>
              {t('save')}
            </Button>
          </div>
        }
      >
        <div className="toolbar">
          <Typography.Text type="secondary">{t('ld_preview_with')}:</Typography.Text>
          <AutoComplete
            value={sampleSearch}
            options={sampleOptions}
            onSearch={setSampleSearch}
            onChange={setSampleSearch}
            onSelect={(id, option) => {
              setSampleSearch(option.label)
              loadSample(id)
            }}
            placeholder={t('search')}
            style={{ minWidth: 280 }}
            allowClear
          />
          <Typography.Text type="secondary">{t('company_name')}:</Typography.Text>
          <Input
            value={company}
            onChange={(e) => {
              setCompany(e.target.value)
              setDirty(true)
            }}
            style={{ maxWidth: 240 }}
          />
        </div>
        {template && (
          <LabelDesigner
            template={template}
            onChange={(next) => {
              setTemplate(next)
              setDirty(true)
            }}
            settings={previewSettings}
            equipment={sample}
            url={equipmentUrl(previewSettings, sample.serial_number || 'X')}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('label_print_tip')}
        </Typography.Paragraph>
      </Card>

      <PrintPicker />
    </div>
  )
}

/** Search / filter equipment and print labels for the selection or all results. */
function PrintPicker() {
  const { t } = useLang()
  const { message } = App.useApp()
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [filters, setFilters] = useState([])
  const [page, setPage] = useState(1)
  const [data, setData] = useState({ data: [], total: 0 })
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState([])
  const [collecting, setCollecting] = useState(false)

  const params = useMemo(
    () => ({ q: q || undefined, type, filters: filters.length ? JSON.stringify(filters) : undefined }),
    [q, type, filters],
  )

  useEffect(() => {
    setLoading(true)
    api
      .get('/equipment', { params: { ...params, page, per_page: 20 } })
      .then(({ data }) => setData(data))
      .finally(() => setLoading(false))
  }, [params, page])

  const openPrint = (ids) => window.open(`/labels?ids=${ids.join(',')}`, '_blank')

  const printAll = async () => {
    if (data.total > MAX_LABELS) message.warning(t('too_many_labels', { n: data.total, max: MAX_LABELS }))
    setCollecting(true)
    try {
      const ids = []
      for (let p = 1; ids.length < Math.min(data.total, MAX_LABELS); p++) {
        const { data: res } = await api.get('/equipment', { params: { ...params, page: p, per_page: 200, sort: 'serial_number', dir: 'asc' } })
        ids.push(...res.data.map((e) => e.id))
        if (p >= res.last_page) break
      }
      openPrint(ids.slice(0, MAX_LABELS))
    } finally {
      setCollecting(false)
    }
  }

  return (
    <Card
      title={
        <span>
          <PrinterOutlined /> {t('print_labels_title')}
        </span>
      }
      extra={
        <div className="page-actions">
          {selected.length > 0 && (
            <Button type="link" onClick={() => setSelected([])}>
              {t('clear_selection')}
            </Button>
          )}
          <Button disabled={!data.total} loading={collecting} onClick={printAll}>
            {t('print_all_results', { n: Math.min(data.total, MAX_LABELS) })}
          </Button>
          <Button type="primary" icon={<PrinterOutlined />} disabled={!selected.length} onClick={() => openPrint(selected)}>
            {t('print_selected', { n: selected.length })}
          </Button>
        </div>
      }
    >
      <div className="toolbar">
        <Input.Search
          allowClear
          value={search}
          placeholder={t('search')}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(v) => {
            setQ(v.trim())
            setPage(1)
          }}
          style={{ maxWidth: 360 }}
        />
        <Segmented
          value={type}
          onChange={(v) => {
            setType(v)
            setPage(1)
          }}
          options={['all', 'main', 'accessory'].map((v) => ({ value: v, label: t(`type_${v}`) }))}
        />
        <FieldFilter
          onAdd={(f) => {
            setFilters((fs) => [...fs.filter((x) => x.key !== f.key), f])
            setPage(1)
          }}
        />
        {filters.map((f) => (
          <Tag key={f.key} color="geekblue" closable onClose={() => setFilters((fs) => fs.filter((x) => x.key !== f.key))}>
            <bdi>{filterLabel(f, t)}</bdi>
          </Tag>
        ))}
      </div>
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={data.data}
        rowSelection={{ selectedRowKeys: selected, onChange: setSelected, preserveSelectedRowKeys: true }}
        pagination={{ current: page, pageSize: 20, total: data.total, showSizeChanger: false, onChange: setPage, showTotal: (n) => `${n}` }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('serial_number'),
            dataIndex: 'serial_number',
            render: (v, r) => (
              <div>
                <Link to={`/equipment/${r.id}`} className="serial">
                  {v}
                </Link>
                {r.display_name && <div className="list-name">{r.display_name}</div>}
              </div>
            ),
          },
          {
            title: '',
            key: 'kind',
            render: (_, r) =>
              r.parent ? (
                <Tag color="purple">
                  {t('accessory_of')} <span className="serial">{r.parent.serial_number}</span>
                </Tag>
              ) : r.accessories_count > 0 ? (
                <Tag>{t('accessories_n', { n: r.accessories_count })}</Tag>
              ) : null,
          },
          { title: t('category'), dataIndex: 'category', render: (v) => (v ? <Tag color="blue">{v}</Tag> : '—'), responsive: ['md'] },
        ]}
      />
    </Card>
  )
}
