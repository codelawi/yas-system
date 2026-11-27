import { useEffect, useState } from 'react'
import { App, Button, Card, List, Tag, Typography } from 'antd'
import { CloudSyncOutlined, CloudUploadOutlined, RollbackOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { Changes } from './HistoryTimeline'

/** Opens the sync dialog (OfflineSync.jsx). */
export const SYNC_EVENT = 'offline:sync'
export const startSync = () => window.dispatchEvent(new Event(SYNC_EVENT))

/** On a list row: added or changed on this phone, not synced yet. */
export function OfflineMark({ mark }) {
  const { t } = useLang()
  if (!mark) return null
  return (
    <Tag color={mark === 'new' ? 'green' : 'orange'} className="offline-mark">
      {t(mark === 'new' ? 'offline_mark_new' : 'offline_mark_changed')}
    </Tag>
  )
}

/** What a change does, in one sentence (its effect, see offlineEdit.js). */
export function changeText(t, change) {
  const { kind } = change
  let key = `chg_${kind}`
  if (kind === 'equipment_deleted' && change.n > 1) key = 'chg_equipment_deleted_many'
  if ((kind === 'group_updated' || kind === 'box_updated') && change.from) key = `${key}_from`
  return t(key, change)
}

function ChangeItem({ change, onUndo }) {
  const { t } = useLang()
  return (
    <List.Item
      actions={
        onUndo && [
          <Button key="undo" size="small" icon={<RollbackOutlined />} onClick={() => onUndo(change.id)}>
            {t('undo')}
          </Button>,
        ]
      }
    >
      <div className="offline-change">
        <Typography.Text delete={change.failed}>{changeText(t, change)}</Typography.Text>
        <Typography.Text type="secondary" className="offline-change-meta">
          {change.user && `${t('by')} ${change.user} · `}
          <span dir="ltr">{dayjs(change.at).format('YYYY-MM-DD HH:mm')}</span>
        </Typography.Text>
        {change.kind === 'equipment_updated' && <Changes changes={change.changes} t={t} />}
        {change.labels?.length > 0 && (
          <Typography.Text type="secondary" className="offline-change-labels">
            {change.labels.slice(0, 8).join('، ')}
            {change.labels.length > 8 && ' …'}
          </Typography.Text>
        )}
      </div>
    </List.Item>
  )
}

/**
 * Undoes a change kept on the phone (sw.js), and the later ones that need it, after asking.
 * The pages are read again: the change may show on any of them.
 */
export function useUndoChange() {
  const { t } = useLang()
  const { modal, message } = App.useApp()
  return async (id) => {
    let undone
    try {
      undone = (await api.post(`/offline/changes/${id}/undo`, { dry_run: true })).data
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
      return
    }
    const others = undone.filter((c) => c.id !== id)
    const confirmed = await modal.confirm({
      title: t('undo_confirm'),
      content: (
        <div>
          <Typography.Paragraph>{changeText(t, undone.find((c) => c.id === id) || undone[0])}</Typography.Paragraph>
          {others.length > 0 && (
            <>
              <Typography.Paragraph type="warning">{t('undo_with_dependents', { n: others.length })}</Typography.Paragraph>
              <ul className="offline-undo-list">
                {others.map((c) => (
                  <li key={c.id}>{changeText(t, c)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ),
      okText: t('undo'),
      cancelText: t('cancel'),
      okButtonProps: { danger: true },
    })
    if (!confirmed) return
    try {
      await api.post(`/offline/changes/${id}/undo`)
      message.success(t('undone'))
      window.location.reload()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }
}

/** On an equipment, box or group page: what was changed on it on this phone and is not synced yet. */
export function UnsyncedCard({ changes }) {
  const { t } = useLang()
  const undo = useUndoChange()
  if (!changes?.length) return null
  return (
    <Card
      size="small"
      className="offline-unsynced"
      title={
        <span>
          <CloudUploadOutlined /> {t('unsynced_title')} ({changes.length})
        </span>
      }
      extra={
        <Button size="small" type="link" icon={<CloudSyncOutlined />} onClick={startSync}>
          {t('sync')}
        </Button>
      }
      style={{ marginBottom: 16 }}
    >
      <List size="small" dataSource={changes} rowKey="id" renderItem={(change) => <ChangeItem change={change} onUndo={undo} />} />
    </Card>
  )
}

/** The changes waiting on this phone (the "Work offline" page), each with undo. */
export function PendingChanges({ onCount }) {
  const { t } = useLang()
  const undo = useUndoChange()
  const [changes, setChanges] = useState(null)

  useEffect(() => {
    api
      .get('/offline/changes')
      .then(({ data }) => setChanges(Array.isArray(data) ? data : []))
      .catch(() => setChanges([]))
  }, [])

  useEffect(() => {
    if (changes) onCount?.(changes.length)
  }, [changes, onCount])

  if (!changes?.length) return null
  return (
    <Card
      title={
        <span>
          <CloudUploadOutlined /> {t('pending_changes_title', { n: changes.length })}
        </span>
      }
      style={{ marginBottom: 16 }}
    >
      <Typography.Paragraph type="secondary">{t('pending_changes_hint')}</Typography.Paragraph>
      <Button type="primary" size="large" block icon={<CloudSyncOutlined />} onClick={startSync} style={{ marginBottom: 12 }}>
        {t('sync')}
      </Button>
      <List size="small" dataSource={[...changes].reverse()} rowKey="id" renderItem={(change) => <ChangeItem change={change} onUndo={undo} />} />
    </Card>
  )
}
