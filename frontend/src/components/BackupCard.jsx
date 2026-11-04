import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, InputNumber, Table, Typography } from 'antd'
import { CloudDownloadOutlined, DatabaseOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import api, { errorKey, tokenStore } from '../api'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import { useDangerConfirm } from './DangerZoneCard'

dayjs.extend(relativeTime)

const size = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/** Backup folder, retention, "backup now" and the list of backups (admin only). */
export default function BackupCard({ signal, onChanged }) {
  const { t } = useLang()
  const { settings, setSettings } = useSettings()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const confirm = useDangerConfirm()

  const load = useCallback(() => api.get('/backups').then(({ data }) => setInfo(data)), [])

  useEffect(() => {
    load()
  }, [load, signal])

  useEffect(() => {
    form.setFieldsValue({ backup_path: settings.backup_path, backup_keep: Number(settings.backup_keep) || 30 })
  }, [settings, form])

  const saveSettings = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const { data } = await api.put('/settings', values)
      setSettings(data)
      await load()
      message.success(t('saved'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const backupNow = async () => {
    setBusy(true)
    try {
      await api.post('/backups')
      await load()
      message.success(t('backup_done'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setBusy(false)
    }
  }

  // Downloads need the PIN token, so fetch the file and hand it to the browser
  const download = async (file) => {
    const res = await fetch(`/api/backups/${file}`, { headers: { Authorization: `Bearer ${tokenStore.get()}` } })
    if (!res.ok) return message.error(t('error'))
    const url = URL.createObjectURL(await res.blob())
    const a = Object.assign(document.createElement('a'), { href: url, download: file })
    a.click()
    URL.revokeObjectURL(url)
  }

  const remove = async (file) => {
    const done = await confirm({ title: t('dz_backup_one'), body: <span dir="ltr">{file}</span>, run: (pin) => api.post('/backups/delete', { file, pin }) })
    if (!done) return
    message.success(t('deleted'))
    load()
    onChanged?.()
  }

  const last = info?.last_backup_at
  const stale = !last || dayjs().diff(dayjs(last), 'hour') > 30

  return (
    <Card
      title={
        <span>
          <DatabaseOutlined /> {t('backup_title')}
        </span>
      }
      extra={
        <Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={backupNow}>
          {t('backup_now')}
        </Button>
      }
      style={{ marginTop: 16 }}
    >
      <Alert
        type={stale ? 'warning' : 'success'}
        showIcon
        style={{ marginBottom: 16 }}
        title={last ? t('backup_last', { when: dayjs(last).fromNow(), date: dayjs(last).format('YYYY-MM-DD HH:mm') }) : t('backup_never')}
        description={t('backup_auto_help')}
      />

      <Form form={form} layout="vertical">
        <Form.Item name="backup_path" label={t('backup_folder')} extra={t('backup_folder_help')}>
          <Input dir="ltr" placeholder={info?.folder} />
        </Form.Item>
        {info && !info.folder_writable && <Alert type="error" showIcon title={t('backup_folder_not_writable')} style={{ marginBottom: 12 }} />}
        <Form.Item name="backup_keep" label={t('backup_keep')}>
          <InputNumber min={3} max={365} style={{ width: 160 }} />
        </Form.Item>
        <Button onClick={saveSettings} loading={saving}>
          {t('save')}
        </Button>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t('backup_list')} ({info?.backups.length ?? 0})
      </Typography.Title>
      <Typography.Paragraph type="secondary" className="serial" style={{ fontWeight: 400 }}>
        {info?.folder}
      </Typography.Paragraph>
      <Table
        rowKey="file"
        size="small"
        dataSource={info?.backups || []}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('backup_date'), dataIndex: 'created_at', render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm') },
          { title: t('file'), dataIndex: 'file', render: (v) => <span dir="ltr">{v}</span> },
          { title: t('backup_size'), dataIndex: 'size', render: size },
          {
            key: 'actions',
            render: (_, r) => (
              <div className="page-actions" style={{ flexWrap: 'nowrap' }}>
                <Button size="small" icon={<CloudDownloadOutlined />} onClick={() => download(r.file)} />
                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('delete')} onClick={() => remove(r.file)} />
              </div>
            ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        {t('backup_restore_help')} <Typography.Text code copyable>php artisan repo:restore</Typography.Text>
      </Typography.Paragraph>
    </Card>
  )
}
