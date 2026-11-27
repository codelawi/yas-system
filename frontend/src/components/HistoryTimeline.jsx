import { Link } from 'react-router-dom'
import { Empty, Tag, Timeline, Typography } from 'antd'
import dayjs from 'dayjs'
import { useLang } from '../i18n'

export const ACTION_COLORS = { created: 'green', imported: 'blue', updated: 'orange', deleted: 'red', accessory_added: 'purple', accessory_removed: 'gray', custody_out: 'cyan', custody_in: 'geekblue', maintenance_done: 'gold', issue_reported: 'volcano', issue_closed: 'lime', box_added: 'purple', box_removed: 'gray', photo_changed: 'blue', photo_removed: 'gray', group_changed: 'cyan', restored: 'green' }

export function Changes({ changes, t }) {
  if (!changes) return null
  if (changes.summary && !changes.changed && !changes.added && !changes.removed) {
    return <div className="history-changes">{changes.summary}</div>
  }
  if (changes.accessory) {
    const a = changes.accessory
    return (
      <div className="history-changes">
        {a.name && `${a.name} · `}
        <span className="serial">{a.serial_number}</span>
      </div>
    )
  }
  const fieldName = (c) => (c.system ? t(c.key) : c.key)
  return (
    <div className="history-changes">
      {changes.overwrite && <div>{t('ch_overwrite')}</div>}
      {changes.changed?.map((c, i) => (
        <div key={`c${i}`}>
          <Tag color="orange">{t('ch_changed')}</Tag>
          <b>{fieldName(c)}</b>: <del>{c.from || '—'}</del> → {c.to || '—'}
        </div>
      ))}
      {changes.added?.map((c, i) => (
        <div key={`a${i}`}>
          <Tag color="green">{t('ch_added')}</Tag>
          <b>{c.key}</b>: {c.value || '—'}
        </div>
      ))}
      {changes.removed?.map((c, i) => (
        <div key={`r${i}`}>
          <Tag color="red">{t('ch_removed')}</Tag>
          <b>{c.key}</b>: <del>{c.value || '—'}</del>
        </div>
      ))}
    </div>
  )
}

/** `showSerial` adds a link to the equipment (used on the dashboard, where changes are hidden). */
export default function HistoryTimeline({ logs, showSerial }) {
  const { t } = useLang()
  if (!logs?.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_data')} />

  return (
    <Timeline
      items={logs.map((log) => ({
        color: ACTION_COLORS[log.action] || 'gray',
        content: (
          <div>
            <Typography.Text strong>{t(`act_${log.action}`)}</Typography.Text>{' '}
            {showSerial && log.serial_number && (
              <>
                {log.equipment_id && log.action !== 'deleted' ? (
                  <Link to={`/equipment/${log.equipment_id}`} className="serial">{log.serial_number}</Link>
                ) : (
                  <span className="serial">{log.serial_number}</span>
                )}{' '}
              </>
            )}
            <Typography.Text type="secondary">
              {log.user?.name && `${t('by')} ${log.user.name} · `}
              {dayjs(log.created_at).format('YYYY-MM-DD HH:mm')}
            </Typography.Text>
            {/* Made on a phone without a connection, saved when it synced */}
            {log.changes?.offline && (
              <Tag className="offline-mark" style={{ marginInlineStart: 6 }}>
                {t('made_offline')}
              </Tag>
            )}
            {/* The full field list on creation is noise; show changes only for edits */}
            {!showSerial && log.action !== 'created' && !(log.action === 'imported' && !log.changes?.overwrite) && (
              <Changes changes={log.changes} t={t} />
            )}
          </div>
        ),
      }))}
    />
  )
}
