import { useEffect, useState } from 'react'
import { App, AutoComplete, Form, Input, Modal, Segmented, Typography } from 'antd'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'

/** Set / remove one field, or set the category, on many equipment at once. */
export default function BulkEditModal({ ids, open, onClose, onDone }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [action, setAction] = useState('set')
  const [keys, setKeys] = useState([])
  const [categories, setCategories] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    api.get('/equipment/keys').then(({ data }) => setKeys(data))
    api.get('/equipment/categories').then(({ data }) => setCategories(data))
  }, [open])

  const save = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const { data } = await api.post('/equipment/bulk-update', { ids, action, ...v })
      message.success(t('bulk_done', { n: data.updated }))
      form.resetFields()
      onDone()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} title={t('bulk_edit', { n: ids.length })} okText={t('save')} cancelText={t('cancel')} onOk={save} onCancel={onClose} confirmLoading={saving} forceRender>
      <Segmented block value={action} onChange={setAction} options={['set', 'remove', 'category'].map((a) => ({ value: a, label: t(`bulk_${a}`) }))} style={{ marginBottom: 16 }} />
      <Form form={form} layout="vertical">
        {action !== 'category' ? (
          <>
            <Form.Item name="key" label={t('key')} rules={[{ required: true, whitespace: true, message: t('key') }]}>
              <AutoComplete options={keys.map((k) => ({ value: k }))} filterOption />
            </Form.Item>
            {action === 'set' && (
              <Form.Item name="value" label={t('value')}>
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 5 }} />
              </Form.Item>
            )}
            <Typography.Text type="secondary">{t(action === 'set' ? 'bulk_help_set' : 'bulk_help_remove')}</Typography.Text>
          </>
        ) : (
          <Form.Item name="category" label={t('category')}>
            <AutoComplete options={categories.map((c) => ({ value: c }))} filterOption allowClear />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}
