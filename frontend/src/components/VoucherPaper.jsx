import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import '../voucherPaper.css'

/*
 * An issue voucher on A5 paper (148 × 210 mm), as the print station prints it and as screens
 * preview it. The template's header and footer repeat on every page; the table of equipment
 * between them is cut into pages by measuring the real rows, and each page is filled to its end
 * with empty rows.
 */

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
/** Numbers are written as on the paper: ١٢٣ */
export const arabicDigits = (value) => String(value ?? '').replace(/[0-9]/g, (d) => AR_DIGITS[d])

const PAGE_WIDTH_MM = 148
const MM = 96 / 25.4 // CSS pixels in a millimetre
/** Placeholders every template can use; a template's own fields are `f:<key>`. */
export const BUILT_IN_FIELDS = ['recipient', 'number', 'date', 'page', 'pages']

/** Takes out what the editor never writes and a printed page must not run. */
function clean(root) {
  root.querySelectorAll('script, style, iframe, object, embed, link, meta, img').forEach((n) => n.remove())
  root.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name)
  })
}

/** The header or footer with its placeholders filled in. */
export function fillHtml(html, values) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  clean(root)
  root.querySelectorAll('[data-field]').forEach((el) => {
    el.textContent = values[el.getAttribute('data-field')] ?? ''
    el.className = 'vp-value'
  })
  return root.innerHTML
}

/** What the placeholders say on one page. */
function valuesFor(voucher, page, pages) {
  const date = voucher.issued_at ? dayjs(voucher.issued_at) : dayjs()
  const values = {
    recipient: voucher.recipient || '',
    number: voucher.number ? arabicDigits(voucher.number) : '',
    date: arabicDigits(date.format('D / M / YYYY')),
    page: arabicDigits(page),
    pages: arabicDigits(pages),
  }
  for (const [key, value] of Object.entries(voucher.fields || {})) values[`f:${key}`] = value || ''
  return values
}

const cellText = (row, key, table) => {
  if (key === 'code') return row.code || (row.accessory ? '' : table.no_code)
  if (key === 'name') return row.name
  if (key === 'quantity') return arabicDigits(row.quantity)
  return row.quantity_words
}

function ItemsTable({ layout, rows, empty = 0, measuring = false }) {
  const table = layout.item_table
  const columns = table.columns.filter((c) => c.show)
  const total = columns.reduce((sum, c) => sum + c.width, 0) || 1
  const quantity = columns.filter((c) => c.key === 'quantity' || c.key === 'quantity_words')
  const grouped = !!table.quantity_group && quantity.length > 0
  const firstQuantity = columns.findIndex((c) => quantity.includes(c))
  return (
    <table className="vp-items">
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={{ width: `${(c.width / total) * 100}%` }} />
        ))}
      </colgroup>
      <thead>
        {grouped ? (
          <>
            <tr>
              {columns.map((c, i) => {
                if (!quantity.includes(c))
                  return (
                    <th key={c.key} rowSpan={2}>
                      {c.title}
                    </th>
                  )
                return i === firstQuantity ? (
                  <th key="group" colSpan={quantity.length}>
                    {table.quantity_group}
                  </th>
                ) : null
              })}
            </tr>
            <tr>
              {quantity.map((c) => (
                <th key={c.key}>{c.title}</th>
              ))}
            </tr>
          </>
        ) : (
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.title}</th>
            ))}
          </tr>
        )}
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.key || i} data-row={measuring ? i : undefined}>
            {columns.map((c) => (
              <td key={c.key} className={`vp-col-${c.key}`}>
                {cellText(row, c.key, table)}
              </td>
            ))}
          </tr>
        ))}
        {Array.from({ length: empty }, (_, i) => (
          <tr key={`empty-${i}`} className="vp-empty">
            {columns.map((c) => (
              <td key={c.key} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const pageStyle = (style) => ({ '--vp-margin': `${style.margin}mm`, '--vp-row': `${style.row_height}mm`, fontSize: `${style.font_size}pt` })

function Page({ layout, voucher, page, pages, children }) {
  const values = valuesFor(voucher, page, pages)
  return (
    <div className="vp-page" style={pageStyle(layout.style)}>
      <div className="vp-html vp-header" dangerouslySetInnerHTML={{ __html: fillHtml(layout.header, values) }} />
      {children}
      <div className="vp-html vp-footer" dangerouslySetInnerHTML={{ __html: fillHtml(layout.footer, values) }} />
    </div>
  )
}

const outerHeight = (el) => {
  if (!el) return 0
  const css = getComputedStyle(el)
  return el.getBoundingClientRect().height + parseFloat(css.marginTop) + parseFloat(css.marginBottom)
}

/** Which rows go on which page, and how many empty rows fill each page, from the measured sizes. */
function planPages(box, count) {
  const page = box.querySelector('.vp-page')
  const css = getComputedStyle(page)
  const inner = page.getBoundingClientRect().height - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)
  // The footer's own height: its top margin is the free space that pushes it to the bottom.
  // A pixel or two to spare: rounding must never push the footer onto a new sheet.
  const footer = box.querySelector('.vp-footer')
  const room = inner - outerHeight(box.querySelector('.vp-header')) - footer.getBoundingClientRect().height - parseFloat(getComputedStyle(footer).marginBottom) - outerHeight(box.querySelector('.vp-items thead')) - 2
  const emptyHeight = box.querySelector('.vp-empty')?.getBoundingClientRect().height || 1
  const heights = [...box.querySelectorAll('tr[data-row]')].map((tr) => tr.getBoundingClientRect().height)

  const pages = []
  let rows = []
  let used = 0
  heights.forEach((height, i) => {
    if (rows.length && used + height > room) {
      pages.push({ rows, used })
      rows = []
      used = 0
    }
    rows.push(i)
    used += height
  })
  pages.push({ rows, used })
  return { pages: pages.map((p) => ({ rows: p.rows, empty: Math.max(0, Math.floor((room - p.used) / emptyHeight)) })), count, room }
}

/**
 * The voucher's pages. `fit` scales them down to the width they are shown in (screens); the
 * print station shows them at their real size. `copies` repeats the whole set.
 * `onPages(n)` is told how many pages it makes.
 */
export default function VoucherPaper({ layout, voucher, rows, copies = 1, fit = true, onPages }) {
  const measure = useRef(null)
  const wrap = useRef(null)
  const [plan, setPlan] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [fontsReady, setFontsReady] = useState(0)
  const signature = JSON.stringify([layout, rows, voucher.recipient, voucher.number, voucher.fields, voucher.issued_at])

  useEffect(() => {
    let alive = true
    document.fonts?.ready.then(() => alive && setFontsReady((n) => n + 1))
    return () => {
      alive = false
    }
  }, [])

  useLayoutEffect(() => {
    if (measure.current) setPlan(planPages(measure.current, rows.length))
  }, [signature, fontsReady, rows.length])

  useEffect(() => {
    if (plan) onPages?.(plan.pages.length)
  }, [plan, onPages])

  useLayoutEffect(() => {
    if (!fit || !wrap.current) return undefined
    const resize = () => setZoom(Math.min(1, wrap.current.clientWidth / (PAGE_WIDTH_MM * MM + 2)))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap.current)
    return () => observer.disconnect()
  }, [fit])

  const pages = plan && plan.count === rows.length ? plan.pages : null
  return (
    <div ref={wrap} className={`vp-wrap${fit ? ' is-fit' : ''}`}>
      {/* Laid out off screen once with every row, to measure */}
      <div ref={measure} className="vp-measure" aria-hidden="true">
        <Page layout={layout} voucher={voucher} page={1} pages={9}>
          <ItemsTable layout={layout} rows={rows} empty={1} measuring />
        </Page>
      </div>
      {pages && (
        <div className="vp-sheets" style={fit ? { zoom } : undefined}>
          {Array.from({ length: copies }, (_, copy) =>
            pages.map((page, i) => (
              <Page key={`${copy}-${i}`} layout={layout} voucher={voucher} page={i + 1} pages={pages.length}>
                <ItemsTable layout={layout} rows={page.rows.map((r) => rows[r])} empty={page.empty} />
              </Page>
            )),
          )}
        </div>
      )}
    </div>
  )
}
