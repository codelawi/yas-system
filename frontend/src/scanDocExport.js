// A scan document as a Word file: its title, then the table with the same columns as on screen.
// The docx library is loaded only when the button is pressed.
import dayjs from 'dayjs'

const A4_W = 210
const A4_H = 297
const MARGIN = 12 // mm
const TWIP_PER_MM = 56.7

/** The text shown in one cell (same as the table on screen). */
export function cellText(column, row, index) {
  if (column.key === 'no') return String(index + 1)
  if (column.key === 'code') return row.code || ''
  if (column.key === 'scanned_at') return row.scanned_at ? dayjs(row.scanned_at).format('YYYY-MM-DD HH:mm') : ''
  return row.cells?.[column.key] ?? ''
}

function saveBlob(blob, filename) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 10000)
}

/** A file name without characters Windows refuses. */
export function safeFileName(title) {
  return (String(title || 'document').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document').slice(0, 120)
}

export async function downloadScanDocDocx(document_, rows, { t }) {
  const { AlignmentType, BorderStyle, Document, Packer, PageOrientation, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } =
    await import('docx')

  const columns = document_.columns
  // Wide tables are easier to read across the page
  const landscape = columns.length > 4
  const pageW = Math.round((landscape ? A4_H : A4_W) * TWIP_PER_MM)
  const margin = Math.round(MARGIN * TWIP_PER_MM)
  const contentW = pageW - margin * 2

  // Narrow columns for the row number and the time, the rest share the width
  const fixed = { no: 12, scanned_at: 34 }
  const fixedW = columns.reduce((sum, c) => sum + (fixed[c.key] ? Math.round(fixed[c.key] * TWIP_PER_MM) : 0), 0)
  const flexible = columns.filter((c) => !fixed[c.key]).length || 1
  const widths = columns.map((c) => (fixed[c.key] ? Math.round(fixed[c.key] * TWIP_PER_MM) : Math.floor((contentW - fixedW) / flexible)))

  const FONT = 'Arial'
  const line = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' }
  const borders = { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line }
  const text = (value, options = {}) => new TextRun({ text: String(value), font: FONT, rightToLeft: true, ...options })
  const para = (children, options = {}) => new Paragraph({ bidirectional: true, children, ...options })

  const cell = (value, width, { header = false, code = false } = {}) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E5E7EB' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: String(value)
        .split('\n')
        .map((part) =>
          // Scanned codes are Latin text: keep them left-to-right so they read correctly
          code
            ? new Paragraph({ children: [new TextRun({ text: part, font: 'Consolas', size: 20 })] })
            : para([text(part, { size: 21, bold: header })], header ? { alignment: AlignmentType.CENTER } : {}),
        ),
    })

  const table = new Table({
    visuallyRightToLeft: true,
    width: { size: contentW, type: WidthType.DXA },
    columnWidths: widths,
    borders,
    rows: [
      new TableRow({ tableHeader: true, children: columns.map((c, i) => cell(c.label, widths[i], { header: true })) }),
      ...rows.map(
        (row, index) =>
          new TableRow({
            cantSplit: true,
            children: columns.map((c, i) => cell(cellText(c, row, index), widths[i], { code: c.key === 'code' })),
          }),
      ),
    ],
  })

  const doc = new Document({
    creator: 'Repository System',
    title: document_.title,
    sections: [
      {
        properties: {
          page: {
            // docx swaps width and height itself for landscape: give the portrait size
            size: { width: Math.round(A4_W * TWIP_PER_MM), height: Math.round(A4_H * TWIP_PER_MM), orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
            margin: { top: margin, bottom: margin, left: margin, right: margin },
          },
        },
        children: [
          para([text(document_.title, { size: 36, bold: true })], { alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
          para([text(`${dayjs().format('YYYY-MM-DD')} · ${rows.length} ${t('rows_word')}`, { size: 20, color: '6B7280' })], {
            alignment: AlignmentType.CENTER,
            spacing: { after: 240 },
          }),
          table,
        ],
      },
    ],
  })

  saveBlob(await Packer.toBlob(doc), `${safeFileName(document_.title)}.docx`)
}
