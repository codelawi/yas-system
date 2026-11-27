import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { App, Button, Card, Col, Empty, Input, InputNumber, Popconfirm, Result, Row, Segmented, Space, Spin, Switch, Table, Tag, Typography } from 'antd'
import { ArrowRightOutlined, CopyOutlined, DeleteOutlined, FileDoneOutlined, PlusOutlined, SaveOutlined, StarOutlined, UnlockOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { usePhone } from '../nav'
import { Fab, PhoneHeader, PhoneList, PhoneRow, PhoneSkeleton } from '../components/PhoneUI'
import VoucherPaper, { BUILT_IN_FIELDS } from '../components/VoucherPaper'
import VoucherTemplateEditor from '../components/VoucherTemplateEditor'

/*
 * Voucher templates: how issue vouchers look on A5 paper. A header and a footer edited like Word
 * (repeated on every page), the table of equipment between them, and the template's own fields,
 * typed on each voucher (signatories...). One template is the default.
 */

function NeedPin() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  return (
    <div className="page">
      <Result
        icon={<FileDoneOutlined />}
        title={t('vouchers_locked')}
        extra={
          <Button type="primary" size="large" icon={<UnlockOutlined />} onClick={requirePin}>
            {t('unlock')}
          </Button>
        }
      />
    </div>
  )
}

/* ---------- The list */

export function VoucherTemplatesPage() {
  const { t } = useLang()
  const { user } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const phone = usePhone()
  const [list, setList] = useState(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => api.get('/voucher-templates').then(({ data }) => setList(data)), [])
  useEffect(() => {
    if (user) load()
  }, [user, load])
  if (!user) return <NeedPin />

  const create = async (from) => {
    setCreating(true)
    try {
      const { data } = await api.post('/voucher-templates', { from })
      navigate(`/vouchers/templates/${data.id}`)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
      setCreating(false)
    }
  }
  const makeDefault = async (template) => {
    try {
      await api.post(`/voucher-templates/${template.id}/default`)
      message.success(t('vt_now_default', { name: template.name }))
      load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }
  const remove = async (template) => {
    try {
      await api.delete(`/voucher-templates/${template.id}`)
      message.success(t('deleted'))
      load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const sub = (v) => [t('vt_used_n', { n: v.vouchers_count }), dayjs(v.updated_at).format('YYYY-MM-DD')].join(' · ')

  if (phone)
    return (
      <div className="page">
        <PhoneHeader title={t('vt_title')} subtitle={t('vt_hint')} />
        {!list ? (
          <PhoneSkeleton rows={2} />
        ) : (
          <PhoneList>
            {list.map((v) => (
              <PhoneRow key={v.id} to={`/vouchers/templates/${v.id}`} icon={<FileDoneOutlined />} tone={v.is_default ? 'blue' : 'slate'} title={v.name} subtitle={sub(v)} end={v.is_default ? <Tag color="blue">{t('vt_default')}</Tag> : null} />
            ))}
          </PhoneList>
        )}
        <Fab icon={<PlusOutlined />} label={t('vt_new')} onClick={() => create()} loading={creating} />
      </div>
    )

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            <FileDoneOutlined /> {t('vt_title')}
          </Typography.Title>
          <Typography.Text type="secondary">{t('vt_hint')}</Typography.Text>
        </div>
        <div className="page-actions">
          <Button icon={<ArrowRightOutlined />} onClick={() => navigate('/vouchers')}>
            {t('vouchers')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => create()} loading={creating}>
            {t('vt_new')}
          </Button>
        </div>
      </div>
      <Table
        rowKey="id"
        loading={!list}
        dataSource={list || []}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        columns={[
          {
            title: t('vt_name'),
            key: 'name',
            render: (_, v) => (
              <Space>
                <Link to={`/vouchers/templates/${v.id}`}>
                  <b>{v.name}</b>
                </Link>
                {v.is_default && <Tag color="blue">{t('vt_default')}</Tag>}
              </Space>
            ),
          },
          { title: t('vt_used'), dataIndex: 'vouchers_count', align: 'center' },
          { title: t('vt_updated'), key: 'updated', render: (_, v) => dayjs(v.updated_at).format('YYYY-MM-DD HH:mm') },
          {
            key: 'actions',
            align: 'end',
            render: (_, v) => (
              <Space wrap>
                {!v.is_default && (
                  <Button size="small" icon={<StarOutlined />} onClick={() => makeDefault(v)}>
                    {t('vt_make_default')}
                  </Button>
                )}
                <Button size="small" icon={<CopyOutlined />} onClick={() => create(v.id)}>
                  {t('vt_copy')}
                </Button>
                {list.length > 1 && (
                  <Popconfirm title={t('vt_delete_confirm')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={() => remove(v)}>
                    <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('delete')} />
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
    </div>
  )
}

/* ---------- One template */

const sampleRows = (long) => {
  const rows = [
    { key: 's1', code: 'ان ٤١٢٣٤١دم', name: 'جهاز تنفس كامل للاماكن الضيقة', accessory: false, quantity: 2, quantity_words: 'اثنان فقط' },
    { key: 's2', code: null, name: 'كشاف يدوي', accessory: false, quantity: 1, quantity_words: 'واحد فقط' },
    { key: 's3', code: null, name: 'شاحن للكشاف', accessory: true, quantity: 1, quantity_words: 'واحد فقط' },
  ]
  if (!long) return rows
  return [...rows, ...Array.from({ length: 27 }, (_, i) => ({ key: `l${i}`, code: `ان ${5000 + i}دم`, name: `صنف تجريبي ${i + 4}`, accessory: false, quantity: 1, quantity_words: 'واحد فقط' }))]
}

const newKey = () => `field_${Math.random().toString(36).slice(2, 8)}`

export function VoucherTemplatePage() {
  const { id } = useParams()
  const { t } = useLang()
  const { user } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const phone = usePhone()
  const [template, setTemplate] = useState(null)
  const [missing, setMissing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [long, setLong] = useState(false)
  const [pages, setPages] = useState(1)

  useEffect(() => {
    if (!user) return
    api
      .get(`/voucher-templates/${id}`)
      .then(({ data }) => setTemplate(data))
      .catch((e) => e.response?.status === 404 && setMissing(true))
  }, [user, id])

  // Leaving with changes not saved: the browser asks
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (e) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const labels = useMemo(() => {
    if (!template) return {}
    const map = Object.fromEntries(BUILT_IN_FIELDS.map((f) => [f, t(`vt_field_${f}`)]))
    for (const f of template.fields) map[`f:${f.key}`] = f.label
    return map
  }, [template, t])

  if (!user) return <NeedPin />
  if (missing) return <Result status="404" title={t('vt_not_found')} extra={<Button onClick={() => navigate('/vouchers/templates')}>{t('vt_title')}</Button>} />
  if (!template) return <Spin size="large" className="page-spin" />

  const change = (patch) => {
    setTemplate((tpl) => ({ ...tpl, ...(typeof patch === 'function' ? patch(tpl) : patch) }))
    setDirty(true)
  }
  const setColumn = (key, patch) => change((tpl) => ({ item_table: { ...tpl.item_table, columns: tpl.item_table.columns.map((c) => (c.key === key ? { ...c, ...patch } : c)) } }))
  const setTable = (patch) => change((tpl) => ({ item_table: { ...tpl.item_table, ...patch } }))
  const setStyle = (patch) => change((tpl) => ({ style: { ...tpl.style, ...patch } }))
  const setFields = (fn) => change((tpl) => ({ fields: fn(tpl.fields) }))

  const save = async () => {
    setSaving(true)
    try {
      const { data } = await api.put(`/voucher-templates/${id}`, {
        name: template.name,
        header: template.header,
        footer: template.footer,
        item_table: template.item_table,
        fields: template.fields,
        style: template.style,
      })
      setTemplate(data)
      setDirty(false)
      message.success(t('saved'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const sampleVoucher = {
    number: 125,
    recipient: 'فورد اسود (24442)',
    issued_at: null,
    fields: Object.fromEntries(template.fields.map((f) => [f.key, f.label])),
  }

  const saveButton = (
    <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={save}>
      {t('save')}
    </Button>
  )

  const general = (
    <Card size="small" title={t('vt_name')} className="vt-card">
      <Input value={template.name} maxLength={120} onChange={(e) => change({ name: e.target.value })} />
    </Card>
  )

  const header = (
    <Card size="small" title={t('vt_header')} className="vt-card" extra={<Typography.Text type="secondary">{t('vt_every_page')}</Typography.Text>}>
      <VoucherTemplateEditor key={`h${template.id}`} value={template.header} onChange={(html) => change({ header: html })} labels={labels} style={template.style} />
    </Card>
  )

  const columns = (
    <Card size="small" title={t('vt_table')} className="vt-card">
      <div className="vt-columns">
        {template.item_table.columns.map((c) => (
          <div key={c.key} className={`vt-column${c.show ? '' : ' is-off'}`}>
            <Switch size="small" checked={c.show} onChange={(show) => setColumn(c.key, { show })} aria-label={t(`vt_col_${c.key}`)} />
            <span className="vt-column-what">{t(`vt_col_${c.key}`)}</span>
            <Input size="small" value={c.title} placeholder={t('vt_col_title')} maxLength={100} onChange={(e) => setColumn(c.key, { title: e.target.value })} />
            <InputNumber size="small" min={3} max={90} value={c.width} suffix="%" onChange={(width) => width && setColumn(c.key, { width })} aria-label={t('vt_col_width')} />
          </div>
        ))}
      </div>
      <div className="vt-row">
        <label>{t('vt_quantity_group')}</label>
        <Input size="small" value={template.item_table.quantity_group} placeholder={t('vt_none')} maxLength={100} onChange={(e) => setTable({ quantity_group: e.target.value })} />
      </div>
      <div className="vt-row">
        <label>{t('vt_no_code')}</label>
        <Input size="small" value={template.item_table.no_code} maxLength={50} onChange={(e) => setTable({ no_code: e.target.value })} />
      </div>
    </Card>
  )

  const footer = (
    <Card size="small" title={t('vt_footer')} className="vt-card" extra={<Typography.Text type="secondary">{t('vt_every_page')}</Typography.Text>}>
      <VoucherTemplateEditor key={`f${template.id}`} value={template.footer} onChange={(html) => change({ footer: html })} labels={labels} style={template.style} />
    </Card>
  )

  const fields = (
    <Card size="small" title={t('vt_fields')} className="vt-card">
      <Typography.Paragraph type="secondary" className="vt-hint">
        {t('vt_fields_hint')}
      </Typography.Paragraph>
      {template.fields.map((f) => (
        <div key={f.key} className="vt-field-row">
          <Input size="small" value={f.label} maxLength={100} onChange={(e) => setFields((list) => list.map((x) => (x.key === f.key ? { ...x, label: e.target.value } : x)))} />
          <Popconfirm title={t('vt_field_delete')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={() => setFields((list) => list.filter((x) => x.key !== f.key))}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('delete')} />
          </Popconfirm>
        </div>
      ))}
      <Button size="small" icon={<PlusOutlined />} disabled={template.fields.length >= 20} onClick={() => setFields((list) => [...list, { key: newKey(), label: t('vt_new_field', { n: list.length + 1 }) }])}>
        {t('vt_add_field')}
      </Button>
    </Card>
  )

  const style = (
    <Card size="small" title={t('vt_style')} className="vt-card">
      <div className="vt-style">
        <label>
          {t('vt_font_size')}
          <InputNumber size="small" min={6} max={24} value={template.style.font_size} suffix="pt" onChange={(v) => v && setStyle({ font_size: v })} />
        </label>
        <label>
          {t('vt_row_height')}
          <InputNumber size="small" min={4} max={30} value={template.style.row_height} suffix="mm" onChange={(v) => v && setStyle({ row_height: v })} />
        </label>
        <label>
          {t('vt_margin')}
          <InputNumber size="small" min={0} max={30} value={template.style.margin} suffix="mm" onChange={(v) => v !== null && setStyle({ margin: v })} />
        </label>
      </div>
    </Card>
  )

  const preview = (
    <Card
      size="small"
      title={`${t('vt_preview')} · ${t('vt_pages_n', { n: pages })}`}
      className="vt-card vt-preview"
      extra={<Segmented size="small" value={long ? 'long' : 'short'} onChange={(v) => setLong(v === 'long')} options={[{ value: 'short', label: t('vt_sample_short') }, { value: 'long', label: t('vt_sample_long') }]} />}
    >
      <VoucherPaper layout={template} voucher={sampleVoucher} rows={sampleRows(long)} onPages={setPages} />
    </Card>
  )

  const tags = (
    <span className="phone-tags">
      {template.is_default && <Tag color="blue">{t('vt_default')}</Tag>}
      {dirty && <Tag color="gold">{t('vt_unsaved')}</Tag>}
    </span>
  )

  if (phone)
    return (
      <div className="page vt-page">
        <PhoneHeader title={template.name || t('vt_title')} subtitle={tags} />
        {general}
        {header}
        {columns}
        {footer}
        {fields}
        {style}
        {preview}
        <div className="vt-phone-save">{saveButton}</div>
      </div>
    )

  return (
    <div className="page vt-page">
      <div className="page-head">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            <FileDoneOutlined /> {template.name || t('vt_title')}
          </Typography.Title>
          <div style={{ marginTop: 4 }}>{tags}</div>
        </div>
        <div className="page-actions">
          <Button icon={<ArrowRightOutlined />} onClick={() => navigate('/vouchers/templates')}>
            {t('vt_title')}
          </Button>
          {saveButton}
        </div>
      </div>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          {general}
          {header}
          {columns}
          {footer}
          {fields}
          {style}
        </Col>
        <Col xs={24} xl={10}>
          <div className="vt-sticky">{preview}</div>
        </Col>
      </Row>
    </div>
  )
}
