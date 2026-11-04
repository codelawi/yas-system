import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, Button, Card, Form, Input, Typography } from 'antd'
import { QrcodeOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import BackupCard from '../components/BackupCard'
import FieldNamesCard from '../components/FieldNamesCard'
import DangerZoneCard from '../components/DangerZoneCard'

/** General settings. Everything about QR codes and labels lives on the QR page. */
export default function SettingsPage() {
  const { t } = useLang()
  const { settings, setSettings } = useSettings()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  // Bumped when backups change, so the backup list and the danger zone both refresh
  const [backupSignal, setBackupSignal] = useState(0)
  const backupsChanged = () => setBackupSignal((n) => n + 1)

  useEffect(() => {
    form.setFieldsValue({ serial_aliases: settings.serial_aliases, row_no_aliases: settings.row_no_aliases, attention_words: settings.attention_words })
  }, [settings, form])

  const save = async () => {
    const data = await form.validateFields()
    setSaving(true)
    try {
      const res = await api.put('/settings', data)
      setSettings(res.data)
      message.success(t('saved'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <Typography.Title level={3}>{t('settings')}</Typography.Title>
      <Alert
        type="info"
        showIcon
        icon={<QrcodeOutlined />}
        style={{ marginBottom: 16 }}
        title={
          <span>
            {t('qr_codes')}: <Link to="/qr">{t('qr_address_title')} · {t('label_design')}</Link>
          </span>
        }
      />
      <Card title={t('import')}>
        <Form form={form} layout="vertical">
          <Form.Item name="serial_aliases" label={t('serial_aliases')} rules={[{ required: true }]}>
            <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} />
          </Form.Item>
          <Form.Item name="row_no_aliases" label={t('row_no_aliases')}>
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} />
          </Form.Item>
          <Form.Item name="attention_words" label={t('attention_words')}>
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} />
          </Form.Item>
          <Button type="primary" onClick={save} loading={saving}>
            {t('save')}
          </Button>
        </Form>
      </Card>
      <FieldNamesCard />
      <BackupCard signal={backupSignal} onChanged={backupsChanged} />
      <DangerZoneCard backupSignal={backupSignal} onBackupsChanged={backupsChanged} />
    </div>
  )
}
