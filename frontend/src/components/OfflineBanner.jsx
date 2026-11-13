import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Result } from 'antd'
import { DisconnectOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useLang } from '../i18n'
import { readOfflineMeta, useOffline } from '../offline'

/** Shown on every page while the data comes from the copy saved on this phone. */
export default function OfflineBanner() {
  const { t } = useLang()
  const offline = useOffline()
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    if (offline) readOfflineMeta().then(setMeta)
  }, [offline])

  if (!offline) return null
  // The date is isolated (U+2066…U+2069) so it reads left to right inside the Arabic text
  return (
    <Alert
      banner
      type="warning"
      icon={<DisconnectOutlined />}
      className="offline-banner"
      title={meta ? t('offline_banner', { date: `\u2066${dayjs(meta.generated_at).format('YYYY-MM-DD HH:mm')}\u2069` }) : t('offline_banner_no_data')}
      action={
        <Link to="/offline">
          <Button size="small" type="text">
            {t('offline_title')}
          </Button>
        </Link>
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
