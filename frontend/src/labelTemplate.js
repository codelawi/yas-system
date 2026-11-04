// Label design: a list of elements placed in millimetres on the label.
// Saved as JSON in the "label_template" setting; '' means "use the default design".

/** Values that exist for every equipment (fields from Word are 'field:<key>'). */
export const BUILTIN_SOURCES = ['serial_number', 'display_name', 'row_no', 'parent_serial', 'category', 'company']

const truthy = (v) => v !== '0' && v !== false && v !== 0

let counter = 0
export const newId = () => `el${Date.now().toString(36)}${(counter++).toString(36)}`

const round = (v) => Math.round(v * 2) / 2

/** The design used when nothing was saved: same layout as the original labels. */
export function defaultTemplate(settings, width, height) {
  const w = Number(width ?? settings.label_width_mm) || 50
  const h = Number(height ?? settings.label_height_mm) || 30
  const pad = Math.max(1.5, Math.min(w, h) * 0.06)
  const rows = [
    truthy(settings.label_show_row_no ?? '1') && { source: 'row_no', size: 0.085, bold: true },
    truthy(settings.label_show_company ?? '1') && settings.company_name && { source: 'company', size: 0.08 },
    { source: 'serial_number', size: 0.16, bold: true, mono: true },
    truthy(settings.label_show_name ?? '1') && { source: 'display_name', size: 0.085 },
    truthy(settings.label_show_parent ?? '1') && { source: 'parent_serial', prefix: '↳ ', size: 0.07 },
  ].filter(Boolean)

  const elements = []
  const stacked = h >= w * 0.8
  if (stacked) {
    // QR on top, text below
    const lineH = h * 0.085
    const qr = round(Math.min(w - pad * 2, h - pad * 3 - rows.length * lineH))
    elements.push({ id: newId(), type: 'qr', x: round((w - qr) / 2), y: pad, w: qr, h: qr })
    let y = pad * 2 + qr
    for (const r of rows) {
      const big = r.source === 'serial_number'
      const lh = big ? lineH * 1.3 : lineH
      elements.push(field(r, pad, y, w - pad * 2, lh, Math.min(w, h) * r.size * (big ? 0.6 : 1)))
      y += lh
    }
  } else {
    // QR on the right, text block on the left (vertically centred)
    const qr = round(Math.min(h - pad * 2, w * 0.55))
    elements.push({ id: newId(), type: 'qr', x: round(w - pad - qr), y: round((h - qr) / 2), w: qr, h: qr })
    const textW = w - qr - pad * 3
    const heights = rows.map((r) => h * r.size * 1.35)
    let y = Math.max(pad, (h - heights.reduce((a, b) => a + b, 0)) / 2)
    rows.forEach((r, i) => {
      elements.push(field(r, pad, y, textW, heights[i], h * r.size))
      y += heights[i]
    })
  }
  return { width: w, height: h, elements }
}

function field(r, x, y, w, h, size) {
  return {
    id: newId(),
    type: 'field',
    source: r.source,
    prefix: r.prefix || '',
    x: round(x),
    y: Math.round(y * 10) / 10,
    w: round(w),
    h: Math.max(1.5, Math.round(h * 10) / 10),
    size: Math.max(1.4, Math.round(size * 10) / 10),
    bold: !!r.bold,
    mono: !!r.mono,
    align: 'center',
    fit: true,
    wrap: false,
  }
}

/** Saved design, or the default one. */
export function templateFrom(settings) {
  try {
    const t = settings.label_template ? JSON.parse(settings.label_template) : null
    if (t?.elements && t.width && t.height) return t
  } catch {
    /* fall back to the default design */
  }
  return defaultTemplate(settings)
}

/** Text an element shows for one equipment ('' = nothing to show). */
export function elementText(el, equipment, settings) {
  if (el.type === 'text') return el.text || ''
  if (el.type !== 'field') return ''
  const eq = equipment || {}
  let value = ''
  if (el.source?.startsWith('field:')) {
    value = (eq.fields || []).find((f) => f.key === el.source.slice(6))?.value ?? ''
  } else {
    value = {
      serial_number: eq.serial_number,
      display_name: eq.display_name || eq.name || eq.category,
      row_no: eq.row_no ?? '',
      parent_serial: eq.parent_serial,
      category: eq.category,
      company: settings?.company_name,
    }[el.source]
  }
  value = value == null ? '' : String(value)
  if (!el.wrap) value = value.split('\n')[0]
  return value ? `${el.prefix || ''}${value}` : ''
}

export const newElement = (type, template) => {
  const w = template.width
  const h = template.height
  const base = { id: newId(), type }
  if (type === 'qr') {
    const s = round(Math.min(w, h) * 0.5)
    return { ...base, x: round((w - s) / 2), y: round((h - s) / 2), w: s, h: s }
  }
  if (type === 'box') return { ...base, x: 1, y: 1, w: round(w - 2), h: round(h - 2), border: 0.3, radius: 1 }
  const common = { x: round(w * 0.1), y: round(h * 0.4), w: round(w * 0.8), h: round(Math.max(3, h * 0.15)), size: round(Math.max(2, h * 0.09)), bold: false, mono: false, align: 'center', fit: true, wrap: false }
  return type === 'text' ? { ...base, ...common, text: 'نص' } : { ...base, ...common, source: 'display_name', prefix: '' }
}
