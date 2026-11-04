import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Button, InputNumber, Space, Spin, Typography } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import api, { boxUrl } from '../api'
import { useLang } from '../i18n'
import { qrPointsToLocalhost, useSettings } from '../settings'
import QrCode from '../components/QrCode'

const SIZE_KEY = 'box_label_size'
/** Smallest font for the contents list, in mm (about 2.3 pt) */
const MIN_FONT_MM = 0.8

/** Box labels are larger than equipment labels; the size chosen here is remembered on this computer. */
function savedSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY))
    if (saved?.w && saved?.h) return saved
  } catch {
    /* not saved */
  }
  return { w: 100, h: 100 }
}

/**
 * Contents list that shrinks its font (and spreads over up to 3 columns) until every name fits,
 * so a box with many items still lists all of them.
 */
function FittedList({ items, width, height, start }) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const fits = () => node.scrollHeight <= node.clientHeight + 0.5 && node.scrollWidth <= node.clientWidth + 0.5
    // Narrow labels can't take several columns
    const maxCols = Math.max(1, Math.min(3, Math.floor(width / 30)))
    // If nothing fits, the smallest font over the most columns shows the most
    let best = { cols: maxCols, size: MIN_FONT_MM }
    for (let cols = 1; cols <= maxCols; cols++) {
      node.style.columnCount = cols
      let size = start
      node.style.fontSize = `${size}mm`
      while (!fits() && size > MIN_FONT_MM) {
        size = Math.max(MIN_FONT_MM, size * 0.92)
        node.style.fontSize = `${size}mm`
      }
      if (fits() && size > best.size) best = { cols, size }
      if (size >= start) break
    }
    node.style.columnCount = best.cols
    node.style.fontSize = `${best.size}mm`
  }, [items, width, height, start])

  return (
    <ol ref={ref} className="box-label-list">
      {items.map((name, i) => (
        <li key={i}>{name}</li>
      ))}
    </ol>
  )
}

/** One box label: box number on top, QR code in the middle, the names of what is inside below it. */
function BoxLabel({ box, size, url, t }) {
  const { w, h } = size
  const pad = Math.max(2, Math.min(w, h) * 0.04)
  const qr = Math.min(w - pad * 2, h * 0.36)
  const big = Math.min(w, h) * 0.085

  return (
    <div className="label box-label" style={{ width: `${w}mm`, height: `${h}mm`, padding: `${pad}mm` }}>
      <div className="box-label-head" style={{ fontSize: `${big}mm` }}>
        {t('box')} {box.number}
      </div>
      {box.name && (
        <div className="box-label-name" style={{ fontSize: `${big * 0.55}mm` }}>
          {box.name}
        </div>
      )}
      <div className="box-label-qr">
        <QrCode value={url} size={1} style={{ width: `${qr}mm`, height: `${qr}mm` }} />
      </div>
      {box.items.length > 0 && <FittedList items={box.items} width={w - pad * 2} height={h} start={big * 0.5} />}
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
    const onAfterPrint = () => api.post('/labels/printed', { url: base, count: boxes.length }).catch(() => {})
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
        <BoxLabel key={box.id} box={box} size={size} url={boxUrl(settings, box.number)} t={t} />
      ))}
    </div>
  )
}
