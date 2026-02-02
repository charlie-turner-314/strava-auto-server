type TabKey = string

export function NavTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: TabKey; label: string }[]
  active: TabKey
  onChange: (key: TabKey) => void
}) {
  return (
    <div className="nav-tabs">
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={`nav-tab${isActive ? ' active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export default NavTabs
