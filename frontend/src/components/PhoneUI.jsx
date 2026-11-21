import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { App, Dropdown, Input, Popconfirm } from 'antd'
import { CheckOutlined, CloseOutlined, EllipsisOutlined, LeftOutlined, LoadingOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons'
import { useLang } from '../i18n'

/*
 * Building blocks of the phone pages (styles in phone.css).
 *
 * An action is { key, icon, label, onClick, primary?, danger?, disabled?, loading?, hidden?,
 * confirm?: { title, description?, okText? }, menu?: [actions] }: one list drives the tiles, the
 * "more" menu and the selection bar alike (a tile with `menu` opens those choices).
 */

const shown = (actions) => actions.filter((a) => a && !a.hidden)

/** Runs an action from a menu, asking first when it needs confirming (a sheet on phones). */
function useRun() {
  const { modal } = App.useApp()
  const { t } = useLang()
  return (action) => {
    if (!action.confirm) return action.onClick()
    modal.confirm({
      title: action.confirm.title,
      content: action.confirm.description,
      okText: action.confirm.okText || t('delete'),
      cancelText: t('cancel'),
      okButtonProps: { danger: action.danger },
      onOk: action.onClick,
    })
  }
}

const menuItems = (actions, run) =>
  shown(actions).map((a) => ({ key: a.key, icon: a.icon, label: a.label, danger: a.danger, disabled: a.disabled, onClick: () => run(a) }))

/** A chevron pointing ahead (into a page), whatever the writing direction. */
export function Chevron() {
  const { dir } = useLang()
  return <span className="phone-chevron">{dir === 'rtl' ? <LeftOutlined /> : <RightOutlined />}</span>
}

/** The top of a phone page: title (and icon), a line under it, and a "more" menu for the page's other actions. */
export function PhoneHeader({ icon, title, subtitle, kicker, more, children }) {
  return (
    <div className="phone-head">
      <div className="phone-head-row">
        <div className="phone-head-text">
          {kicker && <div className="phone-kicker">{kicker}</div>}
          <h1 className="phone-title">
            {icon && <span className="phone-title-icon">{icon}</span>}
            <span className="phone-title-text">{title}</span>
          </h1>
          {subtitle && <div className="phone-subtitle">{subtitle}</div>}
        </div>
        {more && shown(more).length > 0 && <MoreMenu actions={more} />}
      </div>
      {children}
    </div>
  )
}

/** "⋯": the page's less used actions. */
export function MoreMenu({ actions }) {
  const { t } = useLang()
  const run = useRun()
  return (
    <Dropdown menu={{ items: menuItems(actions, run) }} trigger={['click']} placement="bottomLeft">
      <button type="button" className="phone-more" aria-label={t('more_actions')}>
        <EllipsisOutlined />
      </button>
    </Dropdown>
  )
}

/** A page's main actions as a row of tiles; past `max`, the last tile opens the rest. */
export function PhoneActions({ actions, max = 4 }) {
  const { t } = useLang()
  const run = useRun()
  const list = shown(actions)
  const tiles = list.length > max ? list.slice(0, max - 1) : list
  const rest = list.length > max ? list.slice(max - 1) : []

  return (
    <div className="phone-actions" style={{ '--n': tiles.length + (rest.length ? 1 : 0) }}>
      {tiles.map((a) => (
        <ActionTile key={a.key} action={a} />
      ))}
      {rest.length > 0 && (
        <Dropdown menu={{ items: menuItems(rest, run) }} trigger={['click']} placement="bottomLeft">
          <button type="button" className="phone-action">
            <span className="phone-action-icon">
              <EllipsisOutlined />
            </span>
            <span className="phone-action-label">{t('more_actions')}</span>
          </button>
        </Dropdown>
      )}
    </div>
  )
}

function ActionTile({ action }) {
  const { t } = useLang()
  const run = useRun()
  const tile = (
    <button
      type="button"
      className={`phone-action${action.primary ? ' is-primary' : ''}${action.danger ? ' is-danger' : ''}`}
      disabled={action.disabled || action.loading}
      onClick={action.confirm || action.menu ? undefined : action.onClick}
    >
      <span className="phone-action-icon">{action.loading ? <LoadingOutlined /> : action.icon}</span>
      <span className="phone-action-label">{action.label}</span>
    </button>
  )
  // A tile can open a few choices of its own
  if (action.menu)
    return (
      <Dropdown menu={{ items: menuItems(action.menu, run) }} trigger={['click']} placement="bottom">
        {tile}
      </Dropdown>
    )
  if (!action.confirm) return tile
  return (
    <Popconfirm
      title={action.confirm.title}
      description={action.confirm.description}
      okText={action.confirm.okText || t('delete')}
      cancelText={t('cancel')}
      okButtonProps={{ danger: action.danger }}
      onConfirm={action.onClick}
    >
      {tile}
    </Popconfirm>
  )
}

/**
 * The page's main action as a floating button above the tabs. It shows its label at the top of
 * the page and folds to its icon once the list is scrolled.
 */
export function Fab({ icon, label, onClick, loading }) {
  const [folded, setFolded] = useState(false)
  useEffect(() => {
    const onScroll = () => setFolded(window.scrollY > 80)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Room at the end of the page, so the button never covers the last row
  return (
    <>
      <div className="phone-fab-space" />
      {createPortal(
        <button type="button" className={`phone-fab${folded ? ' is-folded' : ''}`} onClick={onClick} disabled={loading} aria-label={label}>
          <span className="phone-fab-icon">{loading ? <LoadingOutlined /> : icon}</span>
          <span className="phone-fab-label">{label}</span>
        </button>,
        document.body,
      )}
    </>
  )
}

/** Rows grouped on one card, like a phone's settings list. */
export function PhoneList({ children, className = '' }) {
  return <div className={`phone-list ${className}`}>{children}</div>
}

/**
 * One row: a tinted icon (or a tick while selecting), title and lines under it, and something at
 * the end. Opens `to` when tapped, or calls onClick.
 */
export function PhoneRow({ to, onClick, icon, tone = 'blue', title, subtitle, meta, end, chevron = true, selecting, selected, onSelect, className = '' }) {
  const lead = selecting ? (
    <span className={`phone-row-check${selected ? ' is-on' : ''}`} aria-hidden>
      {selected && <CheckOutlined />}
    </span>
  ) : (
    icon && <span className={`phone-row-icon tone-${tone}`}>{icon}</span>
  )
  const body = (
    <>
      {lead}
      <span className="phone-row-body">
        <span className="phone-row-title">{title}</span>
        {subtitle && <span className="phone-row-sub">{subtitle}</span>}
        {meta && <span className="phone-row-meta">{meta}</span>}
      </span>
      {end && <span className="phone-row-end">{end}</span>}
      {chevron && !selecting && <Chevron />}
    </>
  )
  const cls = `phone-row${selected ? ' is-selected' : ''} ${className}`
  if (selecting)
    return (
      <button type="button" className={cls} onClick={onSelect} aria-pressed={!!selected}>
        {body}
      </button>
    )
  if (to)
    return (
      <Link to={to} className={cls}>
        {body}
      </Link>
    )
  return (
    <button type="button" className={cls} onClick={onClick}>
      {body}
    </button>
  )
}

/** While choosing rows: how many, and what to do with them, above the tabs. */
export function SelectionBar({ count, actions, onClose }) {
  const { t } = useLang()
  const run = useRun()
  return (
    <>
      <div className="phone-bar-space" />
      {createPortal(
        <div className="phone-selection" role="toolbar">
          <button type="button" className="phone-selection-close" onClick={onClose} aria-label={t('cancel')}>
            <CloseOutlined />
          </button>
          <span className="phone-selection-count">{t('selected_n', { n: count })}</span>
          <div className="phone-selection-actions">
            {shown(actions).map((a) => (
              <button key={a.key} type="button" className={`phone-selection-btn${a.danger ? ' is-danger' : ''}`} disabled={a.disabled || !count || a.loading} onClick={() => run(a)} aria-label={a.label}>
                {a.loading ? <LoadingOutlined /> : a.icon}
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/** Grey rows while a list loads. */
export function PhoneSkeleton({ rows = 6 }) {
  return (
    <PhoneList>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="phone-skeleton" style={{ opacity: 1 - i * 0.12 }}>
          <span />
          <span>
            <i />
            <i />
          </span>
        </div>
      ))}
    </PhoneList>
  )
}

/** A short row of choices that scrolls sideways (filters). */
export function ChipRow({ children }) {
  return <div className="phone-chips">{children}</div>
}

/** A search box that searches as you type (after a short pause), and at once on the keyboard's search key. */
export function PhoneSearch({ value, onChange, onSearch, placeholder }) {
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  // Without onSearch, the page searches as the text changes
  const later = (text) => {
    clearTimeout(timer.current)
    if (onSearch) timer.current = setTimeout(() => onSearch(text.trim()), 450)
  }
  return (
    <Input
      allowClear
      className="phone-search"
      prefix={<SearchOutlined />}
      enterKeyHint="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value)
        later(e.target.value)
      }}
      onPressEnter={(e) => {
        clearTimeout(timer.current)
        onSearch?.(e.target.value.trim())
        e.target.blur()
      }}
    />
  )
}
