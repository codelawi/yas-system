// Download the box sheet as PDF or Word. The libraries are loaded only when a button is pressed.
import QRCode from 'qrcode'

const A4_W = 210
const A4_H = 297
const MARGIN = 12 // mm, same as the printed sheet

function saveBlob(blob, filename) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 10000)
}

/**
 * PDF: a picture of the sheet exactly as on screen (Arabic text stays correct), cut into A4 pages
 * between items so no equipment is split across two pages.
 */
export async function downloadBoxPdf(node, filename) {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')])
  const canvas = await toCanvas(node, { pixelRatio: 2, backgroundColor: '#ffffff' })

  const contentW = A4_W - MARGIN * 2
  const contentH = A4_H - MARGIN * 2
  const pxPerMm = canvas.width / contentW
  const pageH = Math.floor(contentH * pxPerMm)
  const box = node.getBoundingClientRect()
  const ratio = canvas.width / box.width
  // Where a page may end: under the title, the figures, the list heading or any item
  const ends = [...node.querySelectorAll('.box-head, .box-print-top, .ant-card-head, .box-item')]
    .map((el) => Math.round((el.getBoundingClientRect().bottom - box.top) * ratio))
    .sort((a, b) => a - b)

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  let start = 0
  while (start < canvas.height - 1) {
    let end = Math.min(start + pageH, canvas.height)
    if (end < canvas.height) {
      const fit = ends.filter((e) => e > start + 20 && e <= end)
      if (fit.length) end = fit[fit.length - 1]
    }
    const part = document.createElement('canvas')
    part.width = canvas.width
    part.height = end - start
    part.getContext('2d').drawImage(canvas, 0, start, canvas.width, end - start, 0, 0, canvas.width, end - start)
    if (start > 0) pdf.addPage()
    pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', MARGIN, MARGIN, contentW, (end - start) / pxPerMm)
    start = end
  }
  pdf.save(filename)
}

/** A photo as a small JPEG for Word (Word can't show every format phones save, e.g. WebP). */
async function photoForWord(url, max = 300) {
  try {
    const blob = await (await fetch(url)).blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return { data: await jpeg.arrayBuffer(), width: canvas.width, height: canvas.height }
  } catch {
    return null
  }
}

/** Word: the same sheet as an editable .docx (title, QR, weight and count, then each item with its photo). */
export async function downloadBoxDocx(box, { url, t, filename }) {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    ImageRun,
    Packer,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    VerticalAlign,
    WidthType,
  } = await import('docx')

  const FONT = 'Arial'
  const TWIP_PER_MM = 56.7
  const pageW = Math.round(A4_W * TWIP_PER_MM)
  const margin = Math.round(MARGIN * TWIP_PER_MM)
  const contentW = pageW - margin * 2
  const photoCol = Math.round(32 * TWIP_PER_MM)
  const grey = 'E5E7EB'
  const line = { style: BorderStyle.SINGLE, size: 4, color: grey }
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  const borders = { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: none }

  const text = (value, options = {}) => new TextRun({ text: String(value), font: FONT, rightToLeft: true, ...options })
  const para = (children, options = {}) => new Paragraph({ bidirectional: true, children, ...options })
  const weight =
    box.weight != null ? `${Number(box.weight).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${t('kg')}` : t('weight_not_set')

  const qr = await (await fetch(await QRCode.toDataURL(url, { margin: 1, width: 400 }))).arrayBuffer()
  const photos = await Promise.all(box.equipment.map((eq) => (eq.photo_url ? photoForWord(eq.photo_url) : null)))

  const qrCol = Math.round(66 * TWIP_PER_MM)
  const statsCol = contentW - qrCol
  const stat = (label, value, fill) =>
    new TableCell({
      width: { size: statsCol, type: WidthType.DXA },
      shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
      margins: { top: 120, bottom: 120, left: 200, right: 200 },
      children: [para([text(label, { size: 20, color: fill ? 'B45309' : '6B7280' })]), para([text(value, { size: 40, bold: true, color: fill ? '92400E' : '111827' })])],
    })

  const itemRow = (eq, photo) => {
    const details = (eq.summary || []).map((f) => `${f.key}: ${f.value}`).join('  ·  ')
    const size = photo ? Math.min(110 / Math.max(photo.width, photo.height), 1) : 1
    return new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: photoCol, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          shading: photo ? undefined : { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
          margins: { top: 80, bottom: 80, left: 80, right: 80 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: photo
                ? [new ImageRun({ type: 'jpg', data: photo.data, transformation: { width: Math.round(photo.width * size), height: Math.round(photo.height * size) } })]
                : [],
            }),
          ],
        }),
        new TableCell({
          width: { size: contentW - photoCol, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 100, bottom: 100, left: 200, right: 200 },
          children: [
            para([text(eq.display_name || eq.serial_number, { size: 30, bold: true, color: '111827' })]),
            ...(details ? [para([text(details, { size: 23, color: '6B7280' })])] : []),
            ...(eq.parent ? [para([text(`↳ ${t('accessory_of')} ${eq.parent.display_name || eq.parent.serial_number}`, { size: 23, color: '6B7280' })])] : []),
          ],
        }),
      ],
    })
  }

  const doc = new Document({
    creator: 'Repository System',
    title: `${t('box')} ${box.number}`,
    sections: [
      {
        properties: {
          page: {
            size: { width: pageW, height: Math.round(A4_H * TWIP_PER_MM) },
            margin: { top: margin, bottom: margin, left: margin, right: margin },
          },
        },
        children: [
          para([text(`${t('box')} ${box.number}`, { size: 68, bold: true, color: '111827' })], { alignment: AlignmentType.CENTER }),
          // Weight and count stacked on the right; the QR at the left corner with the box name under it
          new Table({
            visuallyRightToLeft: true,
            width: { size: contentW, type: WidthType.DXA },
            columnWidths: [statsCol, qrCol],
            borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    width: { size: statsCol, type: WidthType.DXA },
                    verticalAlign: VerticalAlign.CENTER,
                    children: [
                      new Table({
                        visuallyRightToLeft: true,
                        width: { size: statsCol, type: WidthType.DXA },
                        columnWidths: [statsCol],
                        borders,
                        rows: [
                          new TableRow({ children: [stat(t('weight'), weight, 'FFFBEB')] }),
                          new TableRow({ children: [stat(t('box_contents'), `${box.equipment.length} ${t('items_word')}`)] }),
                        ],
                      }),
                    ],
                  }),
                  new TableCell({
                    width: { size: qrCol, type: WidthType.DXA },
                    verticalAlign: VerticalAlign.CENTER,
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new ImageRun({ type: 'png', data: qr, transformation: { width: 150, height: 150 } })],
                      }),
                      ...(box.name ? [para([text(box.name, { size: 30, bold: true, color: '111827' })], { alignment: AlignmentType.CENTER })] : []),
                    ],
                  }),
                ],
              }),
            ],
          }),
          para([text(`${t('box_contents')} (${box.equipment.length})`, { size: 28, bold: true })], { spacing: { before: 360, after: 160 } }),
          box.equipment.length
            ? new Table({
                visuallyRightToLeft: true,
                width: { size: contentW, type: WidthType.DXA },
                columnWidths: [photoCol, contentW - photoCol],
                borders,
                rows: box.equipment.map((eq, i) => itemRow(eq, photos[i])),
              })
            : para([text(t('box_empty'), { color: '6B7280' })]),
        ],
      },
    ],
  })

  saveBlob(await Packer.toBlob(doc), filename)
}
