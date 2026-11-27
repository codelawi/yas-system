import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, Button, Result, Space } from 'antd'
import { CloudSyncOutlined, DisconnectOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api'
import { useLang } from '../i18n'
import { readOfflineMeta, useOfflineState } from '../offline'
import { startSync } from './OfflineChanges'

/** While changes wait, how often the worker is asked whether the server can be reached. */
const CHECK_EVERY = 15000

/**
 * Shown on every page while the data comes from the copy saved on this phone: without a
 * connection, or with changes made on the phone and not synced yet (then it offers to sync,
 * and asks once when the connection comes back).
 */
export default function OfflineBanner() {
  const { t } = useLang()
  const { modal } = App.useApp()
  const { offline, changes, server } = useOfflineState()
  const [meta, setMeta] = useState(null)
  const asked = useRef(false)

  useEffect(() => {
    if (offline) readOfflineMeta().then(setMeta)
  }, [offline])

  // The headers of every answer from the copy say whether the server answered; ask now and then too
  useEffect(() => {
    if (!offline || !changes) return
    const timer = setInterval(() => api.get('/offline/status').catch(() => {}), CHECK_EVERY)
    return () => clearInterval(timer)
  }, [offline, changes])

  useEffect(() => {
    if (!changes || !server) {
      if (!server) asked.current = false
      return
    }
    if (asked.current) return
    asked.current = true
    modal.confirm({
      icon: <CloudSyncOutlined />,
      title: t('sync_now_title'),
      content: t('sync_now_body', { n: changes }),
      okText: t('sync'),
      cancelText: t('sync_later'),
      onOk: startSync,
    })
  }, [changes, server, modal, t])

  if (!offline) return null
  const connected = changes > 0 && server
  // The date is isolated (U+2066…U+2069) so it reads left to right inside the Arabic text
  const date = meta && `⁦${dayjs(meta.generated_at).format('YYYY-MM-DD HH:mm')}⁩`
  const title = changes > 0 ? t(connected ? 'offline_banner_connected' : 'offline_banner_pending', { n: changes }) : meta ? t('offline_banner', { date }) : t('offline_banner_no_data')
  return (
    <Alert
      banner
      type={connected ? 'info' : 'warning'}
      icon={connected ? <CloudSyncOutlined /> : <DisconnectOutlined />}
      className="offline-banner"
      title={title}
      action={
        <Space size={4}>
          <Link to="/offline">
            <Button size="small" type="text">
              {t(changes > 0 ? 'offline_changes' : 'offline_title')}
            </Button>
          </Link>
          {changes > 0 && (
            <Button size="small" type={connected ? 'primary' : 'default'} icon={<CloudSyncOutlined />} onClick={startSync}>
              {t('sync')}
            </Button>
          )}
        </Space>
      }
    />
  )
}

/** A scan page opened without a connection on a phone that has no saved copy. */
export function OfflineNoCopy() {
  const { t } = useLang()
  return (
    <Result
      status="warning"
      title={t('offline_no_data')}
      subTitle={t('offline_no_data_hint')}
      extra={
        <Link to="/offline">
          <Button type="primary">{t('offline_title')}</Button>
        </Link>
      }
    />
  )
}

/** True when a scan page's request failed because the phone has no saved copy (see sw.js). */
export const noOfflineCopy = (error) => error?.response?.data?.message === 'offline_no_data'
