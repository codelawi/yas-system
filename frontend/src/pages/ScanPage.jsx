import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Layout, Result, Spin } from 'antd'
import { AppstoreOutlined, CameraOutlined, GlobalOutlined, LockOutlined } from '@ant-design/icons'
import api from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import EquipmentView from '../components/EquipmentView'

/** Page opened by a phone after scanning the QR code on an equipment. */
export default function ScanPage() {
  const { serial } = useParams()
  const { t, toggle } = useLang()
  const { user, logout } = useAuth()
  const [equipment, setEquipment] = useState(null)
  const [state, setState] = useState('loading')

  const load = useCallback(
    () =>
      api
        .get(`/equipment/serial/${encodeURIComponent(serial)}`)
        .then(({ data }) => {
          setEquipment(data)
          setState('ok')
        })
        .catch(() => setState('missing')),
    [serial],
  )

  useEffect(() => {
    setState('loading')
    load()
    // `user`: reload when the PIN is entered or locked again (the history is only sent with a PIN)
  }, [load, user])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header scan-header">
        <Link to="/" className="brand-inline">
          <AppstoreOutlined /> {t('app_name')}
        </Link>
        <div style={{ flex: 1 }} />
        <Link to="/scan">
          <Button icon={<CameraOutlined />} />
        </Link>
        <Button type="text" icon={<GlobalOutlined />} onClick={toggle}>
          {t('language')}
        </Button>
        {user && <Button icon={<LockOutlined />} onClick={logout} />}
      </Layout.Header>
      <Layout.Content className="app-content">
        {state === 'loading' && <Spin size="large" className="page-spin" />}
        {state === 'missing' && (
          <Result
            status="404"
            title={t('not_found')}
            subTitle={serial}
            extra={
              <Link to="/">
                <Button>{t('open_dashboard')}</Button>
              </Link>
            }
          />
        )}
        {state === 'ok' && (
          <EquipmentView equipment={equipment} onChange={setEquipment} onReload={load} onDeleted={() => setState('missing')} mobile />
        )}
      </Layout.Content>
    </Layout>
  )
}
