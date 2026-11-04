import { useEffect, useRef, useState } from 'react'
import { App, Empty, Modal, Select, Tag, Typography } from 'antd'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'

/**
 * Search and choose existing equipment (used by boxes and groups).
 * `exclude`: ids already there (shown, but not selectable). `params`: extra list filters (e.g. type: 'main').
 * `onSubmit(ids)` does the change; the modal shows its errors.
 */
export default function EquipmentPicker({ open, title, hint, exclude = [], excludedLabel, params, onClose, onSubmit }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [options, setOptions] = useState([])
  const [selected, setSelected] = useState([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const timer = useRef(null)
  const excluded = new Set(exclude)

  const search = (q) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const { data } = await api.get('/equipment', { params: { q, per_page: 30, ...params } })
        setOptions(
          data.data.map((e) => ({
            value: e.id,
            disabled: excluded.has(e.id),
            label: (
              <span>
                {e.display_name && `${e.display_name} · `}
                <span className="serial">{e.serial_number}</span>
                {e.parent && <Typography.Text type="secondary"> ↳ {e.parent.serial_number}</Typography.Text>}
                {e.accessories_count > 0 && <Typography.Text type="secondary"> (+{t('n_accessories', { n: e.accessories_count })})</Typography.Text>}
                {excluded.has(e.id) && <Tag style={{ marginInlineStart: 6 }}>{excludedLabel}</Tag>}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload each time it opens
  }, [open])

  const submit = async () => {
    if (!selected.length) return
    setSaving(true)
    try {
      await onSubmit(selected.map((s) => s.value))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      okText={t('add')}
      cancelText={t('cancel')}
      onOk={submit}
      okButtonProps={{ disabled: !selected.length }}
      onCancel={onClose}
      confirmLoading={saving}
      width={640}
      destroyOnHidden
    >
      {hint && <Typography.Paragraph type="secondary">{hint}</Typography.Paragraph>}
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
