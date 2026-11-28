import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, Button, Card, Checkbox, Empty, Layout, Popconfirm, Typography } from 'antd'
import { AppstoreOutlined, CloudDownloadOutlined, DeleteOutlined, GlobalOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import { useAuth } from '../auth'
import { clearOffline, offlineSupported, readOfflineMeta, readPhotosChoice, savePhotosChoice } from '../offline'
import { PendingChanges } from '../components/OfflineChanges'
import { DownloadProgress, useOfflineDownload } from '../components/OfflineDownload'
import { HomeIconCard, HomeIconDialog } from '../components/HomeIcon'
import { isIphone, useOfferHomeIcon } from '../homeIcon'

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
  const { user } = useAuth()
  const { message } = App.useApp()
  const [meta, setMeta] = useState(undefined)
  const [withPhotos, setWithPhotos] = useState(readPhotosChoice)
  const { progress, download: save } = useOfflineDownload()
  // Changes waiting on the phone: a new copy would lose them, they are synced first
  const [pending, setPending] = useState(0)
  // The home screen icon: offered once the data is saved. On the iPhone the icon keeps its own
  // data, apart from Safari's, so it is offered there before the download.
  const offerIcon = useOfferHomeIcon()
  const [iconDialog, setIconDialog] = useState(false)
  const iphone = isIphone()
  const supported = offlineSupported()
  const labelsOrigin = originOf(settings.base_url)
  const wrongAddress = labelsOrigin && labelsOrigin !== window.location.origin

  useEffect(() => {
    readOfflineMeta().then(setMeta)
  }, [])

  const choosePhotos = (value) => {
    setWithPhotos(value)
    savePhotosChoice(value)
  }

  const download = async () => {
    const saved = await save(withPhotos)
    if (!saved) return
    setMeta(saved)
    if (offerIcon) setIconDialog(true)
  }

  const remove = async () => {
    await clearOffline()
    setMeta(null)
    message.success(t('offline_removed'))
  }

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

              {iphone && <HomeIconCard style={{ marginBottom: 16 }} />}

              <PendingChanges onCount={setPending} />

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
                <Button type="primary" size="large" block icon={<CloudDownloadOutlined />} loading={!!progress} disabled={pending > 0} onClick={download}>
                  {t(meta ? 'offline_update' : 'offline_download')}
                </Button>
                {pending > 0 && (
                  <Typography.Paragraph type="warning" className="offline-hint">
                    {t('offline_update_blocked')}
                  </Typography.Paragraph>
                )}
                {!user && !progress && (
                  <Typography.Paragraph type="secondary" className="offline-hint">
                    {t('offline_download_pin')}
                  </Typography.Paragraph>
                )}
                <DownloadProgress progress={progress} />
                {meta && (
                  <Popconfirm title={pending > 0 ? t('offline_remove_pending', { n: pending }) : t('offline_remove_confirm')} okText={t('delete')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={remove}>
                    <Button danger type="text" icon={<DeleteOutlined />} block style={{ marginTop: 8 }} disabled={!!progress}>
                      {t('offline_remove')}
                    </Button>
                  </Popconfirm>
                )}
              </Card>

              {!iphone && <HomeIconCard style={{ marginTop: 16 }} />}
              <HomeIconDialog open={iconDialog} onClose={() => setIconDialog(false)} />

              <Card title={t('offline_tips_title')} style={{ marginTop: 16 }}>
                <ul className="offline-tips">
                  <li>{t('offline_tip_test')}</li>
                  <li>{t('offline_tip_refresh')}</li>
                  <li>{t('offline_tip_view_only')}</li>
                  <li>{t('offline_tip_pin')}</li>
                  <li>{t('offline_tip_iphone')}</li>
                  {iphone && <li>{t('offline_tip_iphone_scan')}</li>}
                </ul>
              </Card>
            </>
          )}
        </div>
      </Layout.Content>
    </Layout>
  )
}
