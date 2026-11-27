import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Button, InputNumber, Space, Spin, Typography } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import api, { boxUrl } from '../api'
import { useLang } from '../i18n'
import { qrPointsToLocalhost, useSettings } from '../settings'
import QrCode from '../components/QrCode'

const SIZE_KEY = 'box_label_size'

/** The label size chosen here is remembered on this computer. */
function savedSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY))
    if (saved?.w && saved?.h) return saved
  } catch {
    /* not saved */
  }
  return { w: 100, h: 100 }
}

/** One box label: only the QR code, as large as the label allows, in the middle. */
function BoxLabel({ size, url }) {
  const { w, h } = size
  const pad = Math.max(2, Math.min(w, h) * 0.04)
  const qr = Math.min(w, h) - pad * 2

  return (
    <div className="label box-label" style={{ width: `${w}mm`, height: `${h}mm` }}>
      <QrCode value={url} size={1} style={{ width: `${qr}mm`, height: `${qr}mm` }} />
    </div>
  )
}

/** Print page for box labels: one label per page. The label size is chosen here and remembered on this computer. */
export default function BoxLabelsPrint() {
  const { t } = useLang()
  const { settings } = useSettings()
  const [params] = useSearchParams()
  const [boxes, setBoxes] = useState(null)
  const [size, setSize] = useState(savedSize)

  useEffect(() => {
    const ids = (params.get('ids') || '').split(',').filter(Boolean)
    api.get('/boxes/labels', { params: { ids } }).then(({ data }) => setBoxes(data))
  }, [params])

  // Count labels per QR address, so the address can't be changed by accident later
  useEffect(() => {
    if (!boxes?.length) return
    const base = boxUrl(settings, 'x').replace(/\/box\/x$/, '')
    // Printed labels also leave the dashboard's «waiting for a label» list
    const onAfterPrint = () => api.post('/labels/printed', { url: base, count: boxes.length, box_ids: boxes.map((box) => box.id) }).catch(() => {})
    window.addEventListener('afterprint', onAfterPrint)
    return () => window.removeEventListener('afterprint', onAfterPrint)
  }, [boxes, settings])

  const changeSize = (key, value) => {
    if (!value) return
    const next = { ...size, [key]: value }
    setSize(next)
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(next))
    } catch {
      /* not remembered */
    }
  }

  if (!boxes) return <Spin size="large" className="page-spin" />

  return (
    <div className="labels-page">
      <style>{`@page { size: ${size.w}mm ${size.h}mm; margin: 0; }`}</style>
      <div className="no-print labels-toolbar">
        {qrPointsToLocalhost(settings) && <Alert type="warning" showIcon title={t('localhost_warning')} />}
        <Space wrap>
          <Typography.Text>{t('box_label_size')}</Typography.Text>
          <InputNumber min={20} max={300} value={size.w} onChange={(v) => changeSize('w', v)} suffix="mm" style={{ width: 110 }} />
          ×
          <InputNumber min={20} max={300} value={size.h} onChange={(v) => changeSize('h', v)} suffix="mm" style={{ width: 110 }} />
        </Space>
        <Button type="primary" size="large" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('print')} ({boxes.length})
        </Button>
      </div>
      {boxes.map((box) => (
        <BoxLabel key={box.id} size={size} url={boxUrl(settings, box.number)} />
      ))}
    </div>
  )
}
