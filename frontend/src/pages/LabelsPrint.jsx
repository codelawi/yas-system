import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Button, Spin } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import api, { equipmentUrl } from '../api'
import { useLang } from '../i18n'
import { qrPointsToLocalhost, useSettings } from '../settings'
import TemplateLabel from '../components/TemplateLabel'
import { templateFrom } from '../labelTemplate'

/** Print page for label printers: one label per page, page size = label size, drawn from the saved design. */
export default function LabelsPrint() {
  const { t } = useLang()
  const { settings } = useSettings()
  const [params] = useSearchParams()
  const [items, setItems] = useState(null)
  const loaded = useRef(0)
  const printed = useRef(false)

  const ready = !!settings.label_width_mm
  const template = ready ? templateFrom(settings) : null
  const qrPerLabel = template ? template.elements.filter((e) => e.type === 'qr').length : 0

  // Count labels per QR address, so the address can't be changed by accident later
  useEffect(() => {
    if (!items?.length || !ready) return
    const base = equipmentUrl(settings, 'x').replace(/\/eq\/x$/, '')
    // Printed labels also leave the dashboard's «waiting for a label» list
    const onAfterPrint = () => api.post('/labels/printed', { url: base, count: items.length, equipment_ids: items.map((eq) => eq.id) }).catch(() => {})
    window.addEventListener('afterprint', onAfterPrint)
    return () => window.removeEventListener('afterprint', onAfterPrint)
  }, [items, settings, ready])

  useEffect(() => {
    const ids = (params.get('ids') || '').split(',').filter(Boolean)
    api.get('/equipment/labels', { params: { ids } }).then(({ data }) => setItems(data))
  }, [params])

  const printOnce = () => {
    if (printed.current) return
    printed.current = true
    // The label fonts are bundled; make sure they are loaded before printing
    document.fonts.ready.then(() => setTimeout(() => window.print(), 300))
  }

  // A design without any QR code has nothing to wait for
  useEffect(() => {
    if (items?.length && ready && qrPerLabel === 0) printOnce()
  }, [items, ready, qrPerLabel])

  const onReady = () => {
    loaded.current += 1
    if (items && loaded.current >= items.length * qrPerLabel) printOnce()
  }

  if (!items || !ready) return <Spin size="large" className="page-spin" />

  return (
    <div className="labels-page">
      <style>{`@page { size: ${template.width}mm ${template.height}mm; margin: 0; }`}</style>
      <div className="no-print labels-toolbar">
        {qrPointsToLocalhost(settings) && <Alert type="warning" showIcon title={t('localhost_warning')} />}
        <Button type="primary" size="large" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('print')} ({items.length})
        </Button>
      </div>
      {items.map((eq) => (
        <TemplateLabel key={eq.id} template={template} equipment={eq} url={equipmentUrl(settings, eq.serial_number)} settings={settings} onReady={onReady} />
      ))}
    </div>
  )
}
