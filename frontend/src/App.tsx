import './App.css'
import { useState } from 'react'
import { StravaConnect } from './components/StravaConnect'
import { Activities } from './components/Activities'
import { Automations } from './components/Automations'
import { NavTabs } from './components/NavTabs'
import { ApplyAutomations } from './components/ApplyAutomations'
import { Counters } from './components/Counters'

export default function App() {
  const [tab, setTab] = useState<'activities' | 'automations' | 'apply' | 'counters'>('activities')

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <h1 style={{ marginTop: 0 }}>Strava Automator</h1>
      <StravaConnect />
      <NavTabs
        tabs={[
          { key: 'activities', label: 'Activities' },
          { key: 'automations', label: 'Automations' },
          { key: 'apply', label: 'Apply Automations' },
          { key: 'counters', label: 'Counters' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as any)}
      />
      {tab === 'activities'
        ? <Activities />
        : tab === 'automations'
        ? <Automations />
        : tab === 'apply'
        ? <ApplyAutomations />
        : <Counters />}
    </div>
  )
}
