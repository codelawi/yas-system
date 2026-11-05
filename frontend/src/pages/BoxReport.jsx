import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { App, Button, Result, Space, Spin } from 'antd'
import { ArrowRightOutlined, FilePdfOutlined, FileWordOutlined, PrinterOutlined } from '@ant-design/icons'
import api, { boxUrl } from '../api'
import { useLang } from '../i18n'
import BoxView from '../components/BoxView'
import { useSettings } from '../settings'
import { downloadBoxDocx, downloadBoxPdf } from '../boxExport'

/** The box page exactly as on screen, as an A4 sheet to print and stick on the box. */
export default function BoxReport() {
  const { id } = useParams()
  const { t } = useLang()
  const { settings } = useSettings()
  const { message } = App.useApp()
  const [box, setBox] = useState(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(null)
  const sheet = useRef(null)

  useEffect(() => {
    api
      .get(`/boxes/${id}`)
      .then(({ data }) => setBox(data))
      .catch(() => setMissing(true))
  }, [id])

  useEffect(() => {
    if (box) document.title = `${t('box')} ${box.number}`
  }, [box, t])

  const download = async (kind) => {
    setBusy(kind)
    const filename = `${t('box')} ${box.number}.${kind}`
    try {
      if (kind === 'pdf') await downloadBoxPdf(sheet.current.querySelector('.page'), filename)
      else await downloadBoxDocx(box, { url: boxUrl(settings, box.number), t, filename })
    } catch {
      message.error(t('error'))
    } finally {
      setBusy(null)
    }
  }

  if (missing) return <Result status="404" title={t('box_not_found')} />
  if (!box) return <Spin size="large" className="page-spin" />

  return (
    <div className="br-page">
      <div className="no-print br-toolbar">
        <Button icon={<ArrowRightOutlined />} onClick={() => window.close()}>
          {t('close')}
        </Button>
        <Space wrap>
          <Button size="large" icon={<FilePdfOutlined />} loading={busy === 'pdf'} disabled={!!busy} onClick={() => download('pdf')}>
            PDF
          </Button>
          <Button size="large" icon={<FileWordOutlined />} loading={busy === 'docx'} disabled={!!busy} onClick={() => download('docx')}>
            Word
          </Button>
          <Button type="primary" size="large" icon={<PrinterOutlined />} onClick={() => window.print()}>
            {t('print')}
          </Button>
        </Space>
      </div>
      <div className="br-sheet" ref={sheet}>
        <BoxView box={box} onChange={setBox} onDeleted={() => {}} printMode />
      </div>
    </div>
  )
}
