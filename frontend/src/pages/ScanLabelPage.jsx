import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Input, Layout, Tag, Typography } from 'antd'
import { AppstoreOutlined, CameraOutlined, GlobalOutlined } from '@ant-design/icons'
import jsQR from 'jsqr'
import api from '../api'
import { useLang } from '../i18n'
import { beep } from '../download'
import CodeScanner from '../components/CodeScanner'
import { noOfflineCopy } from '../components/OfflineBanner'
import { SCAN_AGAIN_EVENT } from '../components/PhoneShell'

/**
 * The page a system label opens (/eq/<serial>, /box/<number>, /item/<id>), whatever address
 * it was printed with. Null for any other code, such as a maker's Data Matrix on the equipment.
 */
export function labelPath(text) {
  try {
    const match = new URL(String(text).trim()).pathname.match(/\/(eq|box|item)\/([^/?#]+)/)
    if (match && (match[1] !== 'item' || /^\d+$/.test(match[2]))) return `/${match[1]}/${match[2]}`
  } catch {
    /* not a link */
  }
  return null
}

/** The phone page of something the lookup found. Accessories open by id: their serial may repeat or be empty. */
export const matchPath = (m) =>
  m.type === 'box'
    ? `/box/${encodeURIComponent(m.number)}`
    : m.parent || !m.serial_number
      ? `/item/${m.id}`
      : `/eq/${encodeURIComponent(m.serial_number)}`

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

/** Long codes are cut on screen, and kept apart from the Arabic text around them (left to right, in one piece). */
const shortCode = (code) => `\u2068${code.length > 40 ? `${code.slice(0, 40)}…` : code}\u2069`

/**
 * Scans a code and opens what it belongs to. The camera opens at once: live on https, a photo on
 * plain http. A system QR label opens its page; any other code (QR or Data Matrix, e.g. printed on
 * the equipment by its maker) is looked up in serial numbers, every field and boxes. Works without
 * a connection from the copy saved on the phone (the service worker answers /api/lookup).
 */
export default function ScanLabelPage() {
  const { t, toggle } = useLang()
  const navigate = useNavigate()
  const [scanning, setScanning] = useState(true)
  const [result, setResult] = useState(null) // { code, matches }: several matches, or none for a typed code
  const [error, setError] = useState(null)
  const [searching, setSearching] = useState(false)
  const [typed, setTyped] = useState('')

  /** Opens the page when there is exactly one; otherwise returns what was found. */
  const resolve = async (code) => {
    const path = labelPath(code)
    if (path) {
      navigate(path)
      return null
    }
    const { data } = await api.get('/lookup', { params: { code } })
    if (data.matches.length === 1) {
      navigate(matchPath(data.matches[0]))
      return null
    }
    return data
  }

  /** Each code the camera reads. The answer is shown on the camera screen, which stays open. */
  const onCode = async (code) => {
    try {
      const found = await resolve(code)
      if (!found) {
        beep(true)
        return null
      }
      if (found.matches.length) {
        beep(true)
        setResult(found)
        setScanning(false)
        return null
      }
      beep(false)
      return { type: 'error', text: t('scan_lookup_none', { code: shortCode(found.code) }) }
    } catch (e) {
      beep(false)
      return { type: 'error', text: t(noOfflineCopy(e) ? 'offline_no_data_hint' : 'error') }
    }
  }

  const search = async (value) => {
    const code = value.trim()
    if (!code) return
    setSearching(true)
    setError(null)
    setResult(null)
    try {
      const found = await resolve(code)
      if (found) setResult(found)
    } catch (e) {
      setError(noOfflineCopy(e) ? 'offline_no_data_hint' : 'error')
    } finally {
      setSearching(false)
    }
  }

  const startScan = () => {
    setResult(null)
    setError(null)
    setScanning(true)
  }

  // Phones: tapping the scan tab again opens the camera again
  useEffect(() => {
    window.addEventListener(SCAN_AGAIN_EVENT, startScan)
    return () => window.removeEventListener(SCAN_AGAIN_EVENT, startScan)
  }, [])

  const where = (m) => {
    if (m.type === 'box') return m.match.by === 'number' ? t('box_number') : t('box_name')
    return m.match.by === 'field' ? m.match.key : t('serial_number')
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
            <Button type="primary" size="large" block icon={<CameraOutlined />} onClick={startScan}>
              {t('scan_open_camera')}
            </Button>
          </Card>

          {result && (
            <Card title={t('scan_lookup_results', { code: shortCode(result.code) })} style={{ marginTop: 16 }}>
              {result.matches.length ? (
                <div className="accessory-list">
                  {result.matches.map((m) => (
                    <Link key={`${m.type}-${m.id}`} to={matchPath(m)} className="accessory-item">
                      <span className="accessory-name">{m.type === 'box' ? m.name || `${t('box')} ${m.number}` : m.display_name || '—'}</span>
                      {(m.type === 'box' || m.parent) && <Tag className="scan-match-kind">{m.type === 'box' ? t('box') : t('accessory')}</Tag>}
                      <span className="serial">{m.type === 'box' ? m.number : m.serial_number || '—'}</span>
                      <Typography.Text type="secondary" className="accessory-extra">
                        {[m.parent && `${t('accessory_of')} ${m.parent.display_name || m.parent.serial_number}`, t('scan_match_in', { where: where(m) })]
                          .filter(Boolean)
                          .join(' · ')}
                      </Typography.Text>
                    </Link>
                  ))}
                </div>
              ) : (
                <Alert type="warning" showIcon title={t('scan_lookup_none', { code: shortCode(result.code) })} />
              )}
            </Card>
          )}

          <Card style={{ marginTop: 16 }}>
            <Typography.Text strong>{t('scan_manual')}</Typography.Text>
            <Input.Search
              dir="ltr"
              size="large"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onSearch={search}
              loading={searching}
              enterButton={t('scan_open')}
              placeholder="LKS-2018-001"
              style={{ marginTop: 8 }}
            />
            {error && <Alert type="error" showIcon title={t(error)} style={{ marginTop: 12 }} />}
          </Card>
        </div>
      </Layout.Content>
      <CodeScanner open={scanning} onClose={() => setScanning(false)} onCode={onCode} title={t('scan_title')} />
    </Layout>
  )
}
