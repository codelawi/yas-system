import { useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { App as AntApp, Button, ConfigProvider, Drawer, Grid, Layout, Menu, Tag } from 'antd'
import arEG from 'antd/locale/ar_EG'
import enUS from 'antd/locale/en_US'
import {
  AppstoreOutlined,
  AuditOutlined,
  CameraOutlined,
  DashboardOutlined,
  FileWordOutlined,
  GlobalOutlined,
  HistoryOutlined,
  InboxOutlined,
  LockOutlined,
  MenuOutlined,
  QrcodeOutlined,
  SettingOutlined,
  TeamOutlined,
  UnlockOutlined,
  UserSwitchOutlined,
  WifiOutlined,
} from '@ant-design/icons'
import { useLang } from './i18n'
import { AuthProvider, useAuth } from './auth'
import { SettingsProvider } from './settings'
import Dashboard from './pages/Dashboard'
import EquipmentList from './pages/EquipmentList'
import EquipmentDetail from './pages/EquipmentDetail'
import ScanPage from './pages/ScanPage'
import ImportPage from './pages/ImportPage'
import UsersPage from './pages/UsersPage'
import SettingsPage from './pages/SettingsPage'
import NetworkPage from './pages/NetworkPage'
import QrPage from './pages/QrPage'
import HistoryPage from './pages/HistoryPage'
import CustodyPage from './pages/CustodyPage'
import { StocktakePage, StocktakesPage } from './pages/StocktakePages'
import LabelsPrint from './pages/LabelsPrint'
import ScanLabelPage from './pages/ScanLabelPage'
import { PrintCustodyForm, PrintList, PrintSheet } from './pages/PrintPages'
import { CustodyFormPage, CustodyFormsPage } from './pages/CustodyFormsPage'
import { BoxDetail, BoxesPage, ScanBoxPage } from './pages/BoxPages'
import BoxLabelsPrint from './pages/BoxLabelsPrint'

// Latin letters and digits come from Inter, Arabic letters from IBM Plex Sans Arabic
const FONT = '"Inter Variable", "IBM Plex Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif'

export default function App() {
  const { lang, dir } = useLang()
  return (
    <ConfigProvider
      direction={dir}
      locale={lang === 'ar' ? arEG : enUS}
      theme={{ token: { colorPrimary: '#1d4ed8', borderRadius: 8, fontFamily: FONT, fontSize: lang === 'ar' ? 15 : 14 } }}
    >
      <AntApp>
        <SettingsProvider>
          <AuthProvider>
            <Routes>
              {/* Opened by phones scanning a QR code */}
              <Route path="/eq/:serial" element={<ScanPage />} />
              <Route path="/box/:number" element={<ScanBoxPage />} />
              <Route path="/labels" element={<LabelsPrint />} />
              <Route path="/boxes/labels" element={<BoxLabelsPrint />} />
              <Route path="/scan" element={<ScanLabelPage />} />
              <Route path="/print/equipment/:id" element={<PrintSheet />} />
              <Route path="/print/list" element={<PrintList />} />
              <Route path="/print/custody/:custodyId" element={<PrintCustodyForm />} />
              <Route path="/*" element={<Shell />} />
            </Routes>
          </AuthProvider>
        </SettingsProvider>
      </AntApp>
    </ConfigProvider>
  )
}

function Shell() {
  const { t, dir, toggle } = useLang()
  const { user, isAdmin, requirePin, logout } = useAuth()
  const location = useLocation()
  const screens = Grid.useBreakpoint()
  const [drawer, setDrawer] = useState(false)
  const mobile = !screens.lg

  const items = [
    { key: '/', icon: <DashboardOutlined />, label: <Link to="/">{t('dashboard')}</Link> },
    { key: '/equipment', icon: <AppstoreOutlined />, label: <Link to="/equipment">{t('equipment')}</Link> },
    { key: '/boxes', icon: <InboxOutlined />, label: <Link to="/boxes">{t('boxes')}</Link> },
    { key: '/import', icon: <FileWordOutlined />, label: <Link to="/import">{t('import')}</Link> },
    { key: '/custody', icon: <UserSwitchOutlined />, label: <Link to="/custody">{t('custodies')}</Link> },
    { key: '/stocktakes', icon: <AuditOutlined />, label: <Link to="/stocktakes">{t('stocktake')}</Link> },
    { key: '/qr', icon: <QrcodeOutlined />, label: <Link to="/qr">{t('qr_codes')}</Link> },
    { key: '/history', icon: <HistoryOutlined />, label: <Link to="/history">{t('history')}</Link> },
    { key: '/network', icon: <WifiOutlined />, label: <Link to="/network">{t('network')}</Link> },
    ...(isAdmin
      ? [
          { key: '/users', icon: <TeamOutlined />, label: <Link to="/users">{t('users')}</Link> },
          { key: '/settings', icon: <SettingOutlined />, label: <Link to="/settings">{t('settings')}</Link> },
        ]
      : []),
  ]
  const selected = items.map((i) => i.key).filter((k) => (k === '/' ? location.pathname === '/' : location.pathname.startsWith(k)))

  const menu = <Menu mode="inline" theme="dark" selectedKeys={selected} items={items} onClick={() => setDrawer(false)} />
  const brand = (
    <div className="brand">
      <AppstoreOutlined /> <span>{t('app_name')}</span>
    </div>
  )

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {mobile ? (
        <Drawer open={drawer} onClose={() => setDrawer(false)} placement={dir === 'rtl' ? 'right' : 'left'} size={240} styles={{ body: { padding: 0, background: '#001529' }, header: { display: 'none' } }}>
          {brand}
          {menu}
        </Drawer>
      ) : (
        <Layout.Sider width={230}>
          {brand}
          {menu}
        </Layout.Sider>
      )}
      <Layout>
        <Layout.Header className="app-header">
          {mobile && <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawer(true)} />}
          <div style={{ flex: 1 }} />
          <Link to="/scan">
            <Button icon={<CameraOutlined />}>{!mobile && t('scan_title')}</Button>
          </Link>
          <Button type="text" icon={<GlobalOutlined />} onClick={toggle}>
            {t('language')}
          </Button>
          {user ? (
            <>
              <Tag color={isAdmin ? 'gold' : 'blue'} style={{ marginInline: 4 }}>
                {user.name}
              </Tag>
              <Button icon={<LockOutlined />} onClick={logout}>
                {t('lock')}
              </Button>
            </>
          ) : (
            <Button type="primary" icon={<UnlockOutlined />} onClick={requirePin}>
              {t('unlock')}
            </Button>
          )}
        </Layout.Header>
        <Layout.Content className="app-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/equipment" element={<EquipmentList />} />
            <Route path="/equipment/:id" element={<EquipmentDetail />} />
            <Route path="/boxes" element={<BoxesPage />} />
            <Route path="/boxes/:id" element={<BoxDetail />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/qr" element={<QrPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/custody" element={<CustodyPage />} />
            <Route path="/custody/forms" element={<CustodyFormsPage />} />
            <Route path="/custody/forms/:id" element={<CustodyFormPage />} />
            <Route path="/stocktakes" element={<StocktakesPage />} />
            <Route path="/stocktakes/:id" element={<StocktakePage />} />
            <Route path="/network" element={<NetworkPage />} />
            <Route path="/users" element={isAdmin ? <UsersPage /> : <Navigate to="/" />} />
            <Route path="/settings" element={isAdmin ? <SettingsPage /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
