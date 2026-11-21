/* Icons drawn for the phone layout: the logo, and each bottom tab in two states (outline, and filled when it is the open tab). */

const svg = { viewBox: '0 0 24 24', width: '1em', height: '1em', 'aria-hidden': true, focusable: false }
const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
/** Lines drawn over a filled shape */
const cut = { fill: 'none', stroke: '#fff', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }

/** The app's mark: a blue tile with a QR-like pattern (as the browser tab icon). */
export function AppLogo({ size = 30 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden focusable={false} className="app-logo">
      <defs>
        <linearGradient id="app-logo-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1e40af" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#app-logo-fill)" />
      <path d="M0 9a9 9 0 0 1 9-9h14a9 9 0 0 1 9 9v3C22 9 10 9 0 15z" fill="#fff" opacity=".12" />
      <g fill="#fff">
        <rect x="7" y="7" width="7.5" height="7.5" rx="2" />
        <rect x="17.5" y="7" width="7.5" height="7.5" rx="2" />
        <rect x="7" y="17.5" width="7.5" height="7.5" rx="2" />
        <rect x="17.5" y="17.5" width="3" height="3" rx=".8" />
        <rect x="22" y="22" width="3" height="3" rx=".8" />
        <rect x="17.5" y="22" width="3" height="3" rx=".8" opacity=".7" />
        <rect x="22" y="17.5" width="3" height="3" rx=".8" opacity=".7" />
      </g>
      <g fill="#1d4ed8">
        <rect x="9.5" y="9.5" width="2.5" height="2.5" rx=".6" />
        <rect x="20" y="9.5" width="2.5" height="2.5" rx=".6" />
        <rect x="9.5" y="20" width="2.5" height="2.5" rx=".6" />
      </g>
    </svg>
  )
}

export function EquipmentIcon({ active }) {
  const squares = [
    [3.25, 3.25],
    [13.25, 3.25],
    [3.25, 13.25],
    [13.25, 13.25],
  ]
  return (
    <svg {...svg}>
      {squares.map(([x, y]) => (
        <rect key={`${x}${y}`} x={x} y={y} width="7.5" height="7.5" rx="2.2" {...(active ? { fill: 'currentColor' } : line)} />
      ))}
    </svg>
  )
}

export function BoxIcon({ active }) {
  const outer = 'M12 2.75 20.25 7.25v9.5L12 21.25 3.75 16.75v-9.5z'
  const inner = 'M3.9 7.35 12 11.75l8.1-4.4M12 11.75v9.3M7.9 5 16.1 9.5'
  return active ? (
    <svg {...svg}>
      <path d={outer} fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d={inner} {...cut} />
    </svg>
  ) : (
    <svg {...svg}>
      <path d={outer} {...line} />
      <path d={inner} {...line} />
    </svg>
  )
}

export function ScanIcon({ active }) {
  const corners = 'M3.75 8.25v-2a2.5 2.5 0 0 1 2.5-2.5h2M15.75 3.75h2a2.5 2.5 0 0 1 2.5 2.5v2M20.25 15.75v2a2.5 2.5 0 0 1-2.5 2.5h-2M8.25 20.25h-2a2.5 2.5 0 0 1-2.5-2.5v-2'
  return active ? (
    <svg {...svg}>
      <path d={corners} {...line} strokeWidth="2.1" />
      <rect x="7" y="7" width="10" height="10" rx="2.4" fill="currentColor" />
      <path d="M9.25 12h5.5" {...cut} />
    </svg>
  ) : (
    <svg {...svg}>
      <path d={corners} {...line} />
      <path d="M7.25 12h9.5" {...line} />
    </svg>
  )
}

export function DocsIcon({ active }) {
  const page = 'M14.25 3.75h-6.5a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h8.5a2 2 0 0 0 2-2V8.25z'
  const fold = 'M14.25 3.75v4.5h4.5'
  const bars = 'M9.25 12.25v4.5M11.5 12.25v4.5M13.5 12.25v4.5M15.25 12.25v4.5'
  return active ? (
    <svg {...svg}>
      <path d={page} fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d={`${fold}${bars}`} {...cut} />
    </svg>
  ) : (
    <svg {...svg}>
      <path d={`${page}${fold}`} {...line} />
      <path d={bars} {...line} strokeWidth="1.6" />
    </svg>
  )
}

/** Nine dots (the sections menu), turning into a cross while it is open. */
export function MenuIcon({ open }) {
  const dots = [5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => [x, y]))
  return (
    <span className={`menu-icon${open ? ' is-open' : ''}`}>
      <svg {...svg} className="menu-icon-dots">
        {dots.map(([x, y]) => (
          <circle key={`${x}${y}`} cx={x} cy={y} r="2.1" fill="currentColor" />
        ))}
      </svg>
      <svg {...svg} className="menu-icon-close">
        <path d="M6 6l12 12M18 6 6 18" {...line} strokeWidth="2.2" />
      </svg>
    </span>
  )
}

/** A chevron pointing back (mirrored for right-to-left in the stylesheet). */
export function BackIcon() {
  return (
    <svg {...svg}>
      <path d="M14.5 5.5 8 12l6.5 6.5" {...line} strokeWidth="2.2" />
    </svg>
  )
}
