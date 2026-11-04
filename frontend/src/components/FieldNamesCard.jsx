import { useCallback, useEffect, useState } from 'react'
import { App, AutoComplete, Button, Card, Modal, Table, Typography } from 'antd'
import { MergeCellsOutlined, TagsOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'

/** Every field name with its usage; merge / rename several names into one. */
export default function FieldNamesCard() {
  const { t } = useLang()
  const { message } = App.useApp()
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState([])
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => api.get('/fields/usage').then(({ data }) => setRows(data)), [])
  useEffect(() => {
    load()
  }, [load])

  const rename = async () => {
    if (!target.trim()) return
    setSaving(true)
    try {
      const { data } = await api.post('/fields/rename', { from: selected, to: target.trim() })
      message.success(t('rename_done', { n: data.updated }))
      setOpen(false)
      setSelected([])
      load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title={
        <span>
          <TagsOutlined /> {t('field_names')}
        </span>
      }
      extra={
        <Button
          type="primary"
          icon={<MergeCellsOutlined />}
          disabled={!selected.length}
          onClick={() => {
            setTarget(selected[0] || '')
            setOpen(true)
          }}
        >
          {t('merge_rename', { n: selected.length })}
        </Button>
      }
      style={{ marginTop: 16 }}
    >
      <Typography.Paragraph type="secondary">{t('field_names_help')}</Typography.Paragraph>
      <Table
        rowKey="key"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 15, hideOnSinglePage: true }}
        rowSelection={{ selectedRowKeys: selected, onChange: setSelected }}
        columns={[
          { title: t('key'), dataIndex: 'key', render: (k) => <bdi>{k}</bdi> },
          { title: t('uses'), dataIndex: 'uses', width: 100, align: 'center' },
        ]}
      />
      <Modal open={open} title={t('merge_rename', { n: selected.length })} okText={t('save')} cancelText={t('cancel')} onOk={rename} onCancel={() => setOpen(false)} confirmLoading={saving}>
        <Typography.Paragraph>
          {selected.map((k) => (
            <bdi key={k} className="key-chip">
              {k}
            </bdi>
          ))}
        </Typography.Paragraph>
        <Typography.Text strong>{t('new_name')}</Typography.Text>
        <AutoComplete value={target} onChange={setTarget} options={rows.map((r) => ({ value: r.key }))} filterOption style={{ width: '100%', marginTop: 6 }} autoFocus />
      </Modal>
    </Card>
  )
}
