import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Result, Spin } from 'antd'
import { ArrowRightOutlined, ClusterOutlined, InboxOutlined, PictureOutlined, PrinterOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { boxUrl } from '../api'
import { useLang } from '../i18n'
import { useSettings } from '../settings'
import QrCode from '../components/QrCode'

/** The box's contents split by group (main equipment followed by its accessories); ungrouped last. */
function sections(items) {
  const map = new Map()
  for (const eq of items) {
    const key = eq.group ? eq.group.id : 'none'
    if (!map.has(key)) map.set(key, { group: eq.group, items: [] })
    map.get(key).items.push(eq)
  }
  return [...map.values()].sort((a, b) => (a.group ? 0 : 1) - (b.group ? 0 : 1))
}

function ItemCard({ eq, no, t }) {
  return (
    <article className={`br-item${eq.parent ? ' br-item-accessory' : ''}`}>
      <div className="br-photo">
        {eq.photo_url ? <img src={eq.photo_url} alt="" /> : <PictureOutlined />}
      </div>
      <div className="br-item-body">
        <header className="br-item-head">
          <span className="br-no">{no}</span>
          <span className="br-item-name">{eq.display_name || eq.serial_number}</span>
          <span className="br-serial">{eq.serial_number}</span>
        </header>
        {eq.parent && (
          <div className="br-parent">
            ↳ {t('accessory_of')} {eq.parent.name || eq.parent.serial_number}
          </div>
        )}
        {eq.fields?.length > 0 && (
          <dl className="br-fields">
            {eq.fields.map((f, i) => (
              <div key={i} className="br-field">
                <dt>{f.key}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <span className="br-check" title={t('report_checked')} />
    </article>
  )
}

/**
 * Printable A4 sheet of a box: box information, QR code, then every equipment inside
 * (photo and all details), split by group, with a tick box per item and signatures.
 */
export default function BoxReport() {
  const { id } = useParams()
  const { t } = useLang()
  const { settings } = useSettings()
  const [box, setBox] = useState(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    api
      .get(`/boxes/${id}`)
      .then(({ data }) => setBox(data))
      .catch(() => setMissing(true))
  }, [id])

  useEffect(() => {
    if (box) document.title = `${t('report_title')} — ${t('box')} ${box.number}`
  }, [box, t])

  if (missing) return <Result status="404" title={t('box_not_found')} />
  if (!box) return <Spin size="large" className="page-spin" />

  const parts = sections(box.equipment)
  const groupCount = parts.filter((p) => p.group).length
  const mainCount = box.equipment.filter((e) => !e.parent).length
  let no = 0

  return (
    <div className="br-page">
      <div className="no-print br-toolbar">
        <Button icon={<ArrowRightOutlined />} onClick={() => window.close()}>
          {t('close')}
        </Button>
        <Button type="primary" size="large" icon={<PrinterOutlined />} onClick={() => window.print()}>
          {t('print')}
        </Button>
      </div>

      <div className="br-sheet">
        <header className="br-header">
          <div className="br-header-text">
            {settings.company_name && <div className="br-company">{settings.company_name}</div>}
            <h1 className="br-title">{t('report_title')}</h1>
            <div className="br-date">
              {t('report_printed_at')} {dayjs().format('YYYY-MM-DD  HH:mm')}
            </div>
          </div>
          <div className="br-qr">
            <QrCode value={boxUrl(settings, box.number)} size={1} style={{ width: '24mm', height: '24mm' }} />
            <span>{t('report_scan')}</span>
          </div>
        </header>

        <section className="br-hero">
          <div className="br-boxno">
            <InboxOutlined />
            <span className="br-boxno-label">{t('box')}</span>
            <span className="br-boxno-value">{box.number}</span>
          </div>
          <div className="br-hero-info">
            {box.name && <div className="br-boxname">{box.name}</div>}
            <div className="br-stats">
              <div className="br-stat br-stat-weight">
                <span className="br-stat-label">{t('weight')}</span>
                <span className="br-stat-value">
                  {box.weight != null ? (
                    <>
                      {Number(box.weight).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                      <small>{t('kg')}</small>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              <div className="br-stat">
                <span className="br-stat-label">{t('report_items')}</span>
                <span className="br-stat-value">
                  {mainCount}
                  <small>{t('items_word')}</small>
                </span>
              </div>
              {box.equipment.length > mainCount && (
                <div className="br-stat">
                  <span className="br-stat-label">{t('accessories')}</span>
                  <span className="br-stat-value">{box.equipment.length - mainCount}</span>
                </div>
              )}
              {groupCount > 0 && (
                <div className="br-stat">
                  <span className="br-stat-label">{t('groups')}</span>
                  <span className="br-stat-value">{groupCount}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        {box.equipment.length === 0 && <p className="br-empty">{t('box_empty')}</p>}

        {parts.map((part) => (
          <section key={part.group ? part.group.id : 'none'} className="br-section">
            {groupCount > 0 && (
              <h2 className="br-section-head">
                <ClusterOutlined />
                <span>{part.group ? part.group.name : t('no_group')}</span>
                <span className="br-section-count">{t('n_items', { n: part.items.length })}</span>
              </h2>
            )}
            <div className="br-items">
              {part.items.map((eq) => (
                <ItemCard key={eq.id} eq={eq} no={++no} t={t} />
              ))}
            </div>
          </section>
        ))}

        <footer className="br-signatures">
          {['report_handed_by', 'report_received_by', 'report_stamp'].map((key) => (
            <div key={key} className="br-signature">
              <span className="br-signature-label">{t(key)}</span>
              <span className="br-signature-line" />
              <span className="br-signature-hint">{t(key === 'report_stamp' ? 'report_date' : 'report_name_signature')}</span>
            </div>
          ))}
        </footer>
      </div>
    </div>
  )
}
