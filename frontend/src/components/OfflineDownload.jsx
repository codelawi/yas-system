import { useState } from 'react'
import { App, Progress, Typography } from 'antd'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { tokenStore } from '../api'
import { OfflineNeedsPin, downloadOffline } from '../offline'

/**
 * Saves a new copy on this phone (the "Work offline" page, or the notice that the copy is out of
 * date): the PIN first, since the copy holds vouchers and recipients. `download(withPhotos)`
 * resolves to the new meta, or null when cancelled or failed (it says why).
 */
export function useOfflineDownload() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const [progress, setProgress] = useState(null)

  const download = async (withPhotos) => {
    const who = await requirePin()
    if (!who) return null
    setProgress({ step: 'app' })
    try {
      const saved = await downloadOffline({ token: tokenStore.get(), user: who, withPhotos, onProgress: setProgress })
      message.success(t('offline_saved'))
      if (saved.photos_failed) message.warning(t('offline_photos_failed', { n: saved.photos_failed }))
      return saved
    } catch (e) {
      if (e instanceof OfflineNeedsPin) {
        window.dispatchEvent(new Event('auth:expired'))
        message.error(t('offline_pin_again'))
      } else message.error(t('offline_download_failed'))
      return null
    } finally {
      setProgress(null)
    }
  }

  return { progress, download }
}

/** Where a download is: the step, and a bar while the photos come. */
export function DownloadProgress({ progress }) {
  const { t } = useLang()
  if (!progress) return null
  const text = progress.step === 'photos' ? t('offline_progress_photos', { done: progress.done, total: progress.total }) : t(`offline_progress_${progress.step}`)
  return (
    <div style={{ marginTop: 12 }}>
      {progress.step === 'photos' && progress.total > 0 && <Progress percent={Math.round((progress.done / progress.total) * 100)} />}
      <Typography.Text type="secondary">{text}</Typography.Text>
    </div>
  )
}
