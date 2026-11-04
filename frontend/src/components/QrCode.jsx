import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export default function QrCode({ value, size = 160, onReady, style }) {
  const [src, setSrc] = useState(null)

  useEffect(() => {
    let alive = true
    QRCode.toDataURL(value, { margin: 1, width: 512, errorCorrectionLevel: 'M' }).then((url) => alive && setSrc(url))
    return () => {
      alive = false
    }
  }, [value])

  if (!src) return <div style={{ width: size, height: size, ...style }} />
  return <img src={src} alt={value} width={size} height={size} onLoad={onReady} style={{ display: 'block', ...style }} />
}
