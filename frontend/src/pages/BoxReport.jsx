import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Result, Spin } from 'antd'
import { ArrowRightOutlined, PrinterOutlined } from '@ant-design/icons'
import api from '../api'
import { useLang } from '../i18n'
import BoxView from '../components/BoxView'

/** The box page exactly as on screen, as an A4 sheet to print and stick on the box. */
export default function BoxReport() {
  const { id } = useParams()
  const { t } = useLang()
  const [box, setBox] = useState(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    api
      .get(`/boxes/${id}`)
      .then(({ data }) => setBox(data))
      .catch(() => setMissing(true))
  }, [id])

  useEffect(() => {
    if (box) document.title = `${t('box')} ${box.number}`
  }, [box, t])

  if (missing) return <Result status="404" title={t('box_not_found')} />
  if (!box) return <Spin size="large" className="page-spin" />

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
        <BoxView box={box} onChange={setBox} onDeleted={() => {}} printMode />
      </div>
    </div>
  )
}
