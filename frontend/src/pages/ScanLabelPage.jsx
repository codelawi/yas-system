import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Input, Layout, Spin, Typography } from 'antd'
import { AppstoreOutlined, CameraOutlined, GlobalOutlined } from '@ant-design/icons'
import jsQR from 'jsqr'
import { useLang } from '../i18n'

/** Serial number inside a QR text: the /eq/<serial> part of any link (whatever its address), or the plain text. */
export function serialFromQr(text) {
  const value = String(text || '').trim()
  try {
    const match = new URL(value).pathname.match(/\/eq\/([^/?#]+)/)
    if (match) return decodeURIComponent(match[1])
  } catch {
    /* not a link */
  }
  return value
}

/** Reads a QR code from a photo, trying a few sizes (big photos are slow, small QR codes need detail). */
export async function decodePhoto(file) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  for (const max of [1200, 800, 1800, 2600]) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })
    if (code?.data) return code.data
  }
  return null
}

/**
 * Opens equipment from a photo of its label. Works on plain http (no live camera
 * needed) and with labels printed with any old address.
 */
export default function ScanLabelPage() {
  const { t, toggle } = useLang()
  const navigate = useNavigate()
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [preview, setPreview] = useState(null)
  const [serial, setSerial] = useState('')

  const open = (s) => s && navigate(`/eq/${encodeURIComponent(s)}`)

  const onPhoto = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setFailed(false)
    setBusy(true)
    setPreview(URL.createObjectURL(file))
    try {
      const text = await decodePhoto(file)
      if (text) open(serialFromQr(text))
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
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
            <CameraOutlined /> {t('scan_title')}
          </Typography.Title>
          <Card>
            <Typography.Paragraph type="secondary">{t('scan_help')}</Typography.Paragraph>
            <input ref={input} type="file" accept="image/*" capture="environment" onChange={onPhoto} hidden />
            <Button type="primary" size="large" block icon={<CameraOutlined />} loading={busy} onClick={() => input.current?.click()}>
              {t('scan_take_photo')}
            </Button>
            {busy && <Spin style={{ display: 'block', marginTop: 16 }} />}
            {failed && <Alert type="error" showIcon title={t('scan_failed')} style={{ marginTop: 16 }} />}
            {preview && <img src={preview} alt="" className="scan-preview" />}
          </Card>
          <Card style={{ marginTop: 16 }}>
            <Typography.Text strong>{t('scan_manual')}</Typography.Text>
            <Input.Search
              dir="ltr"
              size="large"
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              onSearch={(v) => open(v.trim())}
              enterButton={t('scan_open')}
              placeholder="LKS-2018-001"
              style={{ marginTop: 8 }}
            />
          </Card>
        </div>
      </Layout.Content>
    </Layout>
  )
}
