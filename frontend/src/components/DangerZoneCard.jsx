import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, Input, Typography } from 'antd'
import { DeleteOutlined, WarningOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'

/**
 * Confirmation for dangerous actions: type the confirmation word and the PIN.
 * `run(pin)` does the request; a wrong PIN keeps the dialog open.
 */
export function useDangerConfirm() {
  const { t } = useLang()
  const { modal, message } = App.useApp()

  return ({ title, body, run }) =>
    new Promise((resolve) => {
      const word = t('dz_word')
      let typed = ''
      let pin = ''
      const dialog = modal.confirm({
        title,
        icon: <WarningOutlined style={{ color: '#dc2626' }} />,
        okText: t('delete'),
        okButtonProps: { danger: true, disabled: true },
        cancelText: t('cancel'),
        content: (
          <div>
            <Typography.Paragraph>{body}</Typography.Paragraph>
            <Typography.Paragraph strong>{t('dz_type_word', { word })}</Typography.Paragraph>
            <Input
              autoFocus
              onChange={(e) => {
                typed = e.target.value.trim()
                dialog.update({ okButtonProps: { danger: true, disabled: typed !== word || !pin } })
              }}
              style={{ marginBottom: 8 }}
            />
            <Input.Password
              inputMode="numeric"
              maxLength={8}
              placeholder={t('pin')}
              onChange={(e) => {
                pin = e.target.value.replace(/\D/g, '')
                dialog.update({ okButtonProps: { danger: true, disabled: typed !== word || !pin } })
              }}
              style={{ letterSpacing: 4 }}
            />
          </div>
        ),
        onOk: async () => {
          try {
            resolve(await run(pin))
          } catch (e) {
            message.error(t(errorKey(e) || 'error'))
            // Keep the dialog open so the PIN can be typed again
            throw e
          }
        },
        onCancel: () => resolve(null),
      })
    })
}

const TARGETS = ['history', 'stocktakes', 'custody', 'issues', 'maintenance', 'equipment', 'all']

/** Settings → danger zone: clear data, delete all backups (admin only). */
export default function DangerZoneCard({ onBackupsChanged, backupSignal }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const confirm = useDangerConfirm()
  const [counts, setCounts] = useState(null)

  const load = useCallback(() => api.get('/danger').then(({ data }) => setCounts(data)), [])
  useEffect(() => {
    load()
  }, [load, backupSignal])

  const countOf = (target) => (target === 'all' ? counts.equipment + counts.history + counts.stocktakes : counts[target])

  const clear = async (target) => {
    const done = await confirm({
      title: t(`dz_${target}`),
      body: (
        <>
          {t(`dz_${target}_help`)}
          <br />
          <b>{t('dz_count', { n: countOf(target) })}</b>
          <br />
          {t('dz_safety')}
        </>
      ),
      run: (pin) => api.post('/danger/clear', { target, pin }),
    })
    if (!done) return
    message.success(t('dz_cleared', { n: done.data.deleted, file: done.data.safety_backup }), 8)
    load()
    onBackupsChanged?.()
  }

  const deleteBackups = async () => {
    const done = await confirm({
      title: t('dz_backups'),
      body: (
        <>
          {t('dz_backups_help')}
          <br />
          <b>{t('dz_count', { n: counts.backups })}</b>
        </>
      ),
      run: (pin) => api.post('/backups/delete', { pin }),
    })
    if (!done) return
    message.success(t('dz_backups_deleted', { n: done.data.deleted }))
    load()
    onBackupsChanged?.()
  }

  const row = (key, count, onClick) => (
    <div key={key} className="danger-row">
      <div>
        <b>{t(`dz_${key}`)}</b>
        <div className="mini-sub">{t(`dz_${key}_help`)}</div>
      </div>
      <Button danger icon={<DeleteOutlined />} disabled={!count} onClick={onClick}>
        {t('delete')} {count ? `(${count})` : ''}
      </Button>
    </div>
  )

  return (
    <Card
      className="danger-zone"
      title={
        <span>
          <WarningOutlined /> {t('dz_title')}
        </span>
      }
      style={{ marginTop: 16 }}
    >
      <Alert type="warning" showIcon title={t('dz_intro')} style={{ marginBottom: 8 }} />
      {counts && (
        <>
          {TARGETS.map((target) => row(target, countOf(target), () => clear(target)))}
          {row('backups', counts.backups, deleteBackups)}
        </>
      )}
    </Card>
  )
}
