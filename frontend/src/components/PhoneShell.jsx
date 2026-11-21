import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { Button, Segmented } from 'antd'
import { GlobalOutlined, LockOutlined, SettingOutlined, UnlockOutlined, UserOutlined } from '@ant-design/icons'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { SECTIONS, inSection } from '../nav'
import OfflineBanner from './OfflineBanner'
import { AppLogo, BackIcon, BoxIcon, DocsIcon, EquipmentIcon, MenuIcon, ScanIcon } from './PhoneIcons'
import '../phone.css'

/** The bottom tabs; `paths` are the pages that belong to each (the scan pages open from a label too). */
const TABS = [
  { to: '/equipment', label: 'equipment', icon: EquipmentIcon, paths: ['/equipment', '/eq', '/item'] },
  { to: '/boxes', label: 'boxes', icon: BoxIcon, paths: ['/boxes', '/box'] },
  { to: '/scan', label: 'tab_scan', icon: ScanIcon, paths: ['/scan'] },
  { to: '/scan-documents', label: 'tab_docs', icon: DocsIcon, paths: ['/scan-documents'] },
]
const tabOf = (path) => TABS.findIndex((tab) => tab.paths.some((p) => inSection(path, p)))

/** Tapping the scan tab while on the scan page opens the camera again (ScanLabelPage listens). */
export const SCAN_AGAIN_EVENT = 'phone:scan-again'

/** The page one level up, for the back button; null on a section's own page. */
function parentOf(path) {
  if (/^\/(eq|item)\/./.test(path)) return '/equipment'
  if (/^\/box\/./.test(path)) return '/boxes'
  if (/^\/scan-documents\/./.test(path)) return '/scan-documents'
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : null
}
const depth = (path) => {
  let n = 1
  for (let p = parentOf(path); p; p = parentOf(p)) n++
  return n
}

/** How the next page comes in: from the side of the tab it is on, deeper pages from ahead, going back from behind. */
function motionFor(from, to, navigationType) {
  if (navigationType === 'POP') return 'back'
  const a = tabOf(from)
  const b = tabOf(to)
  if (a >= 0 && b >= 0 && a !== b) return b > a ? 'ahead' : 'back'
  if (depth(to) > depth(from)) return 'ahead'
  if (depth(to) < depth(from)) return 'back'
  return 'rise'
}

/** Keeps something on screen for its closing animation after it is closed. */
function usePresence(open, ms = 220) {
  const [shown, setShown] = useState(open)
  if (open && !shown) setShown(true)
  useEffect(() => {
    if (open) return undefined
    const timer = setTimeout(() => setShown(false), ms)
    return () => clearTimeout(timer)
  }, [open, ms])
  return shown
}

/** True while the phone's keyboard is likely open (a text box has focus): the tabs step aside. */
function useTyping() {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range]):not([readonly]), textarea, [contenteditable="true"]'
    const check = () => setTyping(!!document.activeElement?.matches?.(TEXT))
    let timer
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(check, 60)
    }
    document.addEventListener('focusin', check)
    document.addEventListener('focusout', later)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('focusin', check)
      document.removeEventListener('focusout', later)
    }
  }, [])
  return typing
}

/**
 * Phones: the app layout. A top bar (logo and name, the other sections, and the account and
 * language), the page, and the bottom tabs. Pages slide in like an app's.
 */
export default function PhoneShell() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const path = location.pathname
  const [sheet, setSheet] = useState(null)
  const [scrolled, setScrolled] = useState(false)
  const typing = useTyping()
  // The floating buttons (on the page body) step aside too
  useEffect(() => {
    document.body.classList.toggle('phone-typing', typing)
    return () => document.body.classList.remove('phone-typing')
  }, [typing])

  // A new page (not a replaced address) gets a new view and its entrance
  const [view, setView] = useState({ path, key: 0, motion: 'first' })
  if (view.path !== path) {
    setView(navigationType === 'REPLACE' ? { ...view, path } : { path, key: view.key + 1, motion: motionFor(view.path, path, navigationType) })
  }

  // Menus close when a page opens
  const [sheetPath, setSheetPath] = useState(path)
  if (sheetPath !== path) {
    setSheetPath(path)
    setSheet(null)
  }

  // Each page opens at the top; going back returns to where it was
  const positions = useRef(new Map())
  const currentKey = useRef(location.key)
  useLayoutEffect(() => {
    currentKey.current = location.key
  }, [location.key])

  useEffect(() => {
    window.history.scrollRestoration = 'manual'
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        positions.current.set(currentKey.current, window.scrollY)
        setScrolled(window.scrollY > 4)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  useLayoutEffect(() => {
    const target = navigationType === 'POP' ? positions.current.get(location.key) || 0 : 0
    window.scrollTo(0, 0)
    if (!target) return undefined
    // The page loads its data first: wait until it is long enough (or the user starts scrolling)
    let frame = 0
    let tries = 0
    const restore = () => {
      const room = document.documentElement.scrollHeight - window.innerHeight
      if (room >= target - 2 || ++tries > 120) window.scrollTo(0, Math.min(target, room))
      else frame = requestAnimationFrame(restore)
    }
    const stop = () => cancelAnimationFrame(frame)
    frame = requestAnimationFrame(restore)
    window.addEventListener('touchstart', stop, { once: true, passive: true })
    return () => {
      stop()
      window.removeEventListener('touchstart', stop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when another page opens
  }, [path])

  useEffect(() => {
    if (!sheet) return undefined
    const onKey = (e) => e.key === 'Escape' && setSheet(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet])

  const toggleSheet = useCallback((name) => setSheet((open) => (open === name ? null : name)), [])
  const closeSheet = useCallback(() => setSheet(null), [])
  const backdrop = usePresence(!!sheet)

  return (
    <div className="phone-app">
      <TopBar path={path} sheet={sheet} onToggle={toggleSheet} scrolled={scrolled} />

      <main className="phone-main">
        <div key={view.key} className={`phone-view phone-view-${view.motion}`}>
          <Outlet />
        </div>
      </main>

      <TabBar path={path} hidden={typing} />

      {backdrop && <div className={`phone-backdrop${sheet ? ' is-open' : ''}`} onClick={closeSheet} aria-hidden />}
      <MenuSheet open={sheet === 'menu'} path={path} />
      <AccountSheet open={sheet === 'account'} onClose={closeSheet} />
    </div>
  )
}

function TopBar({ path, sheet, onToggle, scrolled }) {
  const { t } = useLang()
  const { user } = useAuth()
  const navigate = useNavigate()
  const parent = parentOf(path)
  const inMenu = tabOf(path) < 0

  // Back through the app's own history when there is some, else up to the section
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(parent))

  return (
    <header className={`phone-topbar${scrolled || sheet ? ' is-raised' : ''}`}>
      <div className="phone-topbar-row">
        {parent && (
          <button type="button" className="phone-icon-btn phone-back" onClick={back} aria-label={t('back')}>
            <BackIcon />
          </button>
        )}
        <Link to="/" className="phone-brand" aria-label={t('dashboard')}>
          <AppLogo />
          <span className="phone-brand-name">{t('app_name')}</span>
        </Link>
        <button
          type="button"
          className={`phone-icon-btn${sheet === 'menu' ? ' is-open' : ''}${inMenu ? ' is-current' : ''}`}
          onClick={() => onToggle('menu')}
          aria-expanded={sheet === 'menu'}
          aria-controls="phone-menu"
          aria-label={t('sections')}
        >
          <MenuIcon open={sheet === 'menu'} />
        </button>
        <button
          type="button"
          className={`phone-icon-btn phone-gear${sheet === 'account' ? ' is-open' : ''}`}
          onClick={() => onToggle('account')}
          aria-expanded={sheet === 'account'}
          aria-controls="phone-account"
          aria-label={t('settings')}
        >
          <SettingOutlined />
          {user && <span className="phone-badge" />}
        </button>
      </div>
      <OfflineBanner />
    </header>
  )
}

function TabBar({ path, hidden }) {
  const { t } = useLang()
  const active = tabOf(path)
  // The highlight stays where it was while a page from the menu is open
  const [last, setLast] = useState(Math.max(active, 0))
  if (active >= 0 && active !== last) setLast(active)

  const tap = (e, i) => {
    if (i !== active) return
    if (path === TABS[i].to) {
      // The open tab again: back to the top (the scan tab opens the camera again)
      e.preventDefault()
      if (TABS[i].to === '/scan') window.dispatchEvent(new Event(SCAN_AGAIN_EVENT))
      else window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  return (
    <nav className={`phone-tabbar${hidden ? ' is-hidden' : ''}`} aria-label={t('sections')}>
      <span className={`phone-tab-indicator${active < 0 ? ' is-off' : ''}`} style={{ '--i': last }} aria-hidden />
      {TABS.map((tab, i) => {
        const Icon = tab.icon
        const on = i === active
        return (
          <Link key={tab.to} to={tab.to} className={`phone-tab${on ? ' is-active' : ''}`} aria-current={on ? 'page' : undefined} onClick={(e) => tap(e, i)}>
            <span className="phone-tab-icon">
              <Icon active={on} />
            </span>
            <span className="phone-tab-label">{t(tab.label)}</span>
          </Link>
        )
      })}
    </nav>
  )
}

/** The sections that are not tabs, as a grid of tiles under the top bar. */
function MenuSheet({ open, path }) {
  const { t } = useLang()
  const { isAdmin } = useAuth()
  const shown = usePresence(open)
  if (!shown) return null
  const items = SECTIONS.filter((s) => !s.tab && (!s.admin || isAdmin))

  return (
    <div id="phone-menu" className={`phone-sheet phone-menu${open ? ' is-open' : ''}`} role="dialog" aria-label={t('sections')}>
      <div className="phone-sheet-title">{t('sections')}</div>
      <div className="phone-menu-grid">
        {items.map((s, i) => {
          const Icon = s.icon
          const current = inSection(path, s.to)
          return (
            <Link
              key={s.to}
              to={s.to}
              className={`phone-menu-item${current ? ' is-current' : ''}`}
              style={{ '--c': s.color, '--c-soft': `${s.color}17`, '--d': `${40 + i * 18}ms` }}
              aria-current={current ? 'page' : undefined}
            >
              <span className="phone-menu-icon">
                <Icon />
              </span>
              <span className="phone-menu-label">{t(s.label)}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/** What was in the top bar on a computer: who is signed in (lock / unlock) and the language. */
function AccountSheet({ open, onClose }) {
  const { t, lang, toggle } = useLang()
  const { user, isAdmin, requirePin, logout } = useAuth()
  const shown = usePresence(open)
  if (!shown) return null

  return (
    <div id="phone-account" className={`phone-sheet phone-account${open ? ' is-open' : ''}`} role="dialog" aria-label={t('settings')}>
      <div className="phone-user">
        <span className={`phone-avatar${isAdmin ? ' is-admin' : ''}${user ? '' : ' is-locked'}`}>
          {user ? (user.name || '?').trim().charAt(0).toUpperCase() || <UserOutlined /> : <LockOutlined />}
        </span>
        <span className="phone-user-text">
          <b>{user ? user.name : t('signed_out')}</b>
          <span>{user ? t(`role_${user.role}`) : t('pin_hint')}</span>
        </span>
      </div>
      {user ? (
        <Button
          block
          size="large"
          icon={<LockOutlined />}
          onClick={() => {
            logout()
            onClose()
          }}
        >
          {t('lock')}
        </Button>
      ) : (
        <Button
          block
          size="large"
          type="primary"
          icon={<UnlockOutlined />}
          onClick={() => {
            onClose()
            requirePin()
          }}
        >
          {t('unlock')}
        </Button>
      )}
      <div className="phone-setting">
        <span className="phone-setting-name">
          <GlobalOutlined /> {t('language_name')}
        </span>
        <Segmented
          value={lang}
          onChange={(value) => value !== lang && toggle()}
          options={[
            { value: 'ar', label: 'العربية' },
            { value: 'en', label: 'English' },
          ]}
        />
      </div>
    </div>
  )
}
