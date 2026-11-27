import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, Button, Card, Checkbox, Empty, Layout, Popconfirm, Progress, Typography } from 'antd'
import { AppstoreOutlined, CloudDownloadOutlined, DeleteOutlined, GlobalOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import { useAuth } from '../auth'
import { tokenStore } from '../api'
import { OfflineNeedsPin, clearOffline, downloadOffline, offlineSupported, readOfflineMeta } from '../offline'

const PHOTOS_KEY = 'offline_with_photos'

function readPhotosChoice() {
  try {
    return localStorage.getItem(PHOTOS_KEY) !== '0'
  } catch {
    return true
  }
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function originOf(url) {
  try {
    return url ? new URL(url).origin : null
  } catch {
    return null
  }
}

/** Without https: install the certificate once, then open this page on https. */
function NeedsHttps() {
  const { t } = useLang()
  const onHttp = window.location.protocol === 'http:'

  return (
    <Card>
      <Alert type="warning" showIcon title={t('offline_needs_https')} style={{ marginBottom: 16 }} />
      {onHttp ? (
        <ol className="offline-steps">
          <li>
            <Typography.Paragraph>{t('offline_step_certificate')}</Typography.Paragraph>
            <Button icon={<SafetyCertificateOutlined />} href="/repo-ca.crt" size="large" block>
              {t('offline_download_certificate')}
            </Button>
            <Typography.Paragraph type="secondary" className="offline-hint">
              <strong>iPhone:</strong> {t('offline_certificate_iphone')}
              <br />
              <strong>Android:</strong> {t('offline_certificate_android')}
            </Typography.Paragraph>
          </li>
          <li>
            <Typography.Paragraph>{t('offline_step_open_https')}</Typography.Paragraph>
            <Button type="primary" href={`https://${window.location.host}/offline`} size="large" block dir="ltr">
              {`https://${window.location.host}`}
            </Button>
          </li>
        </ol>
      ) : (
        <Typography.Paragraph>{t('offline_browser_unsupported')}</Typography.Paragraph>
      )}
    </Card>
  )
}

/** Saves everything on this phone so the system's pages open without a connection. */
export default function OfflinePage() {
  const { t, toggle } = useLang()
  const { settings } = useSettings()
  const { user, requirePin } = useAuth()
  const { message } = App.useApp()
  const [meta, setMeta] = useState(undefined)
  const [withPhotos, setWithPhotos] = useState(readPhotosChoice)
  const [progress, setProgress] = useState(null)
  const supported = offlineSupported()
  const labelsOrigin = originOf(settings.base_url)
  const wrongAddress = labelsOrigin && labelsOrigin !== window.location.origin

  useEffect(() => {
    readOfflineMeta().then(setMeta)
  }, [])

  const choosePhotos = (value) => {
    setWithPhotos(value)
    try {
      localStorage.setItem(PHOTOS_KEY, value ? '1' : '0')
    } catch {
      /* not remembered */
    }
  }

  const download = async () => {
    // The copy holds vouchers and recipients
    if (!(await requirePin())) return
    setProgress({ step: 'app' })
    try {
      const saved = await downloadOffline({ token: tokenStore.get(), withPhotos, onProgress: setProgress })
      setMeta(saved)
      message.success(t('offline_saved'))
      if (saved.photos_failed) message.warning(t('offline_photos_failed', { n: saved.photos_failed }))
    } catch (e) {
      if (e instanceof OfflineNeedsPin) {
        window.dispatchEvent(new Event('auth:expired'))
        message.error(t('offline_pin_again'))
      } else message.error(t('offline_download_failed'))
    } finally {
      setProgress(null)
    }
  }

  const remove = async () => {
    await clearOffline()
    setMeta(null)
    message.success(t('offline_removed'))
  }

  const progressText = progress && (progress.step === 'photos' ? t('offline_progress_photos', { done: progress.done, total: progress.total }) : t(`offline_progress_${progress.step}`))

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header scan-header">
        <Link to="/" className="brand-inline">
          <AppstoreOutlined /> {t('app_name')}
        </Link>
        <div style={{ flex: 1 }} />
        <Button type="text" icon={<GlobalOutlined />} onClick={toggle}>
          {t('language')}
        </Button>
      </Layout.Header>
      <Layout.Content className="app-content">
        <div className="page" style={{ maxWidth: 560 }}>
          <Typography.Title level={3}>
            <CloudDownloadOutlined /> {t('offline_title')}
          </Typography.Title>
          <Typography.Paragraph type="secondary">{t('offline_intro')}</Typography.Paragraph>

          {!supported ? (
            <NeedsHttps />
          ) : (
            <>
              {wrongAddress && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  title={t('offline_wrong_address', { url: settings.base_url })}
                  action={
                    <Button size="small" href={`${labelsOrigin}/offline`}>
                      {t('offline_open_labels_address')}
                    </Button>
                  }
                />
              )}

              <Card title={t('offline_on_this_phone')}>
                {meta ? (
                  <dl className="offline-meta">
                    <dt>{t('offline_saved_at')}</dt>
                    <dd>
                      <span dir="ltr">{dayjs(meta.generated_at).format('YYYY-MM-DD HH:mm')}</span>
                    </dd>
                    <dt>{t('equipment')}</dt>
                    <dd>{meta.equipment}</dd>
                    <dt>{t('boxes')}</dt>
                    <dd>{meta.boxes}</dd>
                    {meta.version >= 2 && (
                      <>
                        <dt>{t('groups')}</dt>
                        <dd>{meta.groups}</dd>
                        <dt>{t('vouchers')}</dt>
                        <dd>{meta.vouchers}</dd>
                        <dt>{t('scan_docs')}</dt>
                        <dd>{meta.scan_documents}</dd>
                      </>
                    )}
                    <dt>{t('offline_photos')}</dt>
                    <dd>{meta.with_photos ? meta.photos : t('offline_no_photos')}</dd>
                    <dt>{t('offline_size')}</dt>
                    <dd>
                      <span dir="ltr">{formatSize(meta.bytes)}</span>
                    </dd>
                  </dl>
                ) : (
                  meta === null && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('offline_nothing_saved')} />
                )}
                {meta && !(meta.version >= 2) && <Alert type="warning" showIcon title={t('offline_old_copy')} style={{ marginTop: 12 }} />}

                <Checkbox checked={withPhotos} onChange={(e) => choosePhotos(e.target.checked)} disabled={!!progress} style={{ margin: '16px 0' }}>
                  {t('offline_with_photos')}
                </Checkbox>
                <Button type="primary" size="large" block icon={<CloudDownloadOutlined />} loading={!!progress} onClick={download}>
                  {t(meta ? 'offline_update' : 'offline_download')}
                </Button>
                {!user && !progress && (
                  <Typography.Paragraph type="secondary" className="offline-hint">
                    {t('offline_download_pin')}
                  </Typography.Paragraph>
                )}
                {progress && (
                  <div style={{ marginTop: 12 }}>
                    {progress.step === 'photos' && progress.total > 0 && <Progress percent={Math.round((progress.done / progress.total) * 100)} />}
                    <Typography.Text type="secondary">{progressText}</Typography.Text>
                  </div>
                )}
                {meta && (
                  <Popconfirm title={t('offline_remove_confirm')} okText={t('delete')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={remove}>
                    <Button danger type="text" icon={<DeleteOutlined />} block style={{ marginTop: 8 }} disabled={!!progress}>
                      {t('offline_remove')}
                    </Button>
                  </Popconfirm>
                )}
              </Card>

              <Card title={t('offline_tips_title')} style={{ marginTop: 16 }}>
                <ul className="offline-tips">
                  <li>{t('offline_tip_test')}</li>
                  <li>{t('offline_tip_refresh')}</li>
                  <li>{t('offline_tip_view_only')}</li>
                  <li>{t('offline_tip_pin')}</li>
                  <li>{t('offline_tip_iphone')}</li>
                </ul>
              </Card>
            </>
          )}
        </div>
      </Layout.Content>
    </Layout>
  )
}
