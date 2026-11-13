import { useEffect, useState } from 'react'
import { AutoComplete, Button, Input, Tooltip } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import api from '../api'
import { useLang } from '../i18n'

let keyCache = null

/** Edits a flexible list of { key, value } rows. */
export default function FieldEditor({ value = [], onChange }) {
  const { t } = useLang()
  const [keys, setKeys] = useState(keyCache || [])

  useEffect(() => {
    if (keyCache) return
    api
      .get('/equipment/keys')
      .then(({ data }) => {
        keyCache = data
        setKeys(data)
      })
      .catch(() => {}) // only suggestions (and the form is hidden on a phone without a connection)
  }, [])

  const update = (i, patch) => onChange(value.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  const remove = (i) => onChange(value.filter((_, idx) => idx !== i))
  const move = (i, d) => {
    const next = [...value]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    onChange(next)
  }

  return (
    <div className="field-editor">
      {value.map((f, i) => (
        <div className="field-editor-row" key={i}>
          <AutoComplete
            className="field-editor-key"
            value={f.key}
            placeholder={t('key')}
            options={keys.filter((k) => k.toLowerCase().includes((f.key || '').toLowerCase())).slice(0, 20).map((k) => ({ value: k }))}
            onChange={(v) => update(i, { key: v })}
            status={!f.key?.trim() ? 'error' : undefined}
          />
          <Input.TextArea
            className="field-editor-value"
            value={f.value ?? ''}
            placeholder={t('value')}
            autoSize={{ minRows: 1, maxRows: 6 }}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <div className="field-editor-actions">
            <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} />
            <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === value.length - 1} onClick={() => move(i, 1)} />
            <Tooltip title={t('delete')}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(i)} />
            </Tooltip>
          </div>
        </div>
      ))}
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => onChange([...value, { key: '', value: '' }])}>
        {t('add_field')}
      </Button>
    </div>
  )
}

/** Drops empty rows before saving. */
export function cleanFields(fields) {
  return fields.filter((f) => f.key?.trim()).map((f) => ({ key: f.key.trim(), value: f.value ?? '' }))
}
