import { useSyncExternalStore } from 'react'
import {
  AppstoreOutlined,
  AuditOutlined,
  ClusterOutlined,
  CloudDownloadOutlined,
  DashboardOutlined,
  FileWordOutlined,
  HistoryOutlined,
  InboxOutlined,
  QrcodeOutlined,
  ScanOutlined,
  SettingOutlined,
  TeamOutlined,
  UserSwitchOutlined,
  WifiOutlined,
} from '@ant-design/icons'

/**
 * The app's sections, in menu order. On phones the four with `tab` are the bottom tabs and the
 * others are in the top bar's menu; `color` tints their icon there.
 */
export const SECTIONS = [
  { to: '/', label: 'dashboard', icon: DashboardOutlined, color: '#2563eb' },
  { to: '/equipment', label: 'equipment', icon: AppstoreOutlined, tab: true },
  { to: '/groups', label: 'groups', icon: ClusterOutlined, color: '#0891b2' },
  { to: '/boxes', label: 'boxes', icon: InboxOutlined, tab: true },
  { to: '/import', label: 'import', icon: FileWordOutlined, color: '#4f46e5' },
  { to: '/custody', label: 'custodies', icon: UserSwitchOutlined, color: '#7c3aed' },
  { to: '/stocktakes', label: 'stocktake', icon: AuditOutlined, color: '#059669' },
  { to: '/scan-documents', label: 'scan_docs', icon: ScanOutlined, tab: true },
  { to: '/qr', label: 'qr_codes', icon: QrcodeOutlined, color: '#334155' },
  { to: '/history', label: 'history', icon: HistoryOutlined, color: '#d97706' },
  { to: '/network', label: 'network', icon: WifiOutlined, color: '#0284c7' },
  { to: '/offline', label: 'offline_title', icon: CloudDownloadOutlined, color: '#0d9488' },
  { to: '/users', label: 'users', icon: TeamOutlined, color: '#db2777', admin: true },
  { to: '/settings', label: 'settings', icon: SettingOutlined, color: '#475569', admin: true },
]

/** The section a path belongs to ("/" only for the home page itself). */
export const inSection = (path, to) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`))

/* ---------- Phones */

/** Phones get the app layout (bottom tabs); tablets and computers keep the side menu. */
const PHONE_QUERY = '(max-width: 767.98px)'
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY) : null
const subscribe = (onChange) => {
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

/** True on a phone-sized screen, updated when it turns or resizes. */
export const usePhone = () => useSyncExternalStore(subscribe, () => !!media?.matches, () => false)
