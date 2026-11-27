import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, Button, Modal, Result, Space } from 'antd'
import { CloudDownloadOutlined, CloudSyncOutlined, DisconnectOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api'
import { useLang } from '../i18n'
import { COPY_SAVED, offlineSupported, readOfflineMeta, readPhotosChoice, staleCopyRevision, useOfflineState } from '../offline'
import { startSync } from './OfflineChanges'
import { DownloadProgress, useOfflineDownload } from './OfflineDownload'

/** While changes wait, how often the worker is asked whether the server can be reached. */
const CHECK_EVERY = 15000

/** Connected: how often the phone asks whether the system changed since its copy was saved. */
const STALE_CHECK_EVERY = 60000

/** The system's revision when the notice was hidden: it shows again only after another change. */
const HIDDEN_KEY = 'offline_stale_hidden'

function readHidden() {
  try {
    return localStorage.getItem(HIDDEN_KEY)
  } catch {
    return null
  }
}

/**
 * Connected, while the copy on this phone is out of date (something changed on the system since it
 * was saved): a light strip to update it in place, or hide it until the next change.
 */
function StaleCopyNotice() {
  const { t } = useLang()
  const [stale, setStale] = useState(null)
  const [hidden, setHidden] = useState(readHidden)
  const { progress, download } = useOfflineDownload()

  useEffect(() => {
    if (!offlineSupported()) return undefined
    let alive = true
    const check = () => staleCopyRevision().then((revision) => alive && setStale(revision))
    const onVisible = () => document.visibilityState === 'visible' && check()
    check()
    const timer = setInterval(check, STALE_CHECK_EVERY)
    window.addEventListener('focus', check)
    window.addEventListener(COPY_SAVED, check)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', check)
      window.removeEventListener(COPY_SAVED, check)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const hide = () => {
    setHidden(stale)
    try {
      localStorage.setItem(HIDDEN_KEY, stale)
    } catch {
      /* hidden until the page is opened again */
    }
  }

  return (
    <>
      {stale && stale !== hidden && (
        <Alert
          banner
          type="info"
          icon={<CloudDownloadOutlined />}
          className="offline-banner offline-stale"
          title={t('offline_stale')}
          action={
            <Space size={4}>
              <Button size="small" type="text" onClick={hide} disabled={!!progress}>
                {t('offline_stale_later')}
              </Button>
              <Button size="small" type="primary" icon={<CloudDownloadOutlined />} loading={!!progress} onClick={() => download(readPhotosChoice())}>
                {t('offline_stale_update')}
              </Button>
            </Space>
          }
        />
      )}
      <Modal
        open={!!progress}
        title={
          <span>
            <CloudDownloadOutlined /> {t('offline_stale_updating')}
          </span>
        }
        footer={null}
        closable={false}
        mask={{ closable: false }}
        destroyOnHidden
      >
        <DownloadProgress progress={progress} />
      </Modal>
    </>
  )
}

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

  if (!offline) return <StaleCopyNotice />
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
