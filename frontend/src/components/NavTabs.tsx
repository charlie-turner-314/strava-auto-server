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
    <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              padding: '8px 12px',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--fg)' : '2px solid transparent',
              background: 'transparent',
              cursor: 'pointer',
              fontWeight: isActive ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export default NavTabs
