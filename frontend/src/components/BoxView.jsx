import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, Button, Card, Col, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Tag, Typography } from 'antd'
import { AppstoreAddOutlined, AppstoreOutlined, ClusterOutlined, DashboardOutlined, DeleteOutlined, FileTextOutlined, DownOutlined, MinusCircleOutlined, EditOutlined, InboxOutlined, PictureOutlined, PlusOutlined, PrinterOutlined } from '@ant-design/icons'
import api, { boxUrl, errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { qrPointsToLocalhost, useSettings } from '../settings'
import QrCode from './QrCode'
import EquipmentForm from './EquipmentForm'
import EquipmentPicker from './EquipmentPicker'
import GroupSelect from './GroupSelect'

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

/** Put every unit of one or more groups (with their accessories) in the box. */
function AddGroupsModal({ open, box, onClose, onAdded }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [groupIds, setGroupIds] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setGroupIds([])
  }, [open])

  const add = async () => {
    setSaving(true)
    try {
      const { data } = await api.post(`/boxes/${box.id}/equipment`, { group_ids: groupIds })
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
      title={t('add_group_to_box')}
      okText={t('add')}
      cancelText={t('cancel')}
      onOk={add}
      okButtonProps={{ disabled: !groupIds?.length }}
      onCancel={onClose}
      confirmLoading={saving}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">{t('add_group_to_box_hint')}</Typography.Paragraph>
      <GroupSelect mode="multiple" size="large" value={groupIds} onChange={(v) => setGroupIds(v || [])} placeholder={t('groups')} style={{ width: '100%' }} />
    </Modal>
  )
}

/** The box's contents split by group, in the order they come (main equipment followed by its accessories). */
function bySection(items) {
  const sections = new Map()
  for (const eq of items) {
    const key = eq.group ? eq.group.id : 'none'
    if (!sections.has(key)) sections.set(key, { group: eq.group, items: [] })
    sections.get(key).items.push(eq)
  }
  // Equipment without a group comes last
  return [...sections.values()].sort((a, b) => (a.group ? 0 : 1) - (b.group ? 0 : 1))
}

/**
 * Box page, shared by the dashboard (/boxes/:id) and the phone scan page (/box/:number).
 * `printMode`: the same page as a sheet to print and stick on the box (no buttons, no side QR card).
 */
export default function BoxView({ box, onChange, onDeleted, mobile, printMode }) {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { settings } = useSettings()
  const { message, modal } = App.useApp()
  const [editing, setEditing] = useState(false)
  // "Take out" mode: the remove buttons only show while taking things out, so the list stays clean
  const [managing, setManaging] = useState(false)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [addingGroups, setAddingGroups] = useState(false)
  const url = boxUrl(settings, box.number)
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

  // A whole group out of the box (its units bring their accessories with them)
  const takeOutGroup = async (section) => {
    if (!(await requirePin())) return
    try {
      const { data } = await api.post(`/boxes/${box.id}/equipment/remove`, { ids: section.items.filter((e) => !e.parent).map((e) => e.id) })
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

  // Everything you can do with the box, in one menu (it used to take a lot of room on phones)
  const menuItems = [
    { key: 'new', icon: <PlusOutlined />, label: t('new_equipment_in_box') },
    { key: 'pick', icon: <AppstoreAddOutlined />, label: t('choose_existing') },
    { key: 'group', icon: <ClusterOutlined />, label: t('add_group_to_box') },
    ...(box.equipment.length ? [{ key: 'manage', icon: <MinusCircleOutlined />, label: t('take_out_items') }] : []),
    { type: 'divider' },
    { key: 'edit', icon: <EditOutlined />, label: t('edit_box') },
    { key: 'report', icon: <FileTextOutlined />, label: t('print_report') },
    ...(mobile ? [] : [{ key: 'print', icon: <PrinterOutlined />, label: t('print_label') }]),
    { type: 'divider' },
    { key: 'delete', icon: <DeleteOutlined />, label: t('delete_box'), danger: true },
  ]

  const onMenu = async ({ key }) => {
    if (key === 'print') return window.open(`/boxes/labels?ids=${box.id}`, '_blank')
    if (key === 'report') return window.open(`/boxes/${box.id}/report`, '_blank')
    if (key === 'delete') {
      return modal.confirm({
        title: t('delete_box_confirm'),
        okText: t('delete'),
        okButtonProps: { danger: true },
        cancelText: t('cancel'),
        onOk: remove,
      })
    }
    if (!(await requirePin())) return
    const open = { new: setCreating, pick: setPicking, group: setAddingGroups, manage: setManaging, edit: setEditing }[key]
    open?.(true)
  }

  const actions = (
    // Kept inside the screen even at its corner
    <Dropdown menu={{ items: menuItems, onClick: onMenu }} trigger={['click']} placement="bottom">
      <Button type="primary">
        {t('actions')} <DownOutlined />
      </Button>
    </Dropdown>
  )

  // The weight matters most, so it is the first and largest figure; tapping it edits the box
  const stats = (
    <div className="box-stats">
      <button
        type="button"
        className="box-stat box-stat-weight"
        onClick={() => !printMode && onMenu({ key: 'edit' })}
        title={printMode ? undefined : t('edit_box')}
      >
        <span className="box-stat-label">
          {!printMode && <DashboardOutlined />} {t('weight')}
        </span>
        {box.weight != null ? (
          <span className="box-stat-value">
            {Number(box.weight).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            <small>{t('kg')}</small>
          </span>
        ) : (
          <span className="box-stat-value box-stat-empty">{t('weight_not_set')}</span>
        )}
      </button>
      <div className="box-stat">
        <span className="box-stat-label">
          {!printMode && <AppstoreOutlined />} {t('box_contents')}
        </span>
        <span className="box-stat-value">
          {box.equipment.length}
          <small>{t('items_word')}</small>
        </span>
      </div>
    </div>
  )

  const sections = bySection(box.equipment)
  // Headings only help when something in the box belongs to a group (and are left off the printed sheet)
  const showSections = !printMode && sections.some((sec) => sec.group)

  return (
    <div className="page">
      {printMode ? (
        <>
          {/* Printed sheet: the box number large on top; below it the figures, and the QR at the left corner with the box name */}
          <div className="page-head box-head box-head-print">
            <Typography.Title level={2} style={{ margin: 0 }}>
              {t('box')} {box.number}
            </Typography.Title>
          </div>
          <div className="box-print-top">
            {stats}
            <div className="box-print-qr">
              <QrCode value={url} size={1} style={{ width: '42mm', height: '42mm' }} />
              {box.name && <div className="box-print-name">{box.name}</div>}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Title and the one Actions button on the same line (the button sits at the end: left in Arabic) */}
          <div className="page-head box-head">
            <div>
              <Typography.Title level={mobile ? 2 : 3} style={{ margin: 0 }}>
                <InboxOutlined className="box-title-icon" /> {t('box')} {box.number}
              </Typography.Title>
              {box.name && <div className="box-subtitle">{box.name}</div>}
            </div>
            {actions}
          </div>
          {stats}
        </>
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={printMode ? 24 : 16}>
          {/* No frame around the contents on the printed sheet */}
          <Card title={`${t('box_contents')} (${box.equipment.length})`} variant={printMode ? 'borderless' : undefined} className={printMode ? 'box-contents-print' : undefined}>
            {managing && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                title={t('take_out_items_hint')}
                action={
                  <Button size="small" type="primary" onClick={() => setManaging(false)}>
                    {t('done')}
                  </Button>
                }
              />
            )}
            {box.equipment.length ? (
              <div className="box-sections">
                {sections.map((section) => (
                  <div key={section.group ? section.group.id : 'none'} className="box-section">
                    {showSections && (
                      <div className="box-section-head">
                        <ClusterOutlined />
                        <span className="box-section-name">{section.group ? section.group.name : t('no_group')}</span>
                        <Tag>{t('n_items', { n: section.items.length })}</Tag>
                        <div style={{ flex: 1 }} />
                        {managing && section.group && (
                          <Popconfirm
                            title={t('take_out_group_confirm', { name: section.group.name })}
                            okText={t('take_out')}
                            cancelText={t('cancel')}
                            onConfirm={() => takeOutGroup(section)}
                          >
                            <Button size="small" danger icon={<MinusCircleOutlined />}>
                              {t('take_out_group')}
                            </Button>
                          </Popconfirm>
                        )}
                      </div>
                    )}
                    <div className="box-items">
                      {section.items.map((eq) => (
                        <div key={eq.id} className={`box-item${eq.parent ? ' box-item-accessory' : ''}`}>
                          <Link to={linkTo(eq)} className="box-item-link">
                            {eq.photo_url ? (
                              <img src={eq.photo_url} alt="" className="box-item-photo" loading={printMode ? 'eager' : 'lazy'} />
                            ) : (
                              <span className="box-item-photo box-item-nophoto">{!printMode && <PictureOutlined />}</span>
                            )}
                            <span className="box-item-text">
                              <span className="box-item-name">{eq.display_name || eq.serial_number}</span>
                              {/* A few details instead of the serial number (it is on the equipment's own page) */}
                              {eq.summary?.length > 0 && (
                                <span className="box-item-details">
                                  {eq.summary.map((f, i) => (
                                    <span key={i}>
                                      <span className="box-item-key">{f.key}:</span> {f.value}
                                    </span>
                                  ))}
                                </span>
                              )}
                              {eq.parent && (
                                <span className="box-item-details">
                                  ↳ {t('accessory_of')} {eq.parent.display_name || eq.parent.serial_number}
                                </span>
                              )}
                            </span>
                          </Link>
                          {managing && (
                            <Popconfirm
                              title={eq.parent ? t('take_out_confirm') : t('take_out_confirm_main')}
                              okText={t('take_out')}
                              cancelText={t('cancel')}
                              onConfirm={() => takeOut(eq)}
                            >
                              <Button type="text" danger icon={<MinusCircleOutlined />} title={t('take_out')} />
                            </Popconfirm>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('box_empty')} />
            )}
          </Card>
        </Col>
        {!mobile && !printMode && (
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
        title={t('choose_existing')}
        hint={t('choose_existing_hint')}
        exclude={box.equipment.map((e) => e.id)}
        excludedLabel={t('already_in_box')}
        onClose={() => setPicking(false)}
        onSubmit={async (ids) => {
          const { data } = await api.post(`/boxes/${box.id}/equipment`, { ids })
          message.success(t('added_to_box', { n: data.added }))
          setPicking(false)
          onChange(data.box)
        }}
      />
      <AddGroupsModal
        open={addingGroups}
        box={box}
        onClose={() => setAddingGroups(false)}
        onAdded={(data) => {
          setAddingGroups(false)
          onChange(data)
        }}
      />
      <EquipmentForm open={creating} onClose={() => setCreating(false)} onSaved={created} />
    </div>
  )
}
