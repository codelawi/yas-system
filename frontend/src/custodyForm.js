// Custody forms (سند عهدة): an uploaded PDF/image with values placed on it in millimetres,
// or a Word/Excel file with {{tags}} that the server fills in.

import api from './api'
import { downloadFile } from './download'
import { newId } from './labelTemplate'

/** Values every custody has (same ids as the server's CustodyFormData::TAGS). */
export const EQUIPMENT_SOURCES = ['serial_number', 'display_name', 'category', 'row_no', 'parent_serial', 'accessories']
export const PERSON_SOURCES = ['holder', 'holder_phone', 'holder_id_number', 'holder_department', 'handed_at', 'due_back_at', 'custody_notes', 'handed_by', 'custody_no', 'company', 'today']

export const usesTags = (form) => form.kind === 'docx' || form.kind === 'xlsx'

const MM_PER_PT = 25.4 / 72
const PDF_ASSETS = `${import.meta.env.BASE_URL}pdfjs/`

/**
 * The form's pages as images with their size in mm.
 * `scale` = pixels per PDF point (1.5 is fine on screen, 3 for print).
 * @returns {Promise<{w: number, h: number, src: string}[]>}
 */
export async function loadFormPages(form, scale = 1.5) {
  const { data } = await api.get(`/custody-forms/${form.id}/file`, { responseType: 'arraybuffer' })

  if (form.kind === 'image') {
    const src = URL.createObjectURL(new Blob([data]))
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = src
    })
    // A scanned/photographed paper: A4 width (portrait) or A4 height (landscape)
    const w = img.naturalWidth >= img.naturalHeight ? 297 : 210
    return [{ w, h: Math.round(((w * img.naturalHeight) / img.naturalWidth) * 10) / 10, src }]
  }

  // pdf.js is big: load it only when a PDF form is opened
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    // Bundled as a plain .js worker (some servers send .mjs with the wrong type)
    const { default: PdfWorker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
  }
  const pdf = await pdfjs.getDocument({
    data,
    cMapUrl: `${PDF_ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDF_ASSETS}standard_fonts/`,
    wasmUrl: `${PDF_ASSETS}wasm/`,
    iccUrl: `${PDF_ASSETS}iccs/`,
  }).promise

  const pages = []
  for (let n = 1; n <= Math.min(pdf.numPages, 30); n++) {
    const page = await pdf.getPage(n)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport }).promise
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    pages.push({ w: Math.round(base.width * MM_PER_PT * 10) / 10, h: Math.round(base.height * MM_PER_PT * 10) / 10, src: URL.createObjectURL(blob) })
  }
  pdf.destroy()
  return pages
}

/** Text an element prints for one custody (`data` from /custodies/{id}/form-data). */
export function formElementText(el, data) {
  if (el.type === 'text') return el.text || ''
  if (el.type !== 'field' || !data) return ''
  const value = el.source?.startsWith('field:') ? data.fields?.[el.source.slice(6)] : data.values?.[el.source]
  let text = value == null ? '' : String(value)
  if (!el.wrap) text = text.split('\n')[0]
  return text ? `${el.prefix || ''}${text}` : ''
}

export function newFormElement(type, page, pageSize) {
  const base = { id: newId(), type, page }
  const x = Math.round(pageSize.w * 0.1)
  const y = Math.round(pageSize.h * 0.1)
  if (type === 'qr') return { ...base, x, y, w: 25, h: 25 }
  if (type === 'box') return { ...base, x, y, w: 80, h: 20, border: 0.3, radius: 0 }
  const common = { x, y, w: 70, h: 8, size: 4, bold: false, mono: false, align: 'start', fit: true, wrap: false }
  return type === 'text' ? { ...base, ...common, text: 'نص' } : { ...base, ...common, source: 'holder', prefix: '' }
}

/** Prints a custody form: PDF/image open the print page, Word/Excel download filled. */
export function printCustodyForm(form, custodyId) {
  if (usesTags(form)) return downloadFile(`/custody-forms/${form.id}/fill/${custodyId}`, {}, `custody-${custodyId}.${form.kind}`)
  window.open(`/print/custody/${custodyId}?form=${form.id}`, '_blank')
}
