import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { App, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Tag, Typography } from 'antd'
import { AppstoreAddOutlined, DeleteOutlined, EditOutlined, InboxOutlined, PictureOutlined, PlusOutlined, PrinterOutlined } from '@ant-design/icons'
import api, { boxUrl, errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { qrPointsToLocalhost, useSettings } from '../settings'
import QrCode from './QrCode'
import EquipmentForm from './EquipmentForm'

/** "12.5 كغ" */
export function formatWeight(weight, t) {
  if (weight == null || weight === '') return null
  return `${Number(weight).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${t('kg')}`
}

/** Create (no `box`) or edit a box. */
export function BoxForm({ open, box, onClose, onSaved }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) form.setFieldsValue({ number: box?.number || '', name: box?.name || '', weight: box?.weight ?? null })
  }, [open, box, form])

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const payload = { ...values, name: values.name || null, weight: values.weight ?? null }
      const { data } = box ? await api.put(`/boxes/${box.id}`, payload) : await api.post('/boxes', payload)
      message.success(t('saved'))
      onSaved(data)
    } catch (e) {
      const key = errorKey(e)
      if (key === 'box_number_taken' || key === 'box_number_invalid') form.setFields([{ name: 'number', errors: [t(key)] }])
      else message.error(t(key || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={box ? t('edit_box') : t('add_box')}
      okText={t('save')}
      cancelText={t('cancel')}
      onOk={save}
      onCancel={onClose}
      confirmLoading={saving}
      destroyOnHidden
      forceRender
      mask={{ closable: false }}
    >
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="number" label={t('box_number')} rules={[{ required: true, whitespace: true, message: t('box_number') }]}>
          <Input autoFocus />
        </Form.Item>
        <Form.Item name="name" label={t('box_name')}>
          <Input />
        </Form.Item>
        <Form.Item name="weight" label={`${t('weight')} (${t('kg')})`}>
          <InputNumber min={0} step={0.1} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** Search and choose existing equipment to put in a box. */
function EquipmentPicker({ open, box, onClose, onAdded }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [options, setOptions] = useState([])
  const [selected, setSelected] = useState([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const timer = useRef(null)
  const inBox = new Set(box.equipment.map((e) => e.id))

  const search = (q) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const { data } = await api.get('/equipment', { params: { q, per_page: 30 } })
        setOptions(
          data.data.map((e) => ({
            value: e.id,
            disabled: inBox.has(e.id),
            label: (
              <span>
                {e.display_name && `${e.display_name} · `}
                <span className="serial">{e.serial_number}</span>
                {e.parent && <Typography.Text type="secondary"> ↳ {e.parent.serial_number}</Typography.Text>}
                {e.accessories_count > 0 && <Typography.Text type="secondary"> (+{t('n_accessories', { n: e.accessories_count })})</Typography.Text>}
                {inBox.has(e.id) && <Tag style={{ marginInlineStart: 6 }}>{t('already_in_box')}</Tag>}
              </span>
            ),
          })),
        )
      } finally {
        setSearching(false)
      }
    }, 300)
  }

  useEffect(() => {
    if (!open) return
    setSelected([])
    search('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const add = async () => {
    if (!selected.length) return
    setSaving(true)
    try {
      const { data } = await api.post(`/boxes/${box.id}/equipment`, { ids: selected.map((s) => s.value) })
      message.success(t('added_to_box', { n: data.added }))
      onAdded(data.box)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={t('choose_existing')}
      okText={t('add')}
      cancelText={t('cancel')}
      onOk={add}
      okButtonProps={{ disabled: !selected.length }}
      onCancel={onClose}
      confirmLoading={saving}
      width={640}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">{t('choose_existing_hint')}</Typography.Paragraph>
      <Select
        mode="multiple"
        size="large"
        style={{ width: '100%' }}
        placeholder={t('search')}
        value={selected}
        onChange={setSelected}
        options={options}
        // Keep the chosen items' labels while the search results change
        labelInValue
        showSearch
        filterOption={false}
        onSearch={search}
        loading={searching}
        notFoundContent={searching ? null : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        autoFocus
      />
    </Modal>
  )
}

/** Box page, shared by the dashboard (/boxes/:id) and the phone scan page (/box/:number). */
export default function BoxView({ box, onChange, onDeleted, mobile }) {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { settings } = useSettings()
  const { message } = App.useApp()
  const [editing, setEditing] = useState(false)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const url = boxUrl(settings, box.number)
  const size = mobile ? 'large' : 'middle'
  const linkTo = (eq) => (mobile ? `/eq/${encodeURIComponent(eq.serial_number)}` : `/equipment/${eq.id}`)
  const withPin = (open) => async () => {
    if (await requirePin()) open(true)
  }

  const remove = async () => {
    if (!(await requirePin())) return
    try {
      await api.delete(`/boxes/${box.id}`)
      message.success(t('deleted'))
      onDeleted()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const takeOut = async (eq) => {
    if (!(await requirePin())) return
    try {
      const { data } = await api.delete(`/boxes/${box.id}/equipment/${eq.id}`)
      onChange(data)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  // A new equipment made from the box goes straight into it
  const created = async (eq) => {
    setCreating(false)
    try {
      const { data } = await api.post(`/boxes/${box.id}/equipment`, { ids: [eq.id] })
      onChange(data.box)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const addButtons = (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={withPin(setCreating)} size={size}>
        {t('new_equipment_in_box')}
      </Button>
      <Button icon={<AppstoreAddOutlined />} onClick={withPin(setPicking)} size={size}>
        {t('choose_existing')}
      </Button>
    </>
  )

  const actions = (
    <div className="page-actions">
      <Button icon={<EditOutlined />} onClick={withPin(setEditing)} size={size}>
        {t('edit')}
      </Button>
      {!mobile && (
        <Button icon={<PrinterOutlined />} onClick={() => window.open(`/boxes/labels?ids=${box.id}`, '_blank')}>
          {t('print_label')}
        </Button>
      )}
      <Popconfirm title={t('delete_box_confirm')} okText={t('delete')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={remove}>
        <Button danger icon={<DeleteOutlined />} size={size}>
          {t('delete')}
        </Button>
      </Popconfirm>
    </div>
  )

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Typography.Text type="secondary">
            <InboxOutlined /> {t('box')}
            {box.name && ` · ${box.name}`}
          </Typography.Text>
          <Typography.Title level={mobile ? 2 : 3} style={{ margin: 0 }}>
            {t('box')} {box.number}
          </Typography.Title>
          <Tag>{t('n_items', { n: box.equipment.length })}</Tag>
          {formatWeight(box.weight, t) && <Tag color="gold">{formatWeight(box.weight, t)}</Tag>}
        </div>
        {!mobile && actions}
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title={`${t('box_contents')} (${box.equipment.length})`} extra={!mobile && <div className="page-actions">{addButtons}</div>}>
            {mobile && <div className="page-actions" style={{ marginBottom: 12 }}>{addButtons}</div>}
            {box.equipment.length ? (
              <div className="box-items">
                {box.equipment.map((eq) => (
                  <div key={eq.id} className={`box-item${eq.parent ? ' box-item-accessory' : ''}`}>
                    <Link to={linkTo(eq)} className="box-item-link">
                      {eq.photo_url ? (
                        <img src={eq.photo_url} alt="" className="box-item-photo" loading="lazy" />
                      ) : (
                        <span className="box-item-photo box-item-nophoto">
                          <PictureOutlined />
                        </span>
                      )}
                      <span className="box-item-text">
                        <span className="accessory-name">{eq.display_name || eq.serial_number}</span>
                        <span className="serial">{eq.serial_number}</span>
                        {eq.parent && (
                          <Typography.Text type="secondary" className="box-item-extra">
                            ↳ {t('accessory_of')} {eq.parent.serial_number}
                          </Typography.Text>
                        )}
                      </span>
                    </Link>
                    <Popconfirm
                      title={eq.parent ? t('take_out_confirm') : t('take_out_confirm_main')}
                      okText={t('take_out')}
                      cancelText={t('cancel')}
                      onConfirm={() => takeOut(eq)}
                    >
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} title={t('take_out')} />
                    </Popconfirm>
                  </div>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('box_empty')} />
            )}
          </Card>
          {mobile && <div style={{ marginTop: 16 }}>{actions}</div>}
        </Col>
        {!mobile && (
          <Col xs={24} lg={8}>
            <Card title={t('qr_code')}>
              {qrPointsToLocalhost(settings) && <Typography.Paragraph type="warning">{t('localhost_warning')}</Typography.Paragraph>}
              <div className="qr-box">
                <QrCode value={url} size={180} />
                <Typography.Text type="secondary" copyable className="qr-url">
                  {url}
                </Typography.Text>
              </div>
            </Card>
          </Col>
        )}
      </Row>

      <BoxForm
        open={editing}
        box={box}
        onClose={() => setEditing(false)}
        onSaved={(data) => {
          setEditing(false)
          onChange(data)
        }}
      />
      <EquipmentPicker
        open={picking}
        box={box}
        onClose={() => setPicking(false)}
        onAdded={(data) => {
          setPicking(false)
          onChange(data)
        }}
      />
      <EquipmentForm open={creating} onClose={() => setCreating(false)} onSaved={created} />
    </div>
  )
}
