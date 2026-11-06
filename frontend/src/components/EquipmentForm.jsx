import { useEffect, useState } from 'react'
import { Alert, App, AutoComplete, Form, Input, InputNumber, Modal } from 'antd'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import FieldEditor, { cleanFields } from './FieldEditor'
import GroupSelect from './GroupSelect'

/**
 * Create (no `equipment`) or edit an equipment in a modal.
 * Pass `parent` to create an accessory of that equipment, or `group` to create one in that group.
 */
export default function EquipmentForm({ open, equipment, parent, group, onClose, onSaved }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [fields, setFields] = useState([])
  const [categories, setCategories] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      serial_number: equipment?.serial_number || '',
      name: equipment?.name || '',
      row_no: equipment?.row_no ?? null,
      category: equipment?.category || '',
      group_id: equipment?.group?.id ?? group?.id ?? null,
    })
    setFields(equipment?.fields?.length ? equipment.fields : [{ key: '', value: '' }])
    if (equipment) api.get('/equipment/categories').then(({ data }) => setCategories(data))
  }, [open, equipment, group, form])

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const payload = { ...values, row_no: values.row_no ?? null, name: values.name || null, category: values.category || null, fields: cleanFields(fields) }
      if (!equipment && parent) payload.parent_id = parent.id
      if ('group_id' in values) payload.group_id = values.group_id ?? null
      const { data } = equipment
        ? await api.put(`/equipment/${equipment.id}`, payload)
        : await api.post('/equipment', payload)
      message.success(t('saved'))
      onSaved(data)
    } catch (e) {
      const key = errorKey(e)
      if (key === 'serial_taken') form.setFields([{ name: 'serial_number', errors: [t(key)] }])
      else message.error(t(key || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={equipment ? t('edit_equipment') : parent ? t('add_accessory') : t('add_equipment')}
      okText={t('save')}
      cancelText={t('cancel')}
      onOk={save}
      onCancel={onClose}
      confirmLoading={saving}
      width={760}
      destroyOnHidden
      // Keep the form mounted so it can be filled the moment the modal opens
      forceRender
      mask={{ closable: false }}
    >
      {parent && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} title={`${t('accessory_of')}: ${[parent.display_name, parent.serial_number].filter(Boolean).join(' · ')}`} />
      )}
      <Form form={form} layout="vertical">
        <div className="form-grid">
          <Form.Item name="serial_number" label={t('serial_number')} rules={[{ required: !parent && !equipment?.parent, whitespace: true, message: t('serial_number') }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label={t('name_field')}>
            <Input />
          </Form.Item>
          <Form.Item name="row_no" label={t('row_no_long')}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          {/* Accessories stay with their main equipment and have no group */}
          {!parent && !equipment?.parent && (
            <Form.Item name="group_id" label={t('group')}>
              <GroupSelect />
            </Form.Item>
          )}
          {/* Category is only shown when editing; new accessories take their main equipment's category */}
          {equipment && (
            <Form.Item name="category" label={t('category')}>
              <AutoComplete options={categories.map((c) => ({ value: c }))} allowClear filterOption />
            </Form.Item>
          )}
        </div>
      </Form>
      <FieldEditor value={fields} onChange={setFields} />
    </Modal>
  )
}
