import { useEffect, useRef, useState } from 'react'
import { Button, Tag } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, PrinterOutlined, StopOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api'
import { useLang } from '../i18n'
import { beep } from '../download'
import VoucherPaper from '../components/VoucherPaper'

/*
 * The print station: open on the laptop in its own browser window (START.bat or START.command starts it with silent
 * printing), it prints each issued voucher on the default printer by itself. A voucher waits a
 * few seconds first, so it can be cancelled. No PIN: the START script gives it a key in the address.
 */

const COUNTDOWN = 5
const KEY = 'print_station_key'
const WINDOW = 'print_station_window'

const stored = (storage, name) => {
  try {
    return storage.getItem(name)
  } catch {
    return null
  }
}
const store = (storage, name, value) => {
  try {
    storage.setItem(name, value)
  } catch {
    // private window: kept for this page only
  }
}

/** The key from the address (then taken out of it), else the one kept from before. */
function stationKey() {
  const url = new URL(window.location.href)
  const key = url.searchParams.get('key')
  if (key) {
    store(localStorage, KEY, key)
    url.searchParams.delete('key')
    window.history.replaceState(null, '', url.pathname + url.search)
    return key
  }
  return stored(localStorage, KEY)
}

/** This window, so the server lets only one station window print. */
function windowId() {
  let id = stored(sessionStorage, WINDOW)
  if (!id) {
    id = Math.random().toString(36).slice(2, 12)
    store(sessionStorage, WINDOW, id)
  }
  return id
}

export default function PrintStationPage() {
  const { t } = useLang()
  const [key] = useState(stationKey)
  const [win] = useState(windowId)
  const [status, setStatus] = useState(key ? 'starting' : 'bad_key') // ready | duplicate | bad_key | no_server
  const [job, setJob] = useState(null)
  const [left, setLeft] = useState(COUNTDOWN)
  const [pages, setPages] = useState(0)
  const [printing, setPrinting] = useState(false)
  const [log, setLog] = useState([])
  const busy = useRef(false)

  useEffect(() => {
    document.title = t('ps_title')
  }, [t])

  const call = (method, url) => api.request({ method, url, headers: { 'X-Station-Key': key }, params: method === 'get' ? { window: win } : undefined })

  // Ask for work every second or two; asking is also how phones know the station is open
  useEffect(() => {
    if (!key) return undefined
    let alive = true
    let timer
    const tick = async () => {
      let wait = 1500
      try {
        const { data } = await api.get('/print-station/next', { headers: { 'X-Station-Key': key }, params: { window: win } })
        if (!alive) return
        if (data.duplicate) {
          setStatus('duplicate')
          wait = 3000
        } else {
          setStatus('ready')
          if (data.job && !busy.current) {
            busy.current = true
            setPages(0)
            setLeft(COUNTDOWN)
            setJob(data.job)
            beep(true)
          }
        }
      } catch (e) {
        if (!alive) return
        setStatus(e.response?.status === 403 ? 'bad_key' : 'no_server')
        wait = e.response?.status === 403 ? 10000 : 3000
      }
      timer = setTimeout(tick, wait)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [key, win])

  const record = (status) => setLog((list) => [{ id: job.id, number: job.voucher.number, recipient: job.voucher.recipient, copies: job.copies, status, at: dayjs() }, ...list].slice(0, 30))
  const finish = () => {
    setJob(null)
    setPrinting(false)
    busy.current = false
  }

  const printNow = async () => {
    if (!job || printing) return
    setPrinting(true)
    // Let the pages paint first
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    window.print()
    try {
      await call('post', `/print-station/jobs/${job.id}/printed`)
    } catch {
      // printed anyway; the phone just keeps "waiting"
    }
    record('printed')
    finish()
  }

  const cancel = async () => {
    if (!job || printing) return
    try {
      await call('post', `/print-station/jobs/${job.id}/cancel`)
    } catch {
      // nothing printed either way
    }
    record('cancelled')
    finish()
  }

  // The countdown; at zero it prints once the pages are laid out
  const latestPrint = useRef(printNow)
  useEffect(() => {
    latestPrint.current = printNow
  })
  useEffect(() => {
    if (!job || printing || (left <= 0 && !pages)) return undefined
    const timer = setTimeout(() => (left > 0 ? setLeft(left - 1) : latestPrint.current()), left > 0 ? 1000 : 50)
    return () => clearTimeout(timer)
  }, [job, left, pages, printing])

  const statusLine = {
    starting: { tone: 'wait', text: t('ps_starting') },
    ready: { tone: 'ok', text: t('ps_ready') },
    duplicate: { tone: 'warn', text: t('ps_duplicate') },
    bad_key: { tone: 'bad', text: t('ps_bad_key') },
    no_server: { tone: 'bad', text: t('ps_no_server') },
  }[status]

  return (
    <div className="ps-page" dir="rtl">
      <div className="ps-screen">
        <header className="ps-head">
          <PrinterOutlined className="ps-head-icon" />
          <div>
            <h1>{t('ps_title')}</h1>
            <div className={`ps-status is-${statusLine.tone}`}>
              <span className="ps-dot" />
              {statusLine.text}
            </div>
          </div>
        </header>

        {job ? (
          <section className="ps-job">
            <div className="ps-job-text">
              <div className="ps-job-title">{t('ps_about_to_print', { n: job.voucher.number })}</div>
              <div className="ps-job-sub">{job.voucher.recipient}</div>
              <div className="ps-job-sub">{[t('ps_copies_n', { n: job.copies }), pages ? t('ps_pages_n', { n: pages }) : null].filter(Boolean).join(' · ')}</div>
              <div className="ps-count" aria-live="polite">
                {printing ? t('ps_printing') : Math.max(left, 0)}
              </div>
              <div className="ps-actions">
                <Button size="large" danger icon={<StopOutlined />} onClick={cancel} disabled={printing}>
                  {t('ps_cancel')}
                </Button>
                <Button size="large" type="primary" icon={<PrinterOutlined />} onClick={() => setLeft(0)} disabled={printing || left <= 0}>
                  {t('ps_print_now')}
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <section className="ps-idle">
            <PrinterOutlined className="ps-idle-icon" />
            <p>{t('ps_idle')}</p>
            <p className="ps-muted">{t('ps_paper_hint')}</p>
          </section>
        )}

        {log.length > 0 && (
          <section className="ps-log">
            <h2>{t('ps_log')}</h2>
            {log.map((entry) => (
              <div key={`${entry.id}-${entry.status}`} className="ps-log-row">
                {entry.status === 'printed' ? <CheckCircleFilled className="ps-ok" /> : <CloseCircleFilled className="ps-bad" />}
                <span>{t('ps_log_voucher', { n: entry.number })}</span>
                <span className="ps-muted">{entry.recipient}</span>
                <Tag>{entry.status === 'printed' ? t('ps_copies_n', { n: entry.copies }) : t('ps_cancelled')}</Tag>
                <span className="ps-muted">{entry.at.format('HH:mm')}</span>
              </div>
            ))}
          </section>
        )}
      </div>

      {/* What prints: the pages at their real size (shown small on screen) */}
      {job && (
        <div className="ps-paper">
          <VoucherPaper key={job.id} layout={job.layout} voucher={job.voucher} rows={job.rows} copies={job.copies} onPages={setPages} />
        </div>
      )}
    </div>
  )
}
