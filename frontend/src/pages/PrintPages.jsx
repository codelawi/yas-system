import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Button, Checkbox, Result, Spin, Tooltip } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { equipmentUrl } from '../api'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import QrCode from '../components/QrCode'
import { filterLabel } from '../components/FieldFilter'
import { ElementContent } from '../components/TemplateLabel'
import { formElementText, loadFormPages } from '../custodyForm'

/** Opens the print dialog once everything (fonts, QR) is ready. "Save as PDF" makes the PDF. */
function useAutoPrint(ready) {
  const done = useRef(false)
  useEffect(() => {
    if (!ready || done.current) return
    done.current = true
    document.fonts.ready.then(() => setTimeout(() => window.print(), 400))
  }, [ready])
}

function PrintToolbar() {
  const { t } = useLang()
  return (
    <div className="no-print print-toolbar">
      <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
        {t('print_pdf')}
      </Button>
    </div>
  )
}

/** A4 data sheet of one equipment. */
export function PrintSheet() {
  const { id } = useParams()
  const { t, dir } = useLang()
  const { settings } = useSettings()
  const [eq, setEq] = useState(null)
  const [dates, setDates] = useState([])
  const [qrReady, setQrReady] = useState(false)

  useEffect(() => {
    api.get(`/equipment/${id}`).then(({ data }) => setEq(data))
    api.get(`/equipment/${id}/maintenance`).then(({ data }) => setDates(data.schedules))
  }, [id])
  useAutoPrint(eq && qrReady)

  if (!eq) return <Spin size="large" className="page-spin" />

  return (
    <div className="print-page" dir={dir}>
      <style>{'@page { size: A4; margin: 14mm; }'}</style>
      <PrintToolbar />
      <header className="print-head">
        <div>
          {settings.company_name && <div className="print-company">{settings.company_name}</div>}
          <h1 className="serial">{eq.serial_number}</h1>
          <div className="print-sub">
            {[eq.name, eq.category, eq.row_no != null && `${t('row_no')} ${eq.row_no}`, eq.parent && `${t('accessory_of')} ${eq.parent.serial_number}`].filter(Boolean).join(' · ')}
          </div>
        </div>
        <QrCode value={equipmentUrl(settings, eq.serial_number)} size={110} onReady={() => setQrReady(true)} />
      </header>

      <h2>{t('details')}</h2>
      <table className="print-table">
        <tbody>
          {eq.fields.map((f, i) => (
            <tr key={i}>
              <th>{f.key}</th>
              <td>{f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {eq.accessories?.length > 0 && (
        <>
          <h2>
            {t('accessories')} ({eq.accessories.length})
          </h2>
          <table className="print-table">
            <thead>
              <tr>
                <th>{t('name_field')}</th>
                <th>{t('serial_number')}</th>
              </tr>
            </thead>
            <tbody>
              {eq.accessories.map((a) => (
                <tr key={a.id}>
                  <td>{a.name || '—'}</td>
                  <td className="serial">{a.serial_number}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {dates.length > 0 && (
        <>
          <h2>{t('maintenance')}</h2>
          <table className="print-table">
            <tbody>
              {dates.map((d) => (
                <tr key={d.id}>
                  <th>{d.title}</th>
                  <td>
                    {dayjs(d.due_date).format('YYYY-MM-DD')}
                    {d.interval_months ? ` · ${t('every_n_months', { n: d.interval_months })}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <footer className="print-foot">
        {t('printed_at')}: {dayjs().format('YYYY-MM-DD HH:mm')}
      </footer>
    </div>
  )
}

/** The equipment list (same search / filters as on screen), landscape. */
export function PrintList() {
  const { t, dir } = useLang()
  const { settings } = useSettings()
  const [params] = useSearchParams()
  const [items, setItems] = useState(null)

  useEffect(() => {
    const query = Object.fromEntries(params)
    ;(async () => {
      const all = []
      for (let page = 1; page <= 10; page++) {
        const { data } = await api.get('/equipment', { params: { ...query, page, per_page: 200 } })
        all.push(...data.data)
        if (page >= data.last_page) break
      }
      setItems(all)
    })()
  }, [params])
  useAutoPrint(!!items)

  if (!items) return <Spin size="large" className="page-spin" />

  let filters = []
  try {
    filters = JSON.parse(params.get('filters') || '[]')
  } catch {
    /* ignore */
  }

  return (
    <div className="print-page wide" dir={dir}>
      <style>{'@page { size: A4 landscape; margin: 10mm; }'}</style>
      <PrintToolbar />
      <header className="print-head">
        <div>
          {settings.company_name && <div className="print-company">{settings.company_name}</div>}
          <h1>{t('print_list_title')}</h1>
          <div className="print-sub">
            {items.length} · {[params.get('q'), ...filters.map((f) => filterLabel(f, t))].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="print-sub">
          {t('printed_at')}: {dayjs().format('YYYY-MM-DD HH:mm')}
        </div>
      </header>
      <table className="print-table list">
        <thead>
          <tr>
            <th>{t('row_no')}</th>
            <th>{t('serial_number')}</th>
            <th>{t('name_field')}</th>
            <th>{t('accessories')}</th>
            <th>{t('fields')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>{e.row_no ?? ''}</td>
              <td className="serial">{e.serial_number}</td>
              <td>{e.display_name}</td>
              <td>{e.parent ? `↳ ${e.parent.serial_number}` : e.accessories_count || ''}</td>
              <td className="print-fields">
                {e.fields.map((f) => `${f.key}: ${String(f.value).split('\n')[0]}`).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Custody form (PDF/image) filled for one hand-over, page by page at the form's real size. */
export function PrintCustodyForm() {
  const { custodyId } = useParams()
  const [params] = useSearchParams()
  const { t } = useLang()
  const { settings } = useSettings()
  const [form, setForm] = useState(null)
  const [data, setData] = useState(null)
  const [pages, setPages] = useState(null)
  const [failed, setFailed] = useState(false)
  const [background, setBackground] = useState(true)
  const [qrDone, setQrDone] = useState(0)

  useEffect(() => {
    Promise.all([api.get('/custody-forms'), api.get(`/custodies/${custodyId}/form-data`)])
      .then(([forms, values]) => {
        const chosen = forms.data.find((f) => String(f.id) === params.get('form')) || forms.data.find((f) => f.is_default)
        if (!chosen) throw new Error('no form')
        setForm(chosen)
        setData(values.data)
        return loadFormPages(chosen, 3)
      })
      .then(setPages)
      .catch(() => setFailed(true))
  }, [custodyId, params])

  const elements = form?.layout?.elements || []
  const qrCount = elements.filter((el) => el.type === 'qr').length
  useAutoPrint(pages && qrDone >= qrCount)

  if (failed) return <Result status="warning" title={t('cf_load_failed')} />
  if (!pages) return <Spin size="large" className="page-spin" />

  const url = equipmentUrl(settings, data.serial_number)
  const first = pages[0]

  return (
    <div className="cf-print">
      <style>{`@page { size: ${first.w}mm ${first.h}mm; margin: 0; }`}</style>
      <div className="no-print print-toolbar" style={{ gap: 16, alignItems: 'center' }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('print_pdf')}
        </Button>
        <Tooltip title={t('cf_print_bg_help')}>
          <Checkbox checked={background} onChange={(e) => setBackground(e.target.checked)}>
            {t('cf_print_bg')}
          </Checkbox>
        </Tooltip>
      </div>
      {pages.map((page, i) => (
        <div key={i} className="tlabel cf-page" dir="ltr" style={{ width: `${page.w}mm`, height: `${page.h}mm` }}>
          {background && <img className="cf-bg" src={page.src} alt="" />}
          {elements
            .filter((el) => el.page === i)
            .map((el) => (
              <div key={el.id} className="tl-el" style={{ left: `${el.x}mm`, top: `${el.y}mm`, width: `${el.w}mm`, height: `${el.h}mm` }}>
                <ElementContent el={el} url={url} value={formElementText(el, data)} onReady={() => setQrDone((n) => n + 1)} />
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}
