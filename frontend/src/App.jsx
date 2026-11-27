import { useState } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { App as AntApp, Button, ConfigProvider, Drawer, Grid, Layout, Menu, Tag } from 'antd'
import arEG from 'antd/locale/ar_EG'
import enUS from 'antd/locale/en_US'
import { AppstoreOutlined, CameraOutlined, GlobalOutlined, LockOutlined, MenuOutlined, UnlockOutlined } from '@ant-design/icons'
import { useLang } from './i18n'
import { AuthProvider, useAuth } from './auth'
import { SettingsProvider } from './settings'
import { SECTIONS, usePhone } from './nav'
import PhoneShell from './components/PhoneShell'
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
import { StocktakePage, StocktakesPage } from './pages/StocktakePages'
import LabelsPrint from './pages/LabelsPrint'
import ScanLabelPage from './pages/ScanLabelPage'
import { PrintList, PrintSheet } from './pages/PrintPages'
import { BoxDetail, BoxesPage, ScanBoxPage } from './pages/BoxPages'
import { GroupDetail, GroupsPage } from './pages/GroupPages'
import { VoucherCodeImportPage, VoucherCodesPage } from './pages/VoucherCodePages'
import { VoucherPage, VoucherReturnPage, VouchersPage } from './pages/VoucherPages'
import { VoucherTemplatePage, VoucherTemplatesPage } from './pages/VoucherTemplatePages'
import PrintStationPage from './pages/PrintStationPage'
import BoxLabelsPrint from './pages/BoxLabelsPrint'
import BoxReport from './pages/BoxReport'
import OfflinePage from './pages/OfflinePage'
import { ScanDocumentPage, ScanFolderPage, ScanFoldersPage } from './pages/ScanDocumentPages'
import OfflineBanner from './components/OfflineBanner'

// Latin letters and digits come from Inter, Arabic letters from IBM Plex Sans Arabic
const FONT = '"Inter Variable", "IBM Plex Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif'

export default function App() {
  const { lang, dir } = useLang()
  const phone = usePhone()
  return (
    <ConfigProvider
      direction={dir}
      locale={lang === 'ar' ? arEG : enUS}
      theme={{ token: { colorPrimary: '#1d4ed8', borderRadius: 8, fontFamily: FONT, fontSize: lang === 'ar' ? 15 : 14 } }}
    >
      <AntApp>
        <SettingsProvider>
          <AuthProvider>
            {/* On phones it is under the app's top bar */}
            {!phone && <OfflineBanner />}
            <Routes>
              <Route path="/labels" element={<LabelsPrint />} />
              {/* The laptop's print station: no menus, no PIN (it has its own key) */}
              <Route path="/print-station" element={<PrintStationPage />} />
              <Route path="/boxes/labels" element={<BoxLabelsPrint />} />
              <Route path="/boxes/:id/report" element={<BoxReport />} />
              <Route path="/print/equipment/:id" element={<PrintSheet />} />
              <Route path="/print/list" element={<PrintList />} />
              {/* Phones: every page except the printed ones in the app layout (bottom tabs) */}
              <Route element={phone ? <PhoneShell /> : <Outlet />}>
                {/* Opened by phones scanning a QR code */}
                <Route path="/eq/:serial" element={<ScanPage />} />
                <Route path="/item/:id" element={<ScanPage />} />
                <Route path="/box/:number" element={<ScanBoxPage />} />
                <Route path="/scan" element={<ScanLabelPage />} />
                <Route path="/offline" element={<OfflinePage />} />
                <Route path="/*" element={<Shell />} />
              </Route>
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
  const phone = usePhone()
  const [drawer, setDrawer] = useState(false)
  const mobile = !screens.lg

  const routes = (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/equipment" element={<EquipmentList />} />
      <Route path="/equipment/:id" element={<EquipmentDetail />} />
      <Route path="/groups" element={<GroupsPage />} />
      <Route path="/groups/codes" element={<VoucherCodesPage />} />
      <Route path="/groups/codes/import" element={<VoucherCodeImportPage />} />
      <Route path="/groups/:id" element={<GroupDetail />} />
      <Route path="/boxes" element={<BoxesPage />} />
      <Route path="/boxes/:id" element={<BoxDetail />} />
      <Route path="/import" element={<ImportPage />} />
      <Route path="/qr" element={<QrPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/vouchers" element={<VouchersPage />} />
      <Route path="/vouchers/return" element={<VoucherReturnPage />} />
      <Route path="/vouchers/templates" element={<VoucherTemplatesPage />} />
      <Route path="/vouchers/templates/:id" element={<VoucherTemplatePage />} />
      <Route path="/vouchers/:id" element={<VoucherPage />} />
      <Route path="/stocktakes" element={<StocktakesPage />} />
      <Route path="/stocktakes/:id" element={<StocktakePage />} />
      <Route path="/scan-documents" element={<ScanFoldersPage />} />
      <Route path="/scan-documents/folders/:folderId" element={<ScanFolderPage />} />
      <Route path="/scan-documents/:id" element={<ScanDocumentPage />} />
      <Route path="/network" element={<NetworkPage />} />
      <Route path="/users" element={isAdmin ? <UsersPage /> : <Navigate to="/" />} />
      <Route path="/settings" element={isAdmin ? <SettingsPage /> : <Navigate to="/" />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )

  // Phones: the page only, PhoneShell has the bars
  if (phone) return <div className="app-content">{routes}</div>

  const items = SECTIONS.filter((s) => !s.admin || isAdmin).map(({ to, label, icon: Icon }) => ({
    key: to,
    icon: <Icon />,
    label: <Link to={to}>{t(label)}</Link>,
  }))
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
        <Layout.Content className="app-content">{routes}</Layout.Content>
      </Layout>
    </Layout>
  )
}
