import { useLayoutEffect, useRef } from 'react'
import QrCode from './QrCode'
import { elementText } from '../labelTemplate'

/** Smallest font "shrink to fit" goes down to (still readable on a label printer) */
const MIN_FONT_MM = 0.4

/** One element's content (shared by the printed label and the designer canvas). */
export function ElementContent({ el, equipment, url, settings, onReady, placeholder, value }) {
  const ref = useRef(null)
  const inner = useRef(null)
  // `value`: text already worked out by the caller (custody forms); otherwise it comes from the equipment
  const resolved = value ?? elementText(el, equipment, settings)
  const text = resolved || (placeholder ? placeholder(el) : '')

  // "Shrink to fit": scale the font down until the text fits its box, however long it is
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || el.type === 'qr' || el.type === 'box') return
    const fit = () => {
      let size = el.size
      node.style.fontSize = `${size}mm`
      if (!el.fit) return
      // Measure the text itself: right-to-left text overflows to the left, which scrollWidth does not count
      for (let i = 0; i < 8; i++) {
        const ratio = el.wrap
          ? node.clientHeight / node.scrollHeight
          : Math.min(node.clientWidth / inner.current.offsetWidth, node.clientHeight / inner.current.offsetHeight)
        if (!(ratio < 1) || size <= MIN_FONT_MM) break
        size = Math.max(MIN_FONT_MM, size * ratio * 0.97)
        node.style.fontSize = `${size}mm`
      }
    }
    fit()
    // Fonts are loaded on first use: measure again once they are in
    let alive = true
    document.fonts?.ready.then(() => alive && fit())
    document.fonts?.addEventListener('loadingdone', fit)
    return () => {
      alive = false
      document.fonts?.removeEventListener('loadingdone', fit)
    }
  }, [el.type, el.size, el.fit, el.wrap, el.w, el.h, el.bold, el.mono, text])

  if (el.type === 'qr') return <QrCode value={url} size={0} onReady={onReady} style={{ width: '100%', height: '100%' }} />
  if (el.type === 'box') return <div className="tl-box" style={{ borderWidth: `${el.border ?? 0.3}mm`, borderRadius: `${el.radius ?? 0}mm` }} />

  return (
    <div
      ref={ref}
      dir="auto"
      className={['tl-text', el.wrap ? 'wrap' : '', el.mono ? 'mono' : '', !resolved ? 'placeholder' : ''].join(' ')}
      style={{ fontSize: `${el.size}mm`, fontWeight: el.bold ? 700 : 400, textAlign: el.align || 'center', justifyContent: { start: 'flex-start', center: 'center', end: 'flex-end' }[el.align || 'center'] }}
    >
      <span ref={inner} className="tl-inner">
        {text}
      </span>
    </div>
  )
}

/** A printed label drawn from a design. */
export default function TemplateLabel({ template, equipment, url, settings, onReady }) {
  return (
    <div className="tlabel" dir="ltr" style={{ width: `${template.width}mm`, height: `${template.height}mm` }}>
      {template.elements.map((el) => (
        <div key={el.id} className="tl-el" style={{ left: `${el.x}mm`, top: `${el.y}mm`, width: `${el.w}mm`, height: `${el.h}mm` }}>
          <ElementContent el={el} equipment={equipment} url={url} settings={settings} onReady={onReady} />
        </div>
      ))}
    </div>
  )
}
